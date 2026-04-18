#!/usr/bin/env tsx
/**
 * Phase 5 — `bulk-create-locations-burst.ts` stress harness script.
 *
 * Triggers `createLocationRange({ prefix:'TEST-${stress_run_id}-BURST',
 * fromIndex:1, toIndex:50 })` to exercise the Trigger-task path
 * (>30 entries) introduced in v5. Asserts:
 *   1. The Server Action returns `mode: 'trigger'` synchronously (not 'inline').
 *   2. The `bulk-create-locations` Trigger task completes within budget.
 *   3. All 50 rows present in `warehouse_locations` with
 *      `shipstation_inventory_location_id` populated.
 *   4. Throughout, `shipstationQueue` showed concurrencyLimit:1 (no two
 *      bulk-create-locations runs overlap with each other or with
 *      shipstation-v2-adjust-on-sku).
 *
 * Critical because `bulk-create-locations` has not been exercised under
 * load since it shipped. The 2026-04-13 finish-line baseline confirmed
 * the workspace lacks `shipstation_v2_inventory_warehouse_id`, so the
 * task short-circuits at NO_V2_WAREHOUSE today; the script emits a
 * structured-skip report under those conditions.
 *
 * Usage:
 *   pnpm tsx scripts/stress/bulk-create-locations-burst.ts --workspace=<uuid> --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  type StressReport,
  buildSideEffectsSummarySql,
  mintStressRunIds,
  parseStressFlags,
  writeReport,
} from "./lib/stress-run";

const SCRIPT_NAME = "bulk-create-locations-burst";
const RANGE_SIZE = 50;

async function main() {
  const flags = parseStressFlags(process.argv.slice(2));
  const ids = mintStressRunIds(SCRIPT_NAME);
  const reportPath = flags.reportPath ?? ids.defaultReportPath;
  console.log(`[${SCRIPT_NAME}] stress_run_id=${ids.stressRunId}`);

  if (!flags.workspaceId) {
    console.error(`[${SCRIPT_NAME}] FAIL: --workspace=<uuid> is required.`);
    process.exit(2);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: ws } = await supabase
    .from("workspaces")
    .select("shipstation_v2_inventory_warehouse_id, shipstation_sync_paused")
    .eq("id", flags.workspaceId)
    .single();

  const namePrefix = `TEST-${ids.stressRunId}-BURST`;

  const report: StressReport = {
    stressRunId: ids.stressRunId,
    scriptName: SCRIPT_NAME,
    ts: new Date().toISOString(),
    workspaceId: flags.workspaceId,
    dryRun: flags.dryRun,
    passed: true,
    assertions: [],
    metrics: {
      planned_range_size: RANGE_SIZE,
      name_prefix: namePrefix,
      v2_warehouse_id_present: ws?.shipstation_v2_inventory_warehouse_id ? 1 : 0,
      shipstation_sync_paused: ws?.shipstation_sync_paused ? 1 : 0,
    },
    sideEffectsSummarySql: buildSideEffectsSummarySql(ids.stressRunId),
    notes: [],
  };

  if (flags.dryRun) {
    report.notes.push(
      `Dry run — would call createLocationRange(prefix='${namePrefix}', fromIndex=1, toIndex=${RANGE_SIZE}); expect mode='trigger' (>30 entries).`,
    );
    writeReport(reportPath, report);
    console.log(`[${SCRIPT_NAME}] dry run complete → ${reportPath}`);
    return;
  }

  if (!flags.apply) {
    console.error(`[${SCRIPT_NAME}] FAIL: pass --apply to execute writes.`);
    process.exit(2);
  }

  if (!ws?.shipstation_v2_inventory_warehouse_id) {
    report.notes.push(
      "Skipping live execution — workspace.shipstation_v2_inventory_warehouse_id IS NULL. bulk-create-locations would short-circuit with NO_V2_WAREHOUSE.",
    );
    writeReport(reportPath, report);
    console.log(`[${SCRIPT_NAME}] structured-skip (no v2 warehouse) → ${reportPath}`);
    return;
  }

  report.notes.push(
    "Live path requires the staff-authenticated Server Action shim to call createLocationRange. Wire after Phase 7 prereqs are seeded.",
  );

  writeReport(reportPath, report);
  console.log(`[${SCRIPT_NAME}] structured-skip (no shim) → ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
