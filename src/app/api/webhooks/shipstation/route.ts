/**
 * ShipStation SHIP_NOTIFY webhook Route Handler (Phase 2).
 *
 * Rule #36: req.text() for raw body — never req.json() then JSON.stringify().
 * Rule #62: INSERT INTO webhook_events for dedup (UNIQUE platform+external_webhook_id).
 * Rule #63: Verify x-ss-signature HMAC before any side effects.
 * Rule #66: Return 200 fast — heavy processing handed off to Trigger.dev task.
 *
 * SHIP_NOTIFY payload shape:
 *   { "resource_url": "https://ssapi.shipstation.com/shipments?...", "resource_type": "SHIP_NOTIFY" }
 *
 * The receiver does NOT inline shipment data — it must call back the URL
 * with the same Basic auth used elsewhere. We dedupe on resource_url.
 */

import { tasks } from "@trigger.dev/sdk";
import { type NextRequest, NextResponse } from "next/server";
import { parseShipNotifyPayload, verifyShipStationSignature } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await readWebhookBody(req);

  const { SHIPSTATION_WEBHOOK_SECRET } = env();
  if (SHIPSTATION_WEBHOOK_SECRET) {
    const signature = req.headers.get("x-ss-signature");
    if (!signature) {
      return NextResponse.json({ error: "missing signature" }, { status: 401 });
    }
    const valid = await verifyShipStationSignature(rawBody, signature, SHIPSTATION_WEBHOOK_SECRET);
    if (!valid) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  let payload: ReturnType<typeof parseShipNotifyPayload>;
  try {
    payload = parseShipNotifyPayload(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const externalId = `shipstation:ship_notify:${payload.resource_url}`;

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
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  await tasks.trigger("process-shipstation-shipment", {
    webhookEventId: inserted.id,
    resource_url: payload.resource_url,
  });

  return NextResponse.json({ ok: true });
}
