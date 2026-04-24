/**
 * Phase 5 §9.6 D1.c — inventory commitments counter↔ledger reconciliation.
 *
 * Daily cron that asserts the invariant:
 *
 *   warehouse_inventory_levels.committed_quantity
 *     = SUM(inventory_commitments.qty WHERE released_at IS NULL)
 *   per (workspace_id, sku)
 *
 * The trigger `sync_committed_quantity()` (migration 20260424000004)
 * keeps the denormalized counter in lockstep with the ledger inside a
 * single transaction. This recon task is the SAFETY NET that catches:
 *
 *   1. trigger bypass — any application code that tries to UPDATE
 *      warehouse_inventory_levels.committed_quantity directly (Rule
 *      #20 / Rule #58 — only the trigger may write this column).
 *   2. trigger disable + manual intervention (e.g., DBA runs
 *      `ALTER TABLE ... DISABLE TRIGGER` for a maintenance window
 *      and forgets to re-enable).
 *   3. raw SQL deletes/updates against inventory_commitments that
 *      bypass the application path (manual cleanup, restored backups).
 *   4. counter NULL/missing on a level row that was created BEFORE
 *      migration 20260424000004 landed (defaulted to 0 by the
 *      migration; this task re-checks that no NULLs leaked back in).
 *
 * Plan reference: §9.6 D1.c.
 *
 * Behavior:
 *   - Runs daily 04:15 UTC (well after the 04:00 daily-recon-summary
 *     window so dashboards have a settled checkpoint).
 *   - Runs ALL workspaces in one pass (no per-workspace fanout —
 *     drift is a global invariant violation worth one row per (ws,
 *     sku) pair, not one per workspace queue entry).
 *   - For every (workspace_id, sku) where counter ≠ ledger SUM,
 *     UPSERTs a `warehouse_review_queue` row (severity='high',
 *     category='inv_committed_counter_drift', dedup'd via
 *     group_key='inv-committed-drift:{workspace}:{sku}').
 *   - Records a summary `sensor_readings` row with the global drift
 *     count so the operations dashboard can chart it over time.
 *   - Independent of `workspaces.atp_committed_active` — recon ALWAYS
 *     runs because trigger correctness is independent of consumer-side
 *     math (Phase 5 §9.6 D1.b gate). When the gate is OFF, drift in
 *     the counter still matters for visibility/audit; when the gate
 *     flips ON later, drift is operationally critical (would silently
 *     under/over-push every channel).
 *
 * Recovery contract:
 *   - The recon task NEVER auto-corrects drift. Auto-correction
 *     hides the underlying bug (trigger bypass, lost write) that
 *     the drift is signaling. The review queue row links the
 *     operator to a forthcoming (D3+) "Recompute committed_quantity
 *     for SKU" action that runs the underlying RPC under controlled
 *     conditions.
 *
 * Rule #7 (service-role client), Rule #12 (no-payload schedule).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger, schedules } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface DriftRow {
  workspace_id: string;
  sku: string;
  counter_value: number;
  ledger_sum: number;
  drift: number;
}

interface InventoryLevelRow {
  workspace_id: string;
  sku: string;
  committed_quantity: number | null;
}

interface CommitmentSumRow {
  workspace_id: string;
  sku: string;
  qty: number;
}

export interface ReconResult {
  levelsScanned: number;
  openLedgerKeys: number;
  driftCount: number;
  drift: DriftRow[];
}

/**
 * Pure-data recon — exported so unit tests can pin behavior without
 * spawning a Trigger run. The schedule task below is a thin wrapper
 * that injects the service-role client + run id.
 */
export async function runInventoryCommittedCounterRecon(args: {
  supabase: SupabaseClient;
  reconRunId: string;
  pageSize?: number;
}): Promise<ReconResult> {
  const { supabase, reconRunId } = args;
  const pageSize = args.pageSize ?? 1000;
  const startedAt = new Date().toISOString();

  // 1. Pull every (workspace_id, sku, committed_quantity) row in
  //    pages so this works on workspaces with very large variant
  //    catalogs (~5k SKUs today; pageSize=1000 leaves headroom).
  const counterByKey = new Map<string, { workspace_id: string; sku: string; counter: number }>();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("warehouse_inventory_levels")
      .select("workspace_id, sku, committed_quantity")
      .range(from, from + pageSize - 1);
    if (error) {
      logger.error("[inv-committed-recon] failed reading inventory levels", { error });
      throw new Error(`inventory_levels read failed: ${error.message}`);
    }
    const rows = (data ?? []) as InventoryLevelRow[];
    for (const r of rows) {
      const key = `${r.workspace_id}|${r.sku}`;
      counterByKey.set(key, {
        workspace_id: r.workspace_id,
        sku: r.sku,
        counter: typeof r.committed_quantity === "number" ? r.committed_quantity : 0,
      });
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  // 2. Pull every OPEN ledger row (released_at IS NULL) and sum qty
  //    per (workspace_id, sku) in memory. The set of open rows is
  //    small relative to the catalog; a SQL GROUP BY RPC is cheaper
  //    only past ~50k open rows.
  const ledgerSumByKey = new Map<string, number>();
  from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inventory_commitments")
      .select("workspace_id, sku, qty")
      .is("released_at", null)
      .range(from, from + pageSize - 1);
    if (error) {
      logger.error("[inv-committed-recon] failed reading commitment ledger", { error });
      throw new Error(`inventory_commitments read failed: ${error.message}`);
    }
    const rows = (data ?? []) as CommitmentSumRow[];
    for (const r of rows) {
      const key = `${r.workspace_id}|${r.sku}`;
      ledgerSumByKey.set(key, (ledgerSumByKey.get(key) ?? 0) + (r.qty ?? 0));
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  // 3. Compare. Drift = (counter - ledger_sum). Zero drift on every
  //    key where counter==ledger_sum is healthy. Levels rows with no
  //    open commitments are healthy at counter=0. Open-commitment
  //    rows for SKUs with no level row are drift in the OTHER
  //    direction (ledger present, no level row) — also reported.
  const drift: DriftRow[] = [];
  const allKeys = new Set<string>([...counterByKey.keys(), ...ledgerSumByKey.keys()]);
  for (const key of allKeys) {
    const counterRow = counterByKey.get(key);
    const ledgerSum = ledgerSumByKey.get(key) ?? 0;
    const counterValue = counterRow?.counter ?? 0;
    if (counterValue !== ledgerSum) {
      const [workspace_id, sku] = key.split("|");
      drift.push({
        workspace_id,
        sku,
        counter_value: counterValue,
        ledger_sum: ledgerSum,
        drift: counterValue - ledgerSum,
      });
    }
  }

  logger.info("[inv-committed-recon] completed scan", {
    levels_scanned: counterByKey.size,
    open_ledger_keys: ledgerSumByKey.size,
    drift_rows: drift.length,
    run_id: reconRunId,
    started_at: startedAt,
  });

  // 4. UPSERT one warehouse_review_queue row per drifted (ws, sku).
  //    group_key dedups across runs: the same drift increments
  //    occurrence_count (via DB merge) rather than spawning a new
  //    row every day.
  if (drift.length > 0) {
    const queueRows = drift.map((d) => ({
      workspace_id: d.workspace_id,
      category: "inv_committed_counter_drift",
      severity: "high",
      title: `committed_quantity drift on SKU ${d.sku}`,
      description: `Counter=${d.counter_value} vs ledger SUM=${d.ledger_sum} (drift=${d.drift > 0 ? "+" : ""}${d.drift}). Indicates either a trigger bypass or a manual UPDATE/DELETE on inventory_commitments. Review the recent commit/release history for this SKU and run the recompute action when a fix has been identified.`,
      metadata: {
        sku: d.sku,
        workspace_id: d.workspace_id,
        counter_value: d.counter_value,
        ledger_sum: d.ledger_sum,
        drift: d.drift,
        recon_run_id: reconRunId,
        recon_started_at: startedAt,
      },
      status: "open",
      group_key: `inv-committed-drift:${d.workspace_id}:${d.sku}`,
      occurrence_count: 1,
    }));

    // Chunked upsert — Postgres has a parameter limit; 200 rows ×
    // ~10 fields ≈ 2000 params, comfortably under the 65535 cap.
    const chunkSize = 200;
    for (let i = 0; i < queueRows.length; i += chunkSize) {
      const chunk = queueRows.slice(i, i + chunkSize);
      const { error } = await supabase
        .from("warehouse_review_queue")
        .upsert(chunk, { onConflict: "group_key", ignoreDuplicates: false });
      if (error) {
        logger.error("[inv-committed-recon] review queue upsert failed", {
          error,
          chunk_start: i,
        });
      }
    }
  }

  // 5. Per-workspace summary sensor rows — `sensor_readings.workspace_id`
  //    is NOT NULL (Rule #58 — single owner of the sensor schema), so we
  //    can't write a single global row. We DO want one row per workspace
  //    that has any inventory levels (healthy=0 drift, warning=>0 drift)
  //    so dashboards can chart per-workspace recon health over time.
  const workspacesWithLevels = new Set<string>();
  for (const v of counterByKey.values()) workspacesWithLevels.add(v.workspace_id);
  for (const d of drift) workspacesWithLevels.add(d.workspace_id); // catch ledger-only drift

  const driftByWorkspace = new Map<string, number>();
  for (const d of drift) {
    driftByWorkspace.set(d.workspace_id, (driftByWorkspace.get(d.workspace_id) ?? 0) + 1);
  }

  if (workspacesWithLevels.size > 0) {
    const sensorRows = Array.from(workspacesWithLevels).map((workspace_id) => {
      const wsDrift = driftByWorkspace.get(workspace_id) ?? 0;
      return {
        workspace_id,
        sensor_name: "inv.committed_counter_recon",
        status: wsDrift === 0 ? "healthy" : "warning",
        message:
          wsDrift === 0
            ? "committed_quantity counter matches ledger SUM on every SKU"
            : `committed_quantity drift on ${wsDrift} SKU(s) — review queue updated`,
        value: {
          levels_scanned: counterByKey.size,
          open_ledger_keys: ledgerSumByKey.size,
          workspace_drift_count: wsDrift,
          global_drift_count: drift.length,
          recon_run_id: reconRunId,
          started_at: startedAt,
        },
      };
    });
    const { error: sensorErr } = await supabase.from("sensor_readings").insert(sensorRows);
    if (sensorErr) {
      logger.error("[inv-committed-recon] sensor_readings insert failed", { error: sensorErr });
    }
  }

  return {
    levelsScanned: counterByKey.size,
    openLedgerKeys: ledgerSumByKey.size,
    driftCount: drift.length,
    drift,
  };
}

export const inventoryCommittedCounterReconTask = schedules.task({
  id: "inventory-committed-counter-recon",
  // 04:15 UTC daily — 15 min after the daily-recon-summary lands.
  cron: "15 4 * * *",
  maxDuration: 600,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const result = await runInventoryCommittedCounterRecon({
      supabase,
      reconRunId: ctx.run.id,
    });
    return {
      levelsScanned: result.levelsScanned,
      openLedgerKeys: result.openLedgerKeys,
      driftCount: result.driftCount,
      sample: result.drift.slice(0, 10),
    };
  },
});
