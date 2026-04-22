// Phase 5.3 — Daily preorder-tab refresh.
//
// At 5 AM NY each day, re-derive preorder_state for shipstation_orders rows
// that may have crossed the today+7 boundary overnight, OR for rows that have
// preorder lines released as of today.
//
// Strategy:
//   1. Pull candidate rows: preorder_state IN ('preorder','ready') OR
//      (order_status = 'awaiting_shipment' AND preorder_release_date IS NOT NULL).
//      Cap at MAX_ROWS to keep one cron run bounded.
//   2. For each row, re-load its items + variants, recompute via
//      applyPreorderState(). The helper writes back the new state in one UPDATE.
//   3. Emit telemetry to sensor_readings (count moved preorder→ready,
//      ready→none, etc.) for the Phase 7.1 `preorder.tab_state_drift` sensor.
//
// Idempotent — the function can be re-run any time without side effects beyond
// writing the same value back.

import { logger, schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { applyPreorderState } from "@/trigger/tasks/shipstation-orders-poll";

const MAX_ROWS_PER_RUN = 5000;

interface RefreshResult {
  workspaces: number;
  scanned: number;
  promoted_to_preorder: number;
  promoted_to_ready: number;
  released_to_none: number;
  unchanged: number;
  errors: number;
}

export const preorderTabRefreshTask = schedules.task({
  id: "preorder-tab-refresh",
  cron: {
    pattern: "0 5 * * *",
    timezone: "America/New_York",
  },
  maxDuration: 600,
  run: async (): Promise<RefreshResult> => {
    return runPreorderTabRefresh();
  },
});

/**
 * Phase 5.3 — exported for unit testing AND for ad-hoc invocation (e.g.
 * cockpit "Recompute preorder state for all rows" admin button).
 */
export async function runPreorderTabRefresh(
  args: { workspaceId?: string } = {},
): Promise<RefreshResult> {
  const supabase = createServiceRoleClient();
  const workspaceIds = args.workspaceId ? [args.workspaceId] : await getAllWorkspaceIds(supabase);

  const totals: RefreshResult = {
    workspaces: workspaceIds.length,
    scanned: 0,
    promoted_to_preorder: 0,
    promoted_to_ready: 0,
    released_to_none: 0,
    unchanged: 0,
    errors: 0,
  };

  for (const workspaceId of workspaceIds) {
    // Candidate rows: anything currently in a preorder state, PLUS every
    // awaiting_shipment row regardless of its current preorder_state. The
    // latter is critical — without it, an order ingested BEFORE its variant
    // was marked is_preorder=true would stay at preorder_state='none' forever
    // (the bug that left 141 orders invisible in the Preorders tab in
    // production until the 2026-04-20 fix).
    //
    // Bounded by MAX_ROWS_PER_RUN; a fresh inventory week could push this near
    // the cap, but the typical steady state of ~600 awaiting_shipment orders
    // is comfortably below.
    const { data: rows, error } = await supabase
      .from("shipstation_orders")
      .select("id, preorder_state")
      .eq("workspace_id", workspaceId)
      .or("preorder_state.eq.preorder,preorder_state.eq.ready,order_status.eq.awaiting_shipment")
      .limit(MAX_ROWS_PER_RUN);

    if (error) {
      logger.warn("[preorder-tab-refresh] candidate query failed", {
        workspaceId,
        error: error.message,
      });
      totals.errors++;
      continue;
    }

    for (const row of rows ?? []) {
      totals.scanned++;
      const previousState = row.preorder_state as "none" | "preorder" | "ready";

      // Pull items for this order so applyPreorderState can rebuild the variant
      // lookup. Small set per order; not worth caching.
      const { data: items } = await supabase
        .from("shipstation_order_items")
        .select("sku")
        .eq("shipstation_order_id", row.id);

      try {
        const result = await applyPreorderState(supabase, workspaceId, row.id, items ?? []);

        if (result.preorder_state === previousState) {
          totals.unchanged++;
        } else if (previousState === "none" && result.preorder_state === "preorder") {
          totals.promoted_to_preorder++;
        } else if (previousState === "none" && result.preorder_state === "ready") {
          totals.promoted_to_ready++;
        } else if (previousState === "preorder" && result.preorder_state === "ready") {
          totals.promoted_to_ready++;
        } else if (
          (previousState === "preorder" || previousState === "ready") &&
          result.preorder_state === "none"
        ) {
          totals.released_to_none++;
        }
      } catch (err) {
        totals.errors++;
        logger.warn("[preorder-tab-refresh] applyPreorderState failed (row skipped)", {
          row_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await supabase.from("sensor_readings").insert({
      workspace_id: workspaceId,
      sensor_name: "trigger:preorder-tab-refresh",
      status: totals.errors > 0 ? "warning" : "healthy",
      message: `Scanned ${totals.scanned} rows; ${totals.promoted_to_preorder} none→preorder, ${totals.promoted_to_ready} →ready, ${totals.released_to_none} released, ${totals.unchanged} unchanged, ${totals.errors} errors.`,
      value: totals,
    });
  }

  logger.log("[preorder-tab-refresh] done", { ...totals });
  return totals;
}
