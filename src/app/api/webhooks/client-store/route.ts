/**
 * Client store webhook Route Handler.
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #23: Per-platform HMAC signature verification.
 * Rule #62: INSERT INTO webhook_events for dedup.
 * Rule #66: Return 200 fast — heavy processing in Trigger task.
 *
 * HRD-17.1 (ship-blocker bugfix, 2026-04-22):
 *   Previously the row was inserted into webhook_events BEFORE tasks.trigger()
 *   ran. If the trigger call failed (network blip, Trigger.dev outage, cold
 *   start timeout), the row stayed dedup-ed forever and the webhook was
 *   silently lost on Shopify retry — the second delivery hits the dedup
 *   constraint and returns "duplicate".
 *
 *   New flow:
 *     1. Insert webhook_events with status='received' (default).
 *     2. Try tasks.trigger() with a STABLE idempotency key (HRD-29 global scope)
 *        so the recovery sweeper can safely retry without spawning duplicate
 *        runs.
 *     3a. On success: update status='enqueued', return 200.
 *     3b. On failure: update status='enqueue_failed', return 503 so Shopify /
 *         WooCommerce / Squarespace retry. The row is still in the DB so the
 *         recovery sweeper (`webhook-events-recovery-sweep`, every 5 min) will
 *         retry the enqueue independently — even if the platform stops
 *         retrying. The idempotency key ensures we never double-process.
 */

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  checkWebhookFreshness,
  readWebhookBody,
  sanitizeWebhookPayload,
  verifyHmacSignature,
} from "@/lib/server/webhook-body";

// F-2: Webhook routes MUST run on the Node.js runtime so node:crypto + the
// Supabase service-role key are available; `dynamic = 'force-dynamic'`
// disables Next's full-route caching (a cached webhook body would corrupt
// HMAC verification + dedup). Both exports are enforced by
// scripts/check-webhook-runtime.sh in CI.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await readWebhookBody(request);

  const connectionId = request.nextUrl.searchParams.get("connection_id");
  const _platform = request.nextUrl.searchParams.get("platform") ?? "unknown";

  if (!connectionId) {
    return NextResponse.json({ error: "missing connection_id" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: connection } = await supabase
    .from("client_store_connections")
    .select("id, workspace_id, platform, webhook_secret")
    .eq("id", connectionId)
    .single();

  if (!connection) {
    return NextResponse.json({ error: "connection not found" }, { status: 404 });
  }

  if (connection.webhook_secret) {
    let signature: string | null = null;

    if (connection.platform === "shopify") {
      signature = request.headers.get("X-Shopify-Hmac-SHA256");
      if (signature) {
        const valid = await verifyHmacSignature(rawBody, connection.webhook_secret, signature);
        if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    } else if (connection.platform === "woocommerce") {
      signature = request.headers.get("X-WC-Webhook-Signature");
      if (signature) {
        const valid = await verifyHmacSignature(rawBody, connection.webhook_secret, signature);
        if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    } else if (connection.platform === "squarespace") {
      // Squarespace uses "Squarespace-Signature" header.
      // IMPORTANT: the webhook secret is hex-encoded — must decode to bytes before HMAC.
      // Using verifyHmacSignature (UTF-8 key) would produce wrong results for Squarespace.
      signature = request.headers.get("Squarespace-Signature");
      if (signature) {
        const secretBytes = Buffer.from(connection.webhook_secret, "hex");
        const expectedSig = crypto.createHmac("sha256", secretBytes).update(rawBody).digest("hex");
        const valid = crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature));
        if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    }
  }

  // HRD-24: per-platform absolute age ceiling. NOT a 5-min reject (that
  // would discard Shopify's legitimate 48h retry window). Sanity-check
  // upper bound only (72h for Shopify/Woo/Squarespace). Fail-OPEN when no
  // timestamp can be extracted — HRD-01 monotonic guard handles ordering
  // downstream regardless. Returns 401 on stale/future-stamped deliveries
  // BEFORE the dedup insert so suspect rows don't pollute webhook_events.
  let parsedPayload: Record<string, unknown> | null = null;
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    parsedPayload = null;
  }
  const triggeredAtHeader = request.headers.get("X-Shopify-Triggered-At");
  const freshness = checkWebhookFreshness(connection.platform, parsedPayload, {
    triggeredAt: triggeredAtHeader,
  });
  if (!freshness.ok) {
    return NextResponse.json(
      {
        error: "stale_webhook",
        reason: freshness.reason,
        age_ms: freshness.ageMs,
        ceiling_ms: freshness.ceilingMs,
      },
      { status: 401 },
    );
  }

  // HRD-22: prefer `X-Shopify-Event-Id` for dedup (per-event scope — same
  // value on every retry of the same business event). `X-Shopify-Webhook-Id`
  // is per-delivery (changes on every retry of the same event) and would
  // permit duplicate downstream processing under retry. Fallback chain
  // preserves dedup for older deliveries already in the queue and for
  // platforms that don't emit Event-Id (Woo, Squarespace).
  // Ref: https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates
  const externalWebhookId =
    request.headers.get("X-Shopify-Event-Id") ??
    request.headers.get("X-Shopify-Webhook-Id") ??
    request.headers.get("X-WC-Webhook-ID") ??
    `${connectionId}:${Date.now()}`;

  // HRD-01: stash the platform-emitted timestamp into webhook_events.metadata
  // so the Trigger task's monotonic guard has it available without a second
  // header round-trip. Shopify is the only platform that sends a delivery
  // header (X-Shopify-Triggered-At); Woo + Squarespace rely on payload
  // `updated_at`/`date_modified`/`modifiedOn`, which the extractor handles.
  const { data: insertedEvent, error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      workspace_id: connection.workspace_id,
      platform: connection.platform,
      external_webhook_id: externalWebhookId,
      topic: request.headers.get("X-Shopify-Topic") ?? request.headers.get("X-WC-Webhook-Topic"),
      metadata: {
        connection_id: connectionId,
        // HRD-30: strip PII (email, name, address, phone, IP, …) before
        // persistence. The unsanitized `parsedPayload` is still used by the
        // Trigger task downstream — sanitization is purely a storage
        // posture for `webhook_events.metadata`.
        payload: sanitizeWebhookPayload(parsedPayload),
        ...(triggeredAtHeader ? { triggered_at: triggeredAtHeader } : {}),
      },
    })
    .select("id")
    .single();

  if (dedupError) {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // HRD-17.1: enqueue happens AFTER the row exists, in a try/catch. The
  // recovery sweeper (webhook-events-recovery-sweep) re-fires anything left
  // in 'received' or 'enqueue_failed' status >2 min old, so a transient
  // Trigger.dev outage no longer drops webhooks on the floor.
  if (insertedEvent) {
    try {
      // HRD-29: stable, GLOBAL-scope idempotency key so route-handler dispatch
      // and sweeper dispatch can never spawn two runs for the same row.
      const key = await idempotencyKeys.create(`process-client-store-webhook:${insertedEvent.id}`, {
        scope: "global",
      });
      await tasks.trigger(
        "process-client-store-webhook",
        { webhookEventId: insertedEvent.id },
        { idempotencyKey: key },
      );

      await supabase
        .from("webhook_events")
        .update({ status: "enqueued" })
        .eq("id", insertedEvent.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      await supabase
        .from("webhook_events")
        .update({
          status: "enqueue_failed",
          metadata: {
            connection_id: connectionId,
            // HRD-30: same PII strip applies to the failure path.
            payload: sanitizeWebhookPayload(parsedPayload),
            enqueue_error: reason,
            enqueue_failed_at: new Date().toISOString(),
          },
        })
        .eq("id", insertedEvent.id);

      return NextResponse.json(
        { ok: false, status: "enqueue_failed", will_retry: true },
        { status: 503 },
      );
    }
  }

  return NextResponse.json({ ok: true });
}
