// Phase 3.2 — Post-label-purchase orchestrator.
//
// Fires after create-shipping-label commits a warehouse_shipments row. Decides
// what downstream side effects apply based on the persisted shipment shape,
// not the source-specific branch logic of create-shipping-label.
//
// Today's responsibilities (Phase 3 + Phase 4 + Phase 10):
//   - aftership-register   — always, while AfterShip is the tracking source
//                            (Phase 10.5 sunsets this and replaces with
//                            easypost-register-tracker).
//   - shipstation-mark-shipped — only when shipstation_order_id is present.
//   - mark-platform-fulfilled  — only when warehouse_orders.id is present (i.e.
//                                fulfillment source).
//   - mark-mailorder-fulfilled — only when mailorder_orders.id is present.
//
// All downstream tasks are independent and re-entrant. The orchestrator does
// NOT wait for them — it fires and forgets, returning quickly so the cockpit
// poll status moves to "label printed" without blocking on writeback.

import { logger, task, tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface PostLabelPurchasePayload {
  warehouse_shipment_id: string;
}

interface PostLabelPurchaseResult {
  ok: true;
  triggered: string[];
}

export const postLabelPurchaseTask = task({
  id: "post-label-purchase",
  maxDuration: 60,
  run: async (payload: PostLabelPurchasePayload): Promise<PostLabelPurchaseResult> => {
    const supabase = createServiceRoleClient();
    const { warehouse_shipment_id } = payload;

    const { data: shipment, error } = await supabase
      .from("warehouse_shipments")
      .select(
        `id, label_source, tracking_number, carrier, order_id, mailorder_id,
         shipstation_order_id, bandcamp_payment_id`,
      )
      .eq("id", warehouse_shipment_id)
      .maybeSingle();

    if (error || !shipment) {
      logger.warn("[post-label-purchase] shipment not found", {
        warehouse_shipment_id,
        error: error?.message,
      });
      return { ok: true, triggered: [] };
    }

    const triggered: string[] = [];

    // Phase 10.2 — DUAL-MODE tracking enrichment: register with BOTH AfterShip
    // and EasyPost Trackers. The Phase 10.5 parity sensor compares per-shipment
    // event counts over a 30-day rolling window before we sunset AfterShip.
    // Both calls are independent + non-fatal; one failing doesn't block the other.
    try {
      await tasks.trigger("aftership-register", { shipment_id: shipment.id });
      triggered.push("aftership-register");
    } catch (err) {
      logger.warn("[post-label-purchase] aftership-register enqueue failed", {
        warehouse_shipment_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Phase 10.2 — only EP-purchased labels get an EP tracker registration via
    // this orchestrator (Pirate Ship import calls easypost-register-tracker
    // directly with carrier hint). For non-EP labels we skip — EP can still
    // track them but the registration would happen elsewhere.
    if (shipment.label_source === "easypost") {
      try {
        await tasks.trigger("easypost-register-tracker", { shipment_id: shipment.id });
        triggered.push("easypost-register-tracker");
      } catch (err) {
        logger.warn("[post-label-purchase] easypost-register-tracker enqueue failed", {
          warehouse_shipment_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Phase 12 — fire the unified shipment-confirmation email. The task
    // itself consults deriveNotificationStrategy and skips quietly when
    // workspaces.flags.email_send_strategy is 'off' or 'ss_for_all'. So
    // wiring it here is safe even pre-cutover; nothing actually sends until
    // the strategy flag flips to 'shadow' or 'unified_resend'.
    try {
      await tasks.trigger("send-tracking-email", {
        shipment_id: shipment.id,
        trigger_status: "shipped",
      });
      triggered.push("send-tracking-email:shipped");
    } catch (err) {
      logger.warn("[post-label-purchase] send-tracking-email enqueue failed", {
        warehouse_shipment_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Source-specific platform fulfillment marking.
    if (shipment.shipstation_order_id) {
      // Phase 4: shipstation-mark-shipped (the v2 fulfillments path with v1
      // markasshipped fallback). This task lands in Phase 4.3; the orchestrator
      // ships first so Phase 4 just adds the implementation. Until 4.3 ships
      // the trigger will fail-open because trigger.dev doesn't validate task
      // ids at enqueue time — the catch keeps the orchestrator from regressing
      // earlier flows.
      try {
        await tasks.trigger("shipstation-mark-shipped", {
          warehouse_shipment_id: shipment.id,
        });
        triggered.push("shipstation-mark-shipped");
      } catch (err) {
        logger.warn(
          "[post-label-purchase] shipstation-mark-shipped enqueue failed (Phase 4.3 not yet shipped?)",
          {
            warehouse_shipment_id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    if (shipment.order_id) {
      try {
        await tasks.trigger("mark-platform-fulfilled", {
          order_id: shipment.order_id,
          tracking_number: shipment.tracking_number,
          carrier: shipment.carrier,
        });
        triggered.push("mark-platform-fulfilled");
      } catch (err) {
        logger.warn("[post-label-purchase] mark-platform-fulfilled enqueue failed", {
          warehouse_shipment_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (shipment.mailorder_id) {
      try {
        await tasks.trigger("mark-mailorder-fulfilled", {
          mailorder_id: shipment.mailorder_id,
          tracking_number: shipment.tracking_number,
          carrier: shipment.carrier,
        });
        triggered.push("mark-mailorder-fulfilled");
      } catch (err) {
        logger.warn("[post-label-purchase] mark-mailorder-fulfilled enqueue failed", {
          warehouse_shipment_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.log("[post-label-purchase] orchestrated downstream tasks", {
      warehouse_shipment_id,
      triggered,
    });

    return { ok: true, triggered };
  },
});
