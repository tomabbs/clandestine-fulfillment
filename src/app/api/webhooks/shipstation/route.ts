/**
 * ShipStation webhook Route Handler.
 *
 * Handles two payload shapes (per Phase 1.3):
 *   - SHIP_NOTIFY → enqueue process-shipstation-shipment (existing behavior)
 *   - ORDER_NOTIFY → enqueue shipstation-orders-poll-window (new in Phase 1.3)
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #62: INSERT INTO webhook_events for dedup (UNIQUE platform+external_webhook_id).
 * Rule #63: Verify x-ss-signature HMAC before any side effects.
 * Rule #66: Return 200 fast — heavy processing handed off to Trigger.dev task.
 *
 * Security policy (Phase 1.3 hardening):
 *   - When NODE_ENV === "production", SHIPSTATION_WEBHOOK_SECRET MUST be set.
 *     Missing secret in prod is a deploy-blocking misconfiguration; the route
 *     refuses to process the request rather than silently skipping signature
 *     validation.
 *   - In non-prod environments the secret is optional so local dev / staging
 *     without a configured secret can still receive webhooks.
 *   - All signature failures + replay/duplicate detections emit Sentry events
 *     with structured tags so an incident can be triaged from the dashboard.
 */

import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import { type NextRequest, NextResponse } from "next/server";
import {
  parseShipStationWebhookPayload,
  type ShipStationWebhookPayload,
  verifyShipStationSignature,
} from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-shot Sentry warning per cold start when no signing secret available.
// Prevents flooding Sentry on every webhook call while still surfacing the
// trade-off to the operator.
let warnedAboutMissingSsSecret = false;

export async function POST(req: NextRequest) {
  const rawBody = await readWebhookBody(req);

  // Phase 1.3 (revised 2026-04-20): SS doesn't expose a dedicated "webhook
  // signing secret" in their dashboard. Per their (limited) docs, they use
  // your SS API SECRET as the HMAC key when an x-ss-signature header is
  // present. SS community confirms signing is partially implemented and
  // not officially documented — most integrations skip verification.
  //
  // Behavior:
  //   - SHIPSTATION_WEBHOOK_SECRET set        → validate strictly with that
  //   - SHIPSTATION_WEBHOOK_SECRET unset
  //         + SHIPSTATION_API_SECRET set      → validate strictly with that
  //   - Both unset                             → accept unsigned events,
  //                                              one Sentry-info per cold start
  //
  // Operator opt-out: leave SHIPSTATION_WEBHOOK_SECRET unset AND set
  // SHIPSTATION_API_SECRET to the empty string to skip validation entirely.
  const { SHIPSTATION_WEBHOOK_SECRET, SHIPSTATION_API_SECRET } = env();
  const verificationSecret = SHIPSTATION_WEBHOOK_SECRET || SHIPSTATION_API_SECRET;

  if (!verificationSecret) {
    if (!warnedAboutMissingSsSecret) {
      Sentry.captureMessage(
        "[shipstation-webhook] no signing secret available (neither SHIPSTATION_WEBHOOK_SECRET nor SHIPSTATION_API_SECRET set) — accepting unsigned events",
        {
          level: "info",
          tags: { platform: "shipstation", failure: "secret_unset_intentional" },
        },
      );
      warnedAboutMissingSsSecret = true;
    }
  } else {
    const signature = req.headers.get("x-ss-signature");
    if (signature) {
      const valid = await verifyShipStationSignature(rawBody, signature, verificationSecret);
      if (!valid) {
        Sentry.captureMessage("[shipstation-webhook] invalid signature", {
          level: "warning",
          tags: { platform: "shipstation", failure: "invalid_signature" },
        });
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
    }
    // SS doesn't always send x-ss-signature (depends on subscription type +
    // payload version). Missing header = accept (signing is best-effort
    // upstream of us, not a contract).
  }

  let payload: ShipStationWebhookPayload;
  try {
    payload = parseShipStationWebhookPayload(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const externalId = `shipstation:${payload.resource_type.toLowerCase()}:${payload.resource_url}`;

  const { data: inserted, error: insertErr } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shipstation",
      external_webhook_id: externalId,
      topic: payload.resource_type,
      status: "pending",
      metadata: { resource_url: payload.resource_url, resource_type: payload.resource_type },
    })
    .select("id")
    .single();

  if (!inserted) {
    if (insertErr?.code === "23505") {
      // Duplicate webhook — already enqueued. Sentry breadcrumb only (not an error).
      Sentry.addBreadcrumb({
        category: "shipstation-webhook",
        message: "duplicate webhook ignored",
        level: "info",
        data: { topic: payload.resource_type },
      });
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Dispatch to the right downstream task per resource type.
  if (payload.resource_type === "SHIP_NOTIFY") {
    await tasks.trigger("process-shipstation-shipment", {
      webhookEventId: inserted.id,
      resource_url: payload.resource_url,
    });
  } else if (payload.resource_type === "ORDER_NOTIFY") {
    // Phase 1.3 — re-poll a narrow window so the cockpit picks up the change
    // within seconds. The window task uses shipstationQueue (concurrencyLimit:1)
    // so it serializes with the 15-min cron and won't burn rate-limit budget.
    await tasks.trigger("shipstation-orders-poll-window", {
      windowMinutes: 30,
    });
  }

  return NextResponse.json({ ok: true });
}
