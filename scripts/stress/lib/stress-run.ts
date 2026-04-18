/**
 * Phase 5 (finish-line plan v4) — Shared stress harness library.
 *
 * Conventions enforced for every stress script (per plan v4 §5 reviewer-B
 * §5: "full traceability"):
 *   • Every run mints a `stress_run_id = '${script}-${utc-iso8601}'` once.
 *   • Synthetic SKUs use prefix `STRESS-${stress_run_id}-`.
 *   • Synthetic ShipStation locations use prefix `TEST-${stress_run_id}-`.
 *   • All `correlation_id`s carry prefix `${stress_run_id}-`.
 *   • Every `external_sync_events.metadata` and `warehouse_review_queue`
 *     row written by the script includes `{ "stress_run_id": "..." }`.
 *   • Final action: side-effects summary SQL → reports/stress/${id}-summary.json.
 *   • CLI flags: `--workspace=<id> --dry-run --report=<path> --apply`.
 *
 * The `ramp-halt-criteria-sensor` filters every artifact whose
 * `correlation_id LIKE '${prefix}%'` OR `metadata->>'stress_run_id' IS NOT NULL`
 * via `excludeStressArtifacts()` so this prefix system is also the
 * coordination contract between stress scripts and the production sensor.
 *
 * NEVER export the prefix-bypass logic from `src/`. This file lives ONLY in
 * `scripts/stress/lib/` so it cannot be imported by production code paths.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StressRunIds {
  /** Stable identifier for the run, e.g. `manual-count-burst-2026-04-13T15-00-00-000Z`. */
  readonly stressRunId: string;
  /** Prefix all synthetic SKUs share, e.g. `STRESS-${stressRunId}-`. */
  readonly skuPrefix: string;
  /** Prefix all synthetic ShipStation locations share, e.g. `TEST-${stressRunId}-`. */
  readonly locationPrefix: string;
  /** Prefix all correlation_ids share, e.g. `${stressRunId}-`. */
  readonly correlationPrefix: string;
  /** Default report path, e.g. `reports/stress/${stressRunId}.json`. */
  readonly defaultReportPath: string;
  /** Default summary path, e.g. `reports/stress/${stressRunId}-summary.json`. */
  readonly summaryPath: string;
}

export interface StressCliFlags {
  workspaceId: string | null;
  dryRun: boolean;
  apply: boolean;
  reportPath: string | null;
  forceDebugBypass: boolean;
  workspaceLabel: string | null;
}

export function mintStressRunIds(scriptName: string): StressRunIds {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const stressRunId = `${scriptName}-${ts}`;
  return {
    stressRunId,
    skuPrefix: `STRESS-${stressRunId}-`,
    locationPrefix: `TEST-${stressRunId}-`,
    correlationPrefix: `${stressRunId}-`,
    defaultReportPath: `reports/stress/${stressRunId}.json`,
    summaryPath: `reports/stress/${stressRunId}-summary.json`,
  };
}

/**
 * Parse the stress-script CLI conventions. All stress scripts accept the
 * same surface so the operator can wire them into `pnpm stress:all` without
 * remembering script-specific flags.
 */
export function parseStressFlags(argv: string[]): StressCliFlags {
  const flags: StressCliFlags = {
    workspaceId: null,
    workspaceLabel: null,
    dryRun: false,
    apply: false,
    reportPath: null,
    forceDebugBypass: false,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--force-debug-bypass") flags.forceDebugBypass = true;
    else if (arg.startsWith("--workspace=")) flags.workspaceId = arg.slice("--workspace=".length);
    else if (arg.startsWith("--workspace-label="))
      flags.workspaceLabel = arg.slice("--workspace-label=".length);
    else if (arg.startsWith("--report=")) flags.reportPath = arg.slice("--report=".length);
  }
  return flags;
}

/**
 * Stress-script result envelope. Every script returns one of these so the
 * top-level `pnpm stress:all` runner can aggregate pass/fail tallies into
 * a single artifact.
 */
export interface StressReport {
  stressRunId: string;
  scriptName: string;
  ts: string;
  workspaceId: string | null;
  dryRun: boolean;
  passed: boolean;
  assertions: Array<{
    name: string;
    passed: boolean;
    expected: unknown;
    actual: unknown;
    note?: string;
  }>;
  metrics: Record<string, number | string | null>;
  /** Full SQL string the script suggests for post-run forensic review. */
  sideEffectsSummarySql: string;
  notes: string[];
}

export function writeReport(path: string, report: StressReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}

/**
 * Suggested side-effects summary SQL for any stress run. Operators paste
 * this into `psql` post-run to confirm the run created what it claimed and
 * nothing else.
 */
export function buildSideEffectsSummarySql(stressRunId: string): string {
  return `
-- Side-effects summary for stress run: ${stressRunId}
-- Run via: psql "$DATABASE_URL" -f - <<'EOF'

select 'external_sync_events' as table_name, count(*)::text as cnt
  from external_sync_events
  where correlation_id like '${stressRunId}%'
     or metadata->>'stress_run_id' = '${stressRunId}'
union all
select 'warehouse_inventory_activity', count(*)::text
  from warehouse_inventory_activity
  where correlation_id like '${stressRunId}%'
     or metadata->>'stress_run_id' = '${stressRunId}'
union all
select 'warehouse_review_queue', count(*)::text
  from warehouse_review_queue
  where group_key like 'stress:${stressRunId}:%'
     or metadata->>'stress_run_id' = '${stressRunId}'
union all
select 'webhook_events', count(*)::text
  from webhook_events
  where external_webhook_id like '${stressRunId}%'
union all
select 'warehouse_locations', count(*)::text
  from warehouse_locations
  where name like 'TEST-${stressRunId}-%';

-- EOF
`.trim();
}

/**
 * Sleep helper for rate-limited stress loops.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tiny assertion helper that returns rather than throws so a script can
 * accumulate every failure into the report instead of stopping at the
 * first one.
 */
export function assertEq<T>(
  name: string,
  expected: T,
  actual: T,
  note?: string,
): { name: string; passed: boolean; expected: T; actual: T; note?: string } {
  const passed = JSON.stringify(expected) === JSON.stringify(actual);
  return { name, passed, expected, actual, note };
}
