// Phase 10.2 — One-time EasyPost tracker backfill.
//
// Enumerates active warehouse_shipments (last 60d, status NOT IN
// delivered/voided) and creates EP trackers for any without a registered
// tracker (`label_data.easypost_tracker_id` IS NULL). Stamps the EP id on
// success.
//
// Safe to re-run — `Tracker.create` is idempotent on (carrier, tracking_code)
// in EP for 3 months and we short-circuit when the local stamp is already
// present. Use `--dry-run` to see what would be registered.
//
// Usage:
//   pnpm tsx scripts/easypost-tracker-backfill.ts --dry-run
//   pnpm tsx scripts/easypost-tracker-backfill.ts            (live)
//   pnpm tsx scripts/easypost-tracker-backfill.ts --days=90  (custom window)
//   pnpm tsx scripts/easypost-tracker-backfill.ts --workspace=<id>

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { createTracker } from "../src/lib/clients/easypost-client";

interface Args {
  dryRun: boolean;
  days: number;
  workspaceId: string | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { dryRun: false, days: 60, workspaceId: null };
  for (const a of args) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--days=")) out.days = Number.parseInt(a.slice("--days=".length), 10);
    else if (a.startsWith("--workspace=")) out.workspaceId = a.slice("--workspace=".length);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key);

  const sinceIso = new Date(Date.now() - args.days * 86400000).toISOString();
  console.log(
    `[ep-tracker-backfill] window: ${args.days}d (since ${sinceIso}) dryRun=${args.dryRun}${
      args.workspaceId ? ` workspace=${args.workspaceId}` : ""
    }`,
  );

  let q = supabase
    .from("warehouse_shipments")
    .select("id, workspace_id, tracking_number, carrier, status, label_data")
    .not("tracking_number", "is", null)
    .gte("created_at", sinceIso)
    .not("status", "in", "(delivered,voided)")
    .limit(2000);
  if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
  const { data: shipments, error } = await q;
  if (error) throw new Error(`fetch failed: ${error.message}`);

  const candidates = (shipments ?? []).filter((s) => {
    const ld = (s.label_data ?? {}) as Record<string, unknown>;
    return typeof ld.easypost_tracker_id !== "string";
  });
  console.log(
    `[ep-tracker-backfill] eligible: ${shipments?.length ?? 0}; missing tracker: ${candidates.length}`,
  );
  if (candidates.length === 0 || args.dryRun) {
    if (args.dryRun) {
      for (const s of candidates.slice(0, 20)) {
        console.log(
          `  would register ${s.tracking_number} via ${s.carrier ?? "auto-detect"} (shipment ${s.id})`,
        );
      }
      if (candidates.length > 20) console.log(`  …and ${candidates.length - 20} more`);
    }
    return;
  }

  let registered = 0;
  let failed = 0;
  let already = 0;
  for (const s of candidates) {
    try {
      const tracker = await createTracker({
        trackingCode: s.tracking_number as string,
        carrier: (s.carrier as string | null) ?? undefined,
      });
      const ld = (s.label_data ?? {}) as Record<string, unknown>;
      const { error: updErr } = await supabase
        .from("warehouse_shipments")
        .update({
          label_data: {
            ...ld,
            easypost_tracker_id: tracker.id,
            easypost_tracker_status: tracker.status,
            easypost_public_url: tracker.public_url,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", s.id);
      if (updErr) {
        failed++;
        console.warn(`  stamp failed for ${s.id}: ${updErr.message}`);
      } else {
        registered++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // EP returns 422 with "tracking_code already exists" when re-registering
      // outside the 3-month idempotency window; treat as success.
      if (msg.toLowerCase().includes("already exists")) {
        already++;
      } else {
        failed++;
        console.warn(`  register failed for ${s.id} (${s.tracking_number}): ${msg.slice(0, 80)}`);
      }
    }
  }

  console.log(
    `[ep-tracker-backfill] DONE — registered: ${registered}, already-existed: ${already}, failed: ${failed}`,
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
