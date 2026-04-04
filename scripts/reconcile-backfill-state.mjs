/**
 * One-off reconciliation: recompute bandcamp_sales_backfill_state
 * from canonical bandcamp_sales rows.
 *
 * Fixes the counter bug where total_transactions was reset to 0 by
 * the old upsert pattern on every cron run.
 *
 * Usage: node scripts/reconcile-backfill-state.mjs [--dry-run]
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const dryRun = process.argv.includes("--dry-run");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE env vars"); process.exit(1); }
const sb = createClient(url, key);

async function main() {
  console.log(`Reconciling backfill state${dryRun ? " (DRY RUN)" : ""}...\n`);

  const { data: states } = await sb.from("bandcamp_sales_backfill_state").select("*");
  if (!states?.length) {
    console.log("No backfill state rows found.");
    return;
  }

  for (const state of states) {
    const { count } = await sb
      .from("bandcamp_sales")
      .select("*", { count: "exact", head: true })
      .eq("connection_id", state.connection_id);

    const { data: minRow } = await sb
      .from("bandcamp_sales")
      .select("sale_date")
      .eq("connection_id", state.connection_id)
      .order("sale_date", { ascending: true })
      .limit(1);

    const { data: maxRow } = await sb
      .from("bandcamp_sales")
      .select("sale_date")
      .eq("connection_id", state.connection_id)
      .order("sale_date", { ascending: false })
      .limit(1);

    const actualCount = count ?? 0;
    const earliest = minRow?.[0]?.sale_date ?? null;
    const latest = maxRow?.[0]?.sale_date ?? null;

    const drift = state.total_transactions !== actualCount;
    const symbol = drift ? "DRIFT" : "OK";

    console.log(`[${symbol}] connection=${state.connection_id}`);
    console.log(`  state.total_transactions=${state.total_transactions} actual=${actualCount}`);
    console.log(`  state.earliest=${state.earliest_sale_date} actual=${earliest}`);
    console.log(`  state.latest=${state.latest_sale_date} actual=${latest}`);
    console.log(`  status=${state.status} last_processed=${state.last_processed_date}`);

    if (drift && !dryRun) {
      const { error } = await sb.from("bandcamp_sales_backfill_state").update({
        total_transactions: actualCount,
        earliest_sale_date: earliest,
        latest_sale_date: latest,
        updated_at: new Date().toISOString(),
      }).eq("connection_id", state.connection_id);

      if (error) {
        console.log(`  UPDATE FAILED: ${error.message}`);
      } else {
        console.log(`  RECONCILED: total_transactions set to ${actualCount}`);
      }
    }
    console.log();
  }

  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
