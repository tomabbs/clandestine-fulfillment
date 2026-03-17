// Rule #36: req.text() for raw body — never req.json()
// Rule #62: INSERT INTO webhook_events for dedup
// Rule #63: Verify X-SS-Signature before side effects
// Rule #66: Return 200 within 500ms — heavy processing via Trigger.dev

import { tasks } from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import { parseShipNotifyPayload, verifyShipStationSignature } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { readWebhookBody } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

export async function POST(req: Request) {
  const rawBody = await readWebhookBody(req);

  // Rule #63: Verify signature before any side effects
  const signature = req.headers.get("X-SS-Signature");
  const { SHIPSTATION_WEBHOOK_SECRET } = env();
  const valid = await verifyShipStationSignature(rawBody, signature, SHIPSTATION_WEBHOOK_SECRET);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse and validate payload
  let payload: ReturnType<typeof parseShipNotifyPayload>;
  try {
    payload = parseShipNotifyPayload(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Rule #62: Dedup via webhook_events INSERT ON CONFLICT
  const supabase = createServiceRoleClient();
  const externalId = `shipstation:${payload.resource_url}`;
  const { data: inserted } = await supabase
    .from("webhook_events")
    .insert({
      platform: "shipstation",
      external_webhook_id: externalId,
      topic: payload.resource_type,
      status: "pending",
      metadata: { resource_url: payload.resource_url, raw_body: rawBody },
    })
    .select("id")
    .single();

  if (!inserted) {
    // Already processed — return 200 to stop retries
    return NextResponse.json({ ok: true, deduplicated: true });
  }

  // Rule #66: Trigger async processing — no heavy work in route handler
  await tasks.trigger("shipment-ingest", { webhookEventId: inserted.id });

  return NextResponse.json({ ok: true });
}
