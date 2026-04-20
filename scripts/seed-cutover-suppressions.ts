// Phase 12 cutover helper — seed `notification_sends` rows with status='suppressed'
// for every shipment that's already been marked-shipped on SS BEFORE we flip
// `email_send_strategy` to 'shadow' or 'unified_resend'. Without this, the
// recon cron would treat them as missing and fire a retroactive Shipment
// Confirmation email — which would jar customers who shipped weeks ago.
//
// Usage:
//   pnpm tsx scripts/seed-cutover-suppressions.ts --dry-run
//   pnpm tsx scripts/seed-cutover-suppressions.ts            (live)
//   pnpm tsx scripts/seed-cutover-suppressions.ts --workspace=<id>
//
// Idempotent: ON CONFLICT DO NOTHING via the partial UNIQUE index on
// notification_sends. Safe to re-run; safe to interrupt.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

interface Args {
  dryRun: boolean;
  workspaceId: string | null;
  /** Lookback window (days). Default 7 — matches the recon cron's lookback. */
  days: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { dryRun: false, workspaceId: null, days: 7 };
  for (const a of args) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--workspace=")) out.workspaceId = a.slice("--workspace=".length);
    else if (a.startsWith("--days=")) out.days = Number.parseInt(a.slice("--days=".length), 10);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const sinceIso = new Date(Date.now() - args.days * 86400000).toISOString();
  console.log(
    `[seed-cutover-suppressions] window=${args.days}d (since ${sinceIso}) dryRun=${args.dryRun}${
      args.workspaceId ? ` workspace=${args.workspaceId}` : ""
    }`,
  );

  // Find shipments that are already marked-shipped on SS but have no
  // notification_sends row for trigger_status='shipped'. Those are the
  // candidates the recon cron WOULD retroactively email if we flip strategy.
  let q = supabase
    .from("warehouse_shipments")
    .select("id, workspace_id")
    .not("shipstation_marked_shipped_at", "is", null)
    .gte("shipstation_marked_shipped_at", sinceIso)
    .eq("suppress_emails", false);
  if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);

  const { data: shipments, error } = await q.limit(20000);
  if (error) {
    console.error("FATAL: select failed:", error.message);
    process.exit(1);
  }
  if (!shipments || shipments.length === 0) {
    console.log("[seed-cutover-suppressions] no candidates found");
    return;
  }
  const ids = shipments.map((s) => s.id as string);

  // Load existing notification_sends rows for the candidates so we don't
  // re-INSERT for shipments already accounted for.
  const { data: existing } = await supabase
    .from("notification_sends")
    .select("shipment_id")
    .in("shipment_id", ids)
    .eq("trigger_status", "shipped");
  const haveSendRow = new Set((existing ?? []).map((r) => r.shipment_id as string));

  const toInsert = shipments
    .filter((s) => !haveSendRow.has(s.id as string))
    .map((s) => ({
      workspace_id: s.workspace_id as string,
      shipment_id: s.id as string,
      trigger_status: "shipped",
      channel: "email",
      template_id: "shipped",
      recipient: "(in-flight at cutover)",
      status: "suppressed" as const,
      error: "Inserted by seed-cutover-suppressions.ts to prevent retroactive Shipment Confirmation",
    }));

  console.log(
    `[seed-cutover-suppressions] candidates=${shipments.length}; already accounted=${haveSendRow.size}; will insert=${toInsert.length}`,
  );
  if (args.dryRun || toInsert.length === 0) {
    if (args.dryRun) console.log("[seed-cutover-suppressions] dry-run — exiting");
    return;
  }

  // Insert in chunks to avoid request size limits.
  const CHUNK = 500;
  let inserted = 0;
  let failed = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    const { error: insErr, count } = await supabase
      .from("notification_sends")
      .insert(slice, { count: "exact" });
    if (insErr) {
      // 23505 = some rows already exist; we filter above but a race could happen.
      if (insErr.code === "23505") {
        console.log(`  chunk ${i / CHUNK + 1}: some duplicates skipped (acceptable)`);
        continue;
      }
      failed += slice.length;
      console.warn(`  chunk ${i / CHUNK + 1}: ${insErr.message}`);
    } else {
      inserted += count ?? slice.length;
    }
  }
  console.log(
    `[seed-cutover-suppressions] DONE — inserted=${inserted}, failed=${failed}, candidates=${shipments.length}`,
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
