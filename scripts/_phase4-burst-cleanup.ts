/**
 * Phase 4 Sub-pass A — burst-test cleanup.
 *
 * Reaps webhook_events rows produced by _phase4-burst-test.ts before the
 * recovery sweeper (webhook-events-recovery-sweep, every 5 min) picks up
 * any enqueue_failed rows and creates a second wave of no-op Trigger runs.
 *
 * Safe because:
 *   - All rows have external_webhook_id LIKE 'phase4-burst-%' (tagged by
 *     the harness).
 *   - All rows are on the Northern Spy Shopify connection in legacy state —
 *     the downstream task ignores them via the ShipStation-authoritative
 *     gate, so deleting them now produces the same end-state.
 *
 * Usage:
 *   pnpm tsx scripts/_phase4-burst-cleanup.ts                    # dry-run preview
 *   pnpm tsx scripts/_phase4-burst-cleanup.ts --apply            # delete all phase4-burst-* rows
 *   pnpm tsx scripts/_phase4-burst-cleanup.ts --apply \
 *       --run-id=2026-04-24T11-09-18-489Z-run1                  # delete one run only
 *   pnpm tsx scripts/_phase4-burst-cleanup.ts --apply --label=run2 # delete all runs labeled run2 (background-job-friendly)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CliArgs {
  apply: boolean;
  runId: string | null;
  label: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { apply: false, runId: null, label: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--run-id=")) out.runId = a.slice("--run-id=".length);
    else if (a.startsWith("--label=")) out.label = a.slice("--label=".length);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createServiceRoleClient();

  // Match priority: --run-id (most specific) → --label (label suffix glob)
  // → bare `phase4-burst-%` (everything from the harness, ever).
  // The label form catches every external_webhook_id of shape
  // `phase4-burst-{ts}-{label}-{seq}` regardless of the timestamp portion,
  // which is what background scheduled runs need (they don't know the
  // runtime-generated run_id at scheduling time).
  let pattern: string;
  if (args.runId) pattern = `phase4-burst-${args.runId}-%`;
  else if (args.label) pattern = `phase4-burst-%-${args.label}-%`;
  else pattern = "phase4-burst-%";

  const { count, error: countErr } = await sb
    .from("webhook_events")
    .select("id", { head: true, count: "exact" })
    .like("external_webhook_id", pattern);
  if (countErr) {
    console.error("Count failed:", countErr);
    process.exit(1);
  }

  console.log(`Phase 4 burst-test cleanup`);
  console.log(`  match pattern : external_webhook_id LIKE '${pattern}'`);
  console.log(`  rows matched  : ${count ?? 0}`);
  console.log(`  mode          : ${args.apply ? "APPLY (will DELETE)" : "DRY-RUN"}`);

  if (!args.apply) {
    console.log("\nDRY-RUN — re-run with --apply to execute the delete.");
    return;
  }

  if (!count || count === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  const { data: byStatus } = await sb
    .from("webhook_events")
    .select("status")
    .like("external_webhook_id", pattern)
    .limit(10000);
  const breakdown: Record<string, number> = {};
  for (const r of byStatus ?? []) {
    breakdown[r.status as string] = (breakdown[r.status as string] ?? 0) + 1;
  }
  console.log(`  status breakdown : ${JSON.stringify(breakdown)}`);

  const { error: delErr } = await sb
    .from("webhook_events")
    .delete()
    .like("external_webhook_id", pattern);
  if (delErr) {
    console.error("Delete failed:", delErr);
    process.exit(1);
  }
  console.log(`\nDeleted ${count} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
