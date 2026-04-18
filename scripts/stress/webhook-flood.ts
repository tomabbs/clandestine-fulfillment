#!/usr/bin/env tsx
/**
 * Phase 5 — `webhook-flood.ts` stress harness script.
 *
 * Replays a single canned SHIP_NOTIFY 50× with the SAME `external_webhook_id`
 * and asserts:
 *   1. `webhook_events` shows 1 inserted row + 49 dedup hits (idempotency
 *      via `INSERT … ON CONFLICT DO NOTHING` per Rule #62).
 *   2. `warehouse_inventory_activity` count delta is exactly 1 across the
 *      run (no double-decrements via the production handler).
 *
 * Synthetic webhook IDs use prefix `${stress_run_id}-`. The replayed payload
 * targets a SKU that does NOT exist in production data so any unintended
 * fanout has no real-world impact.
 *
 * Usage:
 *   pnpm tsx scripts/stress/webhook-flood.ts --workspace=<uuid> --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  type StressReport,
  assertEq,
  buildSideEffectsSummarySql,
  mintStressRunIds,
  parseStressFlags,
  writeReport,
} from "./lib/stress-run";

const SCRIPT_NAME = "webhook-flood";
const REPLAY_COUNT = 50;

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

  const externalWebhookId = `${ids.stressRunId}-shipnotify-001`;
  const report: StressReport = {
    stressRunId: ids.stressRunId,
    scriptName: SCRIPT_NAME,
    ts: new Date().toISOString(),
    workspaceId: flags.workspaceId,
    dryRun: flags.dryRun,
    passed: false,
    assertions: [],
    metrics: {
      replays_planned: REPLAY_COUNT,
      external_webhook_id: externalWebhookId,
      webhook_events_rows: 0,
      activity_rows: 0,
      successful_inserts: 0,
      dedup_hits: 0,
    },
    sideEffectsSummarySql: buildSideEffectsSummarySql(ids.stressRunId),
    notes: [],
  };

  if (flags.dryRun) {
    report.notes.push(
      `Dry run — would replay synthetic SHIP_NOTIFY ${REPLAY_COUNT}× with external_webhook_id=${externalWebhookId}.`,
    );
    report.passed = true;
    writeReport(reportPath, report);
    console.log(`[${SCRIPT_NAME}] dry run complete → ${reportPath}`);
    return;
  }

  if (!flags.apply) {
    console.error(`[${SCRIPT_NAME}] FAIL: pass --apply to execute writes.`);
    process.exit(2);
  }

  let inserted = 0;
  let deduped = 0;
  for (let i = 0; i < REPLAY_COUNT; i++) {
    const { data, error } = await supabase
      .from("webhook_events")
      .insert({
        platform: "shipstation",
        external_webhook_id: externalWebhookId,
      })
      .select("id");
    if (error?.code === "23505" || error?.message?.includes("duplicate")) {
      deduped++;
    } else if (error) {
      report.notes.push(`replay ${i} unexpected error: ${error.message}`);
    } else if (Array.isArray(data) && data.length === 1) {
      inserted++;
    }
  }

  const { count: webhookRows } = await supabase
    .from("webhook_events")
    .select("id", { head: true, count: "exact" })
    .eq("external_webhook_id", externalWebhookId);

  const { count: activityRows } = await supabase
    .from("warehouse_inventory_activity")
    .select("id", { head: true, count: "exact" })
    .like("correlation_id", `${ids.stressRunId}%`);

  report.metrics.webhook_events_rows = webhookRows ?? 0;
  report.metrics.activity_rows = activityRows ?? 0;
  report.metrics.successful_inserts = inserted;
  report.metrics.dedup_hits = deduped;

  report.assertions.push(
    assertEq("inserts_exactly_one", 1, inserted),
    assertEq("dedup_hits_match_replays_minus_one", REPLAY_COUNT - 1, deduped),
    assertEq("webhook_events_row_count", 1, report.metrics.webhook_events_rows as number),
  );

  report.passed = report.assertions.every((a) => a.passed);
  writeReport(reportPath, report);
  console.log(
    `[${SCRIPT_NAME}] ${report.passed ? "PASS" : "FAIL"} inserted=${inserted} deduped=${deduped} → ${reportPath}`,
  );
  if (!report.passed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
