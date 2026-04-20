// Phase 12 — Backfill public_track_token for existing shipments.
//
// Walks warehouse_shipments where public_track_token IS NULL, generates a
// fresh 22-char URL-safe random token per row, and stamps it. Idempotent
// (NULL filter + UNIQUE constraint mean re-runs skip already-tokenized rows).
//
// Usage:
//   pnpm tsx scripts/backfill-tracking-tokens.ts --dry-run
//   pnpm tsx scripts/backfill-tracking-tokens.ts            (live)
//   pnpm tsx scripts/backfill-tracking-tokens.ts --limit=500
//   pnpm tsx scripts/backfill-tracking-tokens.ts --workspace=<id>
//
// Safe to re-run; safe to interrupt mid-run.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { generatePublicTrackToken } from "../src/lib/shared/public-track-token";

interface Args {
  dryRun: boolean;
  limit: number;
  workspaceId: string | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { dryRun: false, limit: 5000, workspaceId: null };
  for (const a of args) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--limit=")) out.limit = Number.parseInt(a.slice("--limit=".length), 10);
    else if (a.startsWith("--workspace=")) out.workspaceId = a.slice("--workspace=".length);
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

  console.log(
    `[backfill-tracking-tokens] limit=${args.limit} dryRun=${args.dryRun}${
      args.workspaceId ? ` workspace=${args.workspaceId}` : ""
    }`,
  );

  let q = supabase
    .from("warehouse_shipments")
    .select("id, workspace_id")
    .is("public_track_token", null)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);
  const { data: rows, error } = await q;
  if (error) {
    console.error("FATAL: select failed:", error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log("[backfill-tracking-tokens] nothing to backfill — every shipment has a token");
    return;
  }
  console.log(`[backfill-tracking-tokens] ${rows.length} candidate rows`);
  if (args.dryRun) {
    console.log("[backfill-tracking-tokens] dry-run: would stamp tokens; exiting");
    return;
  }

  let updated = 0;
  let failed = 0;
  // One UPDATE per row so a UNIQUE-collision (extremely unlikely with 128 bits
  // of entropy) doesn't poison the whole batch. Sequential; no concurrency.
  for (const row of rows) {
    const token = generatePublicTrackToken();
    const { error: updErr } = await supabase
      .from("warehouse_shipments")
      .update({
        public_track_token: token,
        public_track_token_generated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .is("public_track_token", null); // racy-safe: only stamp if still NULL
    if (updErr) {
      failed++;
      console.warn(`  ${row.id}: ${updErr.message}`);
    } else {
      updated++;
    }
  }

  console.log(
    `[backfill-tracking-tokens] DONE — updated=${updated}, failed=${failed}, scanned=${rows.length}`,
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
