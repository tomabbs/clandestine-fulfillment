// Phase 10.2 — EasyPost Tracker registration (replaces aftership-register).
//
// During the dual-mode window (Phase 10.5 prep) BOTH this task AND
// aftership-register run for every label. The parity sensor compares
// event counts per shipment over a rolling 30-day window so we can
// confirm EP coverage matches AfterShip BEFORE removing AfterShip.
//
// Rule #7: createServiceRoleClient.
// Rule #12: payload is IDs only.
//
// Idempotency: EP `Tracker.create` is idempotent on (carrier, tracking_code)
// within a 3-month window per EP docs — calling twice returns the existing
// tracker rather than creating a duplicate. We also persist the tracker id
// in label_data.easypost_tracker_id so subsequent runs short-circuit.

import { logger, task } from "@trigger.dev/sdk";
import { createTracker } from "@/lib/clients/easypost-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface Payload {
  shipment_id: string;
}

interface Result {
  registered: boolean;
  trackerId?: string;
  reason?: string;
  skipped?: boolean;
}

export const easypostRegisterTrackerTask = task({
  id: "easypost-register-tracker",
  maxDuration: 30,
  run: async (payload: Payload): Promise<Result> => {
    const supabase = createServiceRoleClient();

    const { data: shipment } = await supabase
      .from("warehouse_shipments")
      .select("id, workspace_id, tracking_number, carrier, label_source, label_data")
      .eq("id", payload.shipment_id)
      .single();

    if (!shipment) {
      throw new Error(`Shipment ${payload.shipment_id} not found`);
    }
    if (!shipment.tracking_number) {
      return { registered: false, skipped: true, reason: "no_tracking_number" };
    }

    const labelData = (shipment.label_data ?? {}) as Record<string, unknown>;
    const existingTrackerId = typeof labelData.easypost_tracker_id === "string"
      ? labelData.easypost_tracker_id
      : null;
    if (existingTrackerId) {
      // Idempotent short-circuit. Already registered.
      return { registered: true, trackerId: existingTrackerId, reason: "already_registered" };
    }

    try {
      const tracker = await createTracker({
        trackingCode: shipment.tracking_number as string,
        carrier: (shipment.carrier as string | null) ?? undefined,
      });

      await supabase
        .from("warehouse_shipments")
        .update({
          label_data: {
            ...labelData,
            easypost_tracker_id: tracker.id,
            easypost_tracker_status: tracker.status,
            easypost_public_url: tracker.public_url,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", payload.shipment_id);

      logger.log("[easypost-register-tracker] registered", {
        shipmentId: payload.shipment_id,
        trackerId: tracker.id,
        carrier: tracker.carrier,
      });
      return { registered: true, trackerId: tracker.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("[easypost-register-tracker] failed", {
        shipmentId: payload.shipment_id,
        error: msg,
      });
      // Sentry visibility is on by default for warn-level logger output.
      // We intentionally do NOT create a review queue row here — EP tracker
      // failures are non-fatal (the shipment ships either way; we just lose
      // the events feed). The Phase 10.5 parity sensor surfaces persistent
      // gaps in aggregate.
      return { registered: false, reason: msg.slice(0, 200) };
    }
  },
});
