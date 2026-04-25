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
// in `easypost_tracker_id` (Slice 3 first-class column) so subsequent runs
// short-circuit. The `label_data.easypost_tracker_id` write is preserved
// during the backfill window so older readers don't regress.
//
// Slice 3: tracker metadata is promoted from label_data JSONB to first-
// class columns (easypost_tracker_id, easypost_tracker_public_url,
// easypost_tracker_status). The status flip uses
// updateShipmentTrackingStatusSafe() so the v3 sticky-terminal state
// machine is enforced even on the very first registration call.

import { logger, task } from "@trigger.dev/sdk";
import { createTracker } from "@/lib/clients/easypost-client";
import { updateShipmentTrackingStatusSafe } from "@/lib/server/notification-status";
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
      .select(
        `id, workspace_id, tracking_number, carrier, label_source, label_data,
         easypost_tracker_id`,
      )
      .eq("id", payload.shipment_id)
      .single();

    if (!shipment) {
      throw new Error(`Shipment ${payload.shipment_id} not found`);
    }
    if (!shipment.tracking_number) {
      return { registered: false, skipped: true, reason: "no_tracking_number" };
    }

    // Slice 3 — prefer the first-class column; fall back to label_data.easypost_tracker_id
    // for shipments registered before the Slice 3 backfill. The label_data
    // copy continues to be written below so older readers don't regress.
    const labelData = (shipment.label_data ?? {}) as Record<string, unknown>;
    const existingTrackerId =
      (typeof shipment.easypost_tracker_id === "string"
        ? (shipment.easypost_tracker_id as string)
        : null) ??
      (typeof labelData.easypost_tracker_id === "string"
        ? (labelData.easypost_tracker_id as string)
        : null);
    if (existingTrackerId) {
      // Idempotent short-circuit. Already registered.
      return { registered: true, trackerId: existingTrackerId, reason: "already_registered" };
    }

    try {
      const tracker = await createTracker({
        trackingCode: shipment.tracking_number as string,
        carrier: (shipment.carrier as string | null) ?? undefined,
      });

      // Slice 3 — promote the tracker metadata to first-class columns.
      // We deliberately split the writes so that the SAFE RPC owns the
      // status field (state machine + sticky terminals) while the plain
      // update covers the side-fields (tracker id, public URL). The
      // label_data copy is preserved for the backfill window only.
      await supabase
        .from("warehouse_shipments")
        .update({
          easypost_tracker_id: tracker.id,
          easypost_tracker_public_url: tracker.public_url ?? null,
          label_data: {
            ...labelData,
            easypost_tracker_id: tracker.id,
            easypost_tracker_status: tracker.status,
            easypost_public_url: tracker.public_url,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", payload.shipment_id);

      // Slice 3 — flip the tracker status through the state machine. Even
      // on the very first registration call we want the sticky-terminal
      // guard active: if EP comes back with `delivered` immediately (very
      // common for re-registered trackers within the 3-month idempotency
      // window) we want that to land as the canonical terminal state.
      if (tracker.status) {
        const verdict = await updateShipmentTrackingStatusSafe(supabase, {
          shipmentId: payload.shipment_id,
          newStatus: tracker.status,
          statusDetail: null,
          statusAt: null,
        });
        if (!verdict.applied && verdict.skippedReason !== "no_op_same_status") {
          logger.warn("[easypost-register-tracker] state-machine skipped initial status", {
            shipmentId: payload.shipment_id,
            trackerStatus: tracker.status,
            skippedReason: verdict.skippedReason,
          });
        }
      }

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
