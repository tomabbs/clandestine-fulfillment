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

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await readWebhookBody(req);

  const { SHIPSTATION_WEBHOOK_SECRET } = env();
  const isProd = process.env.NODE_ENV === "production";

  // Phase 1.3 — secret REQUIRED in production. No silent skip.
  if (isProd && !SHIPSTATION_WEBHOOK_SECRET) {
    Sentry.captureMessage(
      "[shipstation-webhook] SHIPSTATION_WEBHOOK_SECRET is unset in production",
      {
        level: "error",
        tags: { platform: "shipstation", failure: "secret_missing_in_prod" },
      },
    );
    return NextResponse.json(
      { error: "webhook secret not configured" },
      { status: 500 },
    );
  }

  if (SHIPSTATION_WEBHOOK_SECRET) {
    const signature = req.headers.get("x-ss-signature");
    if (!signature) {
      Sentry.captureMessage("[shipstation-webhook] missing x-ss-signature", {
        level: "warning",
        tags: { platform: "shipstation", failure: "missing_signature" },
      });
      return NextResponse.json({ error: "missing signature" }, { status: 401 });
    }
    const valid = await verifyShipStationSignature(rawBody, signature, SHIPSTATION_WEBHOOK_SECRET);
    if (!valid) {
      Sentry.captureMessage("[shipstation-webhook] invalid signature", {
        level: "warning",
        tags: { platform: "shipstation", failure: "invalid_signature" },
      });
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
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
