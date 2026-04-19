// Phase 4.3 — Tracking write-back to ShipStation.
//
// Reads a warehouse_shipments row, maps the EP carrier to the SS carrier_code
// via shipstation_carrier_map (Phase 4.2), then writes back to SS via:
//   1. v2 fulfillments (PRIMARY when shipstation_shipment_id is present)
//   2. v1 markasshipped (FALLBACK when v2 unavailable or v2 errors)
//
// On success: stamp shipstation_marked_shipped_at + shipstation_writeback_path
// + persist the response body in label_data.shipstation_writeback_response.
// On failure: increment shipstation_writeback_attempts, record error, surface
// in cockpit. NEVER throw — the orchestrator's try/catch is fragile.
//
// Idempotency (Phase 4.3 / J.5):
//   - Read shipstation_marked_shipped_at IS NULL BEFORE making any API call.
//   - "already fulfilled" v2 errors → success.
//   - 409 v1 already_shipped → success.
//
// See plan §4.3 + Appendix J.1 / J.1a for exact request/response shapes.

import { logger, task } from "@trigger.dev/sdk";
import { createFulfillments } from "@/lib/clients/shipstation-inventory-v2";
import { markOrderShipped } from "@/lib/clients/shipstation";
import {
  logUnmappedServiceUsedFamilyFallback,
  resolveCarrierMapping,
} from "@/lib/server/carrier-map";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

interface ShipmentRow {
  id: string;
  workspace_id: string;
  label_source: string | null;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  ship_date: string | null;
  shipstation_order_id: string | null;
  shipstation_shipment_id: string | null;
  shipstation_marked_shipped_at: string | null;
  shipstation_writeback_attempts: number | null;
  label_data: Record<string, unknown> | null;
}

interface WritebackResult {
  ok: boolean;
  path?: "v2" | "v1" | null;
  alreadyShipped?: boolean;
  error?: string;
  trackingUrl?: string | null;
}

const ALREADY_SHIPPED_PATTERNS = [
  /already.{0,20}shipped/i,
  /already.{0,20}fulfilled/i,
  /already.{0,20}fulfill/i,
];

function isAlreadyShipped(message: string | null | undefined): boolean {
  if (!message) return false;
  return ALREADY_SHIPPED_PATTERNS.some((p) => p.test(message));
}

export const shipstationMarkShippedTask = task({
  id: "shipstation-mark-shipped",
  queue: shipstationQueue,
  maxDuration: 60,
  run: async (payload: { warehouse_shipment_id: string }): Promise<WritebackResult> => {
    const supabase = createServiceRoleClient();
    const { warehouse_shipment_id } = payload;

    // ── 1. Load shipment + idempotency precheck ─────────────────────────────
    const { data: shipment, error: loadErr } = await supabase
      .from("warehouse_shipments")
      .select(
        `id, workspace_id, label_source, carrier, service, tracking_number, ship_date,
         shipstation_order_id, shipstation_shipment_id, shipstation_marked_shipped_at,
         shipstation_writeback_attempts, label_data`,
      )
      .eq("id", warehouse_shipment_id)
      .maybeSingle();

    if (loadErr || !shipment) {
      logger.warn("[shipstation-mark-shipped] shipment not found", {
        warehouse_shipment_id,
        error: loadErr?.message,
      });
      return { ok: false, error: "shipment_not_found" };
    }

    const row = shipment as ShipmentRow;

    if (row.shipstation_marked_shipped_at) {
      logger.log("[shipstation-mark-shipped] already stamped — skipping", {
        warehouse_shipment_id,
        stamped_at: row.shipstation_marked_shipped_at,
      });
      return { ok: true, alreadyShipped: true };
    }

    if (!row.shipstation_order_id) {
      // Not an SS-sourced shipment — orchestrator shouldn't have enqueued us.
      logger.warn("[shipstation-mark-shipped] no shipstation_order_id on shipment — refusing", {
        warehouse_shipment_id,
      });
      return { ok: false, error: "not_a_shipstation_shipment" };
    }
    if (!row.tracking_number || !row.carrier) {
      return { ok: false, error: "missing_tracking_or_carrier" };
    }

    // ── 2. Resolve EP carrier → SS carrier_code via carrier_map ─────────────
    const mapping = await resolveCarrierMapping(supabase, {
      workspaceId: row.workspace_id,
      easypostCarrier: row.carrier,
      easypostService: row.service,
    });

    if (!mapping.ok) {
      const err = `mapping_${mapping.reason}: ${mapping.details ?? ""}`;
      logger.warn("[shipstation-mark-shipped] carrier mapping unresolved — surfacing to UI", {
        warehouse_shipment_id,
        reason: mapping.reason,
      });
      await stampWritebackError(supabase, row.id, row.shipstation_writeback_attempts ?? 0, err);
      return { ok: false, error: err };
    }

    // Family-wildcard telemetry — log when a previously-unseen specific
    // service used the family fallback so ops can decide whether to add a
    // specific row.
    if (mapping.mapping.matched_via === "family" && row.service) {
      await logUnmappedServiceUsedFamilyFallback(supabase, {
        workspaceId: row.workspace_id,
        easypostCarrier: row.carrier,
        easypostService: row.service,
        fallbackShipstationCarrierCode: mapping.mapping.shipstation_carrier_code,
        warehouseShipmentId: row.id,
      });
    }

    const shipDate = row.ship_date ?? new Date().toISOString().slice(0, 10);
    const idempotencyKey = `ss-writeback:${row.workspace_id}:${row.id}:${row.tracking_number}`;

    // ── 3. v2 PRIMARY when shipment_id present ──────────────────────────────
    if (row.shipstation_shipment_id) {
      try {
        const r = await createFulfillments({
          fulfillments: [
            {
              shipment_id: row.shipstation_shipment_id,
              tracking_number: row.tracking_number,
              carrier_code: mapping.mapping.shipstation_carrier_code,
              ship_date: shipDate,
              notify_customer: true,
              notify_order_source: true,
            },
          ],
          idempotencyKey,
        });

        const item = r.fulfillments[0];
        const itemErr = item?.error_message;

        if (!itemErr) {
          await stampWritebackSuccess(supabase, row.id, "v2", {
            response: r,
            tracking_url: item?.tracking_url ?? null,
          });
          return { ok: true, path: "v2", trackingUrl: item?.tracking_url ?? null };
        }

        if (isAlreadyShipped(itemErr)) {
          await stampWritebackSuccess(supabase, row.id, "v2", {
            response: r,
            tracking_url: item?.tracking_url ?? null,
            already_shipped: true,
          });
          return { ok: true, path: "v2", alreadyShipped: true };
        }

        // v2 returned a per-item error that's NOT already-shipped — fall through to v1.
        logger.warn("[shipstation-mark-shipped] v2 partial-fail; falling back to v1", {
          warehouse_shipment_id,
          v2_error: itemErr,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("[shipstation-mark-shipped] v2 threw; falling back to v1", {
          warehouse_shipment_id,
          v2_error: msg,
        });
      }
    }

    // ── 4. v1 FALLBACK ──────────────────────────────────────────────────────
    // Need the SS bigint orderId — load from shipstation_orders.
    const { data: ssOrder } = await supabase
      .from("shipstation_orders")
      .select("shipstation_order_id")
      .eq("id", row.shipstation_order_id)
      .maybeSingle();

    if (!ssOrder?.shipstation_order_id) {
      const err = "v1_fallback_no_order_id";
      await stampWritebackError(supabase, row.id, row.shipstation_writeback_attempts ?? 0, err);
      return { ok: false, error: err };
    }

    try {
      const v1Resp = await markOrderShipped({
        orderId: Number(ssOrder.shipstation_order_id),
        carrierCode: mapping.mapping.shipstation_carrier_code,
        trackingNumber: row.tracking_number,
        shipDate,
        notifyCustomer: true,
        notifySalesChannel: true,
        idempotencyKey,
      });
      await stampWritebackSuccess(supabase, row.id, "v1", {
        response: v1Resp,
        tracking_url: null,
      });
      return { ok: true, path: "v1" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (isAlreadyShipped(msg) || msg.includes(" 409")) {
        await stampWritebackSuccess(supabase, row.id, "v1", {
          response: { error: msg },
          tracking_url: null,
          already_shipped: true,
        });
        return { ok: true, path: "v1", alreadyShipped: true };
      }

      await stampWritebackError(
        supabase,
        row.id,
        row.shipstation_writeback_attempts ?? 0,
        `v1_fallback_failed: ${msg}`,
      );
      return { ok: false, path: "v1", error: msg };
    }
  },
});

async function stampWritebackSuccess(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipmentId: string,
  path: "v2" | "v1",
  meta: { response: unknown; tracking_url: string | null; already_shipped?: boolean },
): Promise<void> {
  // Read existing label_data so we don't clobber other keys.
  const { data: row } = await supabase
    .from("warehouse_shipments")
    .select("label_data")
    .eq("id", shipmentId)
    .maybeSingle();
  const existing = (row?.label_data ?? {}) as Record<string, unknown>;
  const newLabelData = {
    ...existing,
    shipstation_writeback_response: { path, body: meta.response },
    ...(meta.tracking_url ? { shipstation_tracking_url: meta.tracking_url } : {}),
  };

  await supabase
    .from("warehouse_shipments")
    .update({
      shipstation_marked_shipped_at: new Date().toISOString(),
      shipstation_writeback_path: path,
      shipstation_writeback_error: null,
      label_data: newLabelData,
    })
    .eq("id", shipmentId);

  logger.log("[shipstation-mark-shipped] stamped success", {
    shipmentId,
    path,
    already_shipped: meta.already_shipped ?? false,
  });
}

async function stampWritebackError(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipmentId: string,
  prevAttempts: number,
  error: string,
): Promise<void> {
  await supabase
    .from("warehouse_shipments")
    .update({
      shipstation_writeback_error: error,
      shipstation_writeback_attempts: prevAttempts + 1,
    })
    .eq("id", shipmentId);
  logger.warn("[shipstation-mark-shipped] stamped error", {
    shipmentId,
    error,
    attempts: prevAttempts + 1,
  });
}

// Exported for testing.
export { isAlreadyShipped };
