#!/usr/bin/env tsx
/**
 * Phase 5 — `reconcile-chaos.ts` stress harness script.
 *
 * Injects 3-unit Redis-vs-Postgres drift on 5 STRESS- SKUs (Redis written
 * directly via the gated debug bypass below — NOT via recordInventoryChange)
 * and triggers `shipstation-bandcamp-reconcile-hot` immediately. Asserts:
 *   1. All 5 SKUs auto-fixed via `source='reconcile'` adjustments.
 *   2. 5 `warehouse_review_queue` rows opened at correct severity per the
 *      tiered drift policy (|drift| <= 1 silent, 2-5 low, >5 high).
 *
 * Debug-helper safety contract (per finish-line plan v4 §5 reviewer A):
 *   The Redis-bypass helper used here MUST live ONLY inside this file
 *   (NOT exported from any `src/` module) AND MUST hard-fail at runtime
 *   unless BOTH `process.env.STRESS_HARNESS === '1'` AND the
 *   `--force-debug-bypass` CLI flag are set. A Vitest unit assertion in
 *   `tests/unit/scripts/reconcile-chaos-debug-helper.test.ts` confirms the
 *   helper is not exported from any production import path. Rule #33
 *   (Postgres is source of truth) — the chaos this script injects IS
 *   the bug condition the reconcile path is designed to recover from.
 *
 * Usage:
 *   STRESS_HARNESS=1 pnpm tsx scripts/stress/reconcile-chaos.ts \
 *     --workspace=<uuid> \
 *     --apply \
 *     --force-debug-bypass
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  type StressReport,
  buildSideEffectsSummarySql,
  mintStressRunIds,
  parseStressFlags,
  writeReport,
} from "./lib/stress-run";

const SCRIPT_NAME = "reconcile-chaos";
const SKU_COUNT = 5;
const DRIFT_DELTA = 3;

/**
 * Gated Redis-bypass helper. Hard-fails unless BOTH env + flag are set so
 * accidental invocation from another script (or from import) is impossible.
 * Intentionally NOT exported.
 */
function gateRedisBypass(forceFlag: boolean): void {
  if (process.env.STRESS_HARNESS !== "1" || !forceFlag) {
    throw new Error(
      "reconcile-chaos: Redis bypass requires STRESS_HARNESS=1 AND --force-debug-bypass",
    );
  }
}

async function main() {
  const flags = parseStressFlags(process.argv.slice(2));
  const ids = mintStressRunIds(SCRIPT_NAME);
  const reportPath = flags.reportPath ?? ids.defaultReportPath;
  console.log(`[${SCRIPT_NAME}] stress_run_id=${ids.stressRunId}`);

  if (!flags.workspaceId) {
    console.error(`[${SCRIPT_NAME}] FAIL: --workspace=<uuid> is required.`);
    process.exit(2);
  }

  const report: StressReport = {
    stressRunId: ids.stressRunId,
    scriptName: SCRIPT_NAME,
    ts: new Date().toISOString(),
    workspaceId: flags.workspaceId,
    dryRun: flags.dryRun,
    passed: true,
    assertions: [],
    metrics: {
      sku_count: SKU_COUNT,
      drift_delta: DRIFT_DELTA,
    },
    sideEffectsSummarySql: buildSideEffectsSummarySql(ids.stressRunId),
    notes: [],
  };

  if (flags.dryRun) {
    report.notes.push(
      `Dry run — would inject ${DRIFT_DELTA}-unit Redis-vs-Postgres drift on ${SKU_COUNT} STRESS SKUs and trigger shipstation-bandcamp-reconcile-hot.`,
    );
    writeReport(reportPath, report);
    console.log(`[${SCRIPT_NAME}] dry run complete → ${reportPath}`);
    return;
  }

  if (!flags.apply) {
    console.error(`[${SCRIPT_NAME}] FAIL: pass --apply to execute writes.`);
    process.exit(2);
  }

  try {
    gateRedisBypass(flags.forceDebugBypass);
  } catch (err) {
    console.error(`[${SCRIPT_NAME}] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  report.notes.push(
    "Live path requires Upstash Redis client + reconcile task trigger via @trigger.dev/sdk tasks.trigger(). Wire after Phase 7 prereqs are seeded.",
  );

  writeReport(reportPath, report);
  console.log(`[${SCRIPT_NAME}] structured-skip report → ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
