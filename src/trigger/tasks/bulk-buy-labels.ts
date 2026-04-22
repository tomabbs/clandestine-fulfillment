// Phase 9.1 — Bulk Create + Print Labels orchestrator task.
//
// Triggered by the bulkBuyLabels server action with a list of (order_uuid,
// selectedRate) pairs and the print_batch_jobs row id. Fires
// create-shipping-label PER ORDER, sequentially under shipstationQueue
// (which has concurrencyLimit=1) so we respect the SS rate limit. As each
// completes, we update print_batch_jobs.progress so the modal can poll.
//
// Failure handling: per-order. One bad order does NOT halt the batch.
// Final status:
//   - 'completed'              — all rows succeeded
//   - 'completed_with_errors'  — at least one failed, at least one succeeded
//   - 'failed'                 — every row failed
//
// We use waitForCompletion semantics by triggerAndWait per row so the
// orchestrator is the single point of progress emission. This keeps the
// modal poll source simple (one row, not N runs).

import { logger, task } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";
import { createShippingLabelTask } from "./create-shipping-label";

interface BulkBuyOrder {
  shipstationOrderUuid: string;
  selectedRate: {
    carrier: string;
    service: string;
    rate: number;
    deliveryDays?: number | null;
    currency?: string;
    carrierAccountId?: string;
  };
}

interface BulkBuyLabelsPayload {
  batchId: string;
  workspaceId: string;
  actorUserId: string;
  buys: BulkBuyOrder[];
}

interface PerOrderOutcome {
  uuid: string;
  ok: boolean;
  warehouseShipmentId?: string | null;
  error?: string;
}

interface BulkBuyLabelsResult {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  status: "completed" | "completed_with_errors" | "failed";
}

export const bulkBuyLabelsTask = task({
  id: "bulk-buy-labels",
  queue: shipstationQueue,
  maxDuration: 1800, // 30 min wall-clock cap for a hard-cap-200 batch
  run: async (payload: BulkBuyLabelsPayload): Promise<BulkBuyLabelsResult> => {
    const supabase = createServiceRoleClient();
    const { batchId, workspaceId, buys } = payload;

    await supabase
      .from("print_batch_jobs")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", batchId);

    const outcomes: PerOrderOutcome[] = [];
    const shipmentIds: string[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const buy of buys) {
      try {
        // Resolve order-source context: cockpit batch is always
        // orderType='shipstation' since the cockpit only lists SS orders.
        const result = await createShippingLabelTask.triggerAndWait(
          {
            orderId: buy.shipstationOrderUuid,
            orderType: "shipstation",
            selectedRate: buy.selectedRate,
          },
          { tags: [`bulk-batch:${batchId}`] },
        );

        if (result.ok && result.output?.success) {
          const wsId = result.output.shipmentId ?? null;
          if (wsId) shipmentIds.push(wsId);
          outcomes.push({
            uuid: buy.shipstationOrderUuid,
            ok: true,
            warehouseShipmentId: wsId,
          });
          succeeded++;
        } else {
          const taskErrMsg =
            !result.ok &&
            result.error &&
            typeof result.error === "object" &&
            "message" in result.error
              ? String((result.error as { message?: unknown }).message ?? "unknown")
              : "unknown";
          const err = result.ok
            ? (result.output?.error ?? "unknown failure")
            : `task failed: ${taskErrMsg}`;
          outcomes.push({
            uuid: buy.shipstationOrderUuid,
            ok: false,
            error: err,
          });
          failed++;
        }
      } catch (err) {
        outcomes.push({
          uuid: buy.shipstationOrderUuid,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        failed++;
        logger.warn("[bulk-buy-labels] per-order trigger threw", {
          batchId,
          uuid: buy.shipstationOrderUuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Update progress after EACH order so the modal poll sees fresh state.
      await supabase
        .from("print_batch_jobs")
        .update({
          shipment_ids: shipmentIds,
          progress: {
            total: buys.length,
            completed: succeeded + failed,
            succeeded,
            failed,
            per_order: Object.fromEntries(outcomes.map((o) => [o.uuid, o])),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", batchId);
    }

    const finalStatus: BulkBuyLabelsResult["status"] =
      failed === 0 ? "completed" : succeeded === 0 ? "failed" : "completed_with_errors";

    await supabase
      .from("print_batch_jobs")
      .update({
        status: finalStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId);

    return {
      ok: failed === 0,
      total: buys.length,
      succeeded,
      failed,
      status: finalStatus,
    };
  },
});
