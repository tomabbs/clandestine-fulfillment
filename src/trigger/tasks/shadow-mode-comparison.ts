/**
 * Phase 3 Pass 2 — shadow-mode comparison task.
 *
 * Triggered by `recordShadowPush()` (`src/lib/server/connection-shadow-log.ts`)
 * with a delay equal to `shadow_window_tolerance_seconds` (default 60s).
 * Reads ShipStation v2 inventory for the same SKU + workspace defaults,
 * compares to the value we pushed directly to the storefront, and persists
 * the result back to the originating `connection_shadow_log` row.
 *
 * The 7-day rolling match-rate computed from these rows gates
 * `runConnectionCutover()` (D4) — the operator cannot flip a connection to
 * `cutover_state='direct'` until shadow mode demonstrates that direct
 * pushes and SS-mirrored writes converge.
 *
 * Pinned to `shipstationQueue` (concurrencyLimit: 1) so this task shares
 * the v2 60 req/min budget with seed, reconcile, SHIP_NOTIFY, and the
 * focused adjust task. No new contention class.
 *
 * Skip cascade:
 *   1. shadow log row missing — race between recordShadowPush insert and
 *      this task running. Trigger.dev retries automatically.
 *   2. shadow log already has match/observed_at — duplicate fire (e.g.
 *      operator manually re-enqueued); short-circuit.
 *   3. workspace v2 defaults missing — same skip semantics as
 *      shipstation-v2-adjust-on-sku. Mark the row `match=null,
 *      observed_at=now()` with a `skip_reason` in metadata so diagnostics
 *      can distinguish "v2 not configured" from "v2 disagrees".
 *   4. v2 returns no row for the SKU — v2 has 0 (Phase 0 §4.2.3 — SKUs at
 *      0 are invisible to listInventory). Treat as `ss_observed_quantity=0`
 *      for the comparison.
 *
 * On success: writes `ss_observed_quantity`, `observed_at`, `match`, and
 * `drift_units` back to the row. NEVER throws on a comparison mismatch —
 * the row IS the diagnostic; the operator inspects diagnostics, not
 * exception logs.
 *
 * Rule #7  — service-role client.
 * Rule #12 — payload IDs only.
 */

import { logger, task } from "@trigger.dev/sdk";
import { listInventory } from "@/lib/clients/shipstation-inventory-v2";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface ShadowModeComparisonPayload {
  shadowLogId: string;
  workspaceId: string;
  connectionId: string;
  sku: string;
  correlationId: string;
  pushedQuantity: number;
  pushedAt: string;
}

export type ShadowModeComparisonResult =
  | {
      status: "compared";
      shadowLogId: string;
      sku: string;
      pushedQuantity: number;
      observedQuantity: number;
      match: boolean;
      driftUnits: number;
    }
  | {
      status:
        | "skipped_log_missing"
        | "skipped_already_compared"
        | "skipped_no_v2_defaults"
        | "skipped_error";
      shadowLogId: string;
      sku: string;
      reason: string;
    };

/**
 * Pure runner — extracted so the unit suite can call the task body directly
 * without depending on Trigger.dev's `task<...>().run` private surface (the
 * `Task<>` generic does not expose `.run` on the public type — exporting the
 * runner separately keeps tests independent of SDK internals).
 */
export async function runShadowModeComparison(
  payload: ShadowModeComparisonPayload,
): Promise<ShadowModeComparisonResult> {
  const { shadowLogId, workspaceId, sku, pushedQuantity } = payload;

  const supabase = createServiceRoleClient();

  // 1) re-read the shadow log row. Defensive: bail if it disappeared
  //    (e.g. retention pruning ran, operator manually deleted, etc.).
  const { data: logRow, error: logErr } = await supabase
    .from("connection_shadow_log")
    .select("id, match, observed_at, metadata")
    .eq("id", shadowLogId)
    .maybeSingle();

  if (logErr || !logRow) {
    logger.warn("[shadow-mode-comparison] shadow log row missing", {
      shadowLogId,
      sku,
      error: logErr?.message,
    });
    return {
      status: "skipped_log_missing",
      shadowLogId,
      sku,
      reason: logErr?.message ?? "row_not_found",
    };
  }

  if (logRow.match !== null || logRow.observed_at !== null) {
    // Duplicate fire — typically the same row was already compared
    // either by an operator-issued re-run or by Trigger.dev retrying
    // a task that succeeded mid-write. Idempotent skip.
    logger.info("[shadow-mode-comparison] already compared — skipping", {
      shadowLogId,
      sku,
    });
    return {
      status: "skipped_already_compared",
      shadowLogId,
      sku,
      reason: "match_or_observed_at_set",
    };
  }

  // 2) load workspace v2 defaults. Same skip semantics as
  //    shipstation-v2-adjust-on-sku.
  const { data: ws } = await supabase
    .from("workspaces")
    .select("shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id")
    .eq("id", workspaceId)
    .single();

  const warehouseId = ws?.shipstation_v2_inventory_warehouse_id ?? null;
  const locationId = ws?.shipstation_v2_inventory_location_id ?? null;

  if (!warehouseId || !locationId) {
    // v2 not configured for this workspace — record the comparison as
    // skipped so the operator dashboard shows "shadow mode running but
    // no v2 to compare against". Diagnostics will surface this as a
    // setup gap.
    const observedAt = new Date().toISOString();
    await supabase
      .from("connection_shadow_log")
      .update({
        observed_at: observedAt,
        match: null,
        drift_units: null,
        metadata: {
          ...((logRow.metadata as Record<string, unknown> | null) ?? {}),
          skip_reason: "no_v2_defaults",
        },
      })
      .eq("id", shadowLogId);

    logger.info("[shadow-mode-comparison] workspace v2 defaults missing", {
      shadowLogId,
      workspaceId,
      sku,
    });
    return {
      status: "skipped_no_v2_defaults",
      shadowLogId,
      sku,
      reason: "shipstation_v2_inventory_warehouse_id_or_location_id_missing",
    };
  }

  // 3) read v2 state. listInventory returns no row for SKUs at 0
  //    (Phase 0 §4.2.3) — treat absent as 0.
  let observedQuantity = 0;
  try {
    const records = await listInventory({
      skus: [sku],
      inventory_warehouse_id: warehouseId,
      inventory_location_id: locationId,
    });
    if (records.length > 0) {
      const r = records[0];
      // v2 reports `available` (sellable, post-allocation). Mirror the
      // inventory-fanout / reconcile sensor by using the same field —
      // we want to compare apples to apples with what we pushed.
      observedQuantity = typeof r.available === "number" ? r.available : 0;
    }
  } catch (err) {
    // v2 read failed. Persist the failure so the row is not orphaned;
    // the row stays at match=null, but observed_at is set so the
    // unresolved-row sweep doesn't re-enqueue indefinitely. Return
    // `skipped_error` so the operator can see something failed.
    const observedAt = new Date().toISOString();
    await supabase
      .from("connection_shadow_log")
      .update({
        observed_at: observedAt,
        match: null,
        drift_units: null,
        metadata: {
          ...((logRow.metadata as Record<string, unknown> | null) ?? {}),
          skip_reason: "v2_read_failed",
          v2_error: err instanceof Error ? err.message : String(err),
        },
      })
      .eq("id", shadowLogId);

    logger.error("[shadow-mode-comparison] v2 read failed", {
      shadowLogId,
      sku,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "skipped_error",
      shadowLogId,
      sku,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const driftUnits = observedQuantity - pushedQuantity;
  const match = driftUnits === 0;
  const observedAt = new Date().toISOString();

  await supabase
    .from("connection_shadow_log")
    .update({
      ss_observed_quantity: observedQuantity,
      observed_at: observedAt,
      match,
      drift_units: driftUnits,
    })
    .eq("id", shadowLogId);

  logger.info("[shadow-mode-comparison] comparison persisted", {
    shadowLogId,
    sku,
    pushedQuantity,
    observedQuantity,
    driftUnits,
    match,
  });

  return {
    status: "compared",
    shadowLogId,
    sku,
    pushedQuantity,
    observedQuantity,
    match,
    driftUnits,
  };
}

export const shadowModeComparisonTask = task({
  id: "shadow-mode-comparison",
  queue: shipstationQueue,
  maxDuration: 60,
  run: runShadowModeComparison,
});
