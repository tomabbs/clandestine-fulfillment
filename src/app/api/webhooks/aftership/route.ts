/**
 * AfterShip webhook Route Handler.
 *
 * Rule #36: req.text() for raw body.
 * Rule #63: Verify aftership-hmac-sha256 header.
 * Rule #62: INSERT INTO webhook_events for dedup.
 * Rule #66: Return 200 fast — processing inline since tracking events are lightweight.
 */

import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readWebhookBody, verifyHmacSignature } from "@/lib/server/webhook-body";

export async function POST(request: NextRequest) {
  const rawBody = await readWebhookBody(request);

  // Step 1: Verify AfterShip HMAC signature (Rule #63)
  const webhookSecret = process.env.AFTERSHIP_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = request.headers.get("aftership-hmac-sha256");
    if (!signature) {
      return NextResponse.json({ error: "missing signature" }, { status: 401 });
    }
    const valid = await verifyHmacSignature(rawBody, webhookSecret, signature);
    if (!valid) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  const payload = JSON.parse(rawBody);
  const tracking = payload?.msg;
  if (!tracking) {
    return NextResponse.json({ ok: true, status: "no_tracking_data" });
  }

  const trackingNumber = tracking.tracking_number as string;
  const externalId = `aftership:${trackingNumber}:${tracking.id ?? Date.now()}`;

  // Step 2: Dedup via webhook_events (Rule #62)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "aftership",
      external_webhook_id: externalId,
      topic: "tracking_update",
      metadata: { tracking_number: trackingNumber },
    })
    .select("id")
    .single();

  if (dedupError) {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Step 3+: Process — wrapped in try/catch to always return 200 (prevent infinite retries)
  try {
    const { data: shipment } = await supabase
      .from("warehouse_shipments")
      .select("id, workspace_id")
      .eq("tracking_number", trackingNumber)
      .single();

    if (!shipment) {
      return NextResponse.json({ ok: true, status: "no_matching_shipment" });
    }

    // Step 4: Process checkpoints → tracking events
    const checkpoints = (tracking.checkpoints as Array<Record<string, unknown>>) ?? [];
    const latestCheckpoint = checkpoints[checkpoints.length - 1];

    if (latestCheckpoint) {
      // Insert latest checkpoint as tracking event
      await supabase.from("warehouse_tracking_events").insert({
        shipment_id: shipment.id,
        workspace_id: shipment.workspace_id,
        status: (latestCheckpoint.tag as string) ?? "unknown",
        description: (latestCheckpoint.message as string) ?? null,
        location: buildLocation(latestCheckpoint),
        event_time: (latestCheckpoint.checkpoint_time as string) ?? null,
        source: "aftership",
      });
    }

    // Step 5: Update shipment status if delivered
    const tag = (tracking.tag as string) ?? "";
    const statusMap: Record<string, string> = {
      Delivered: "delivered",
      InTransit: "in_transit",
      OutForDelivery: "out_for_delivery",
      Exception: "exception",
      AttemptFail: "delivery_failed",
      Expired: "expired",
    };

    const mappedStatus = statusMap[tag];
    if (mappedStatus) {
      const updateData: Record<string, unknown> = {
        status: mappedStatus,
        updated_at: new Date().toISOString(),
      };

      if (tag === "Delivered" && latestCheckpoint?.checkpoint_time) {
        updateData.delivery_date = (latestCheckpoint.checkpoint_time as string).split("T")[0];
      }

      await supabase.from("warehouse_shipments").update(updateData).eq("id", shipment.id);
    }
  } catch (error) {
    console.error("[webhook:aftership] Processing error:", error);
  }

  return NextResponse.json({ ok: true });
}

function buildLocation(checkpoint: Record<string, unknown>): string | null {
  const parts = [checkpoint.city, checkpoint.state, checkpoint.country_name].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : ((checkpoint.location as string) ?? null);
}
