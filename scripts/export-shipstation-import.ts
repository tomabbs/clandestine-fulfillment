/**
 * scripts/export-shipstation-import.ts
 *
 * CLI wrapper around `src/lib/server/shipstation-export.ts`. The same
 * builder powers the `shipstation-export` Trigger task and the
 * `/admin/settings/shipstation-export` page — keeping all three on a
 * single code path prevents the drift you'd get if each carried its own
 * column-mapping logic.
 *
 * Read-only. No DB writes.
 *
 * Usage:
 *   pnpm tsx scripts/export-shipstation-import.ts                  # full export
 *   pnpm tsx scripts/export-shipstation-import.ts --since=ISO_TS   # incremental
 *
 * Output (writes to disk only — Storage uploads are the Trigger task's job):
 *   reports/shipstation-import/shipstation-products-<ts>.csv
 *   reports/shipstation-import/shipstation-products-<ts>.xlsx
 *   reports/shipstation-import/shipstation-products-summary-<ts>.json
 */

import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildShipstationExport } from "@/lib/server/shipstation-export";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

function parseSince(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--since="));
  if (!arg) return null;
  const v = arg.slice("--since=".length).trim();
  return v.length > 0 ? v : null;
}

async function main() {
  const sinceTs = parseSince();
  const supabase = createServiceRoleClient();

  console.log(`[export-shipstation-import] mode=${sinceTs ? "incremental" : "full"}`);
  if (sinceTs) console.log(`  since: ${sinceTs}`);

  const result = await buildShipstationExport({ supabase, sinceTs });

  const outDir = join(process.cwd(), "reports", "shipstation-import");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const csvPath = join(outDir, `shipstation-products-${stamp}.csv`);
  const xlsxPath = join(outDir, `shipstation-products-${stamp}.xlsx`);
  const summaryPath = join(outDir, `shipstation-products-summary-${stamp}.json`);

  writeFileSync(csvPath, result.csv);
  writeFileSync(xlsxPath, Buffer.from(result.xlsx));
  writeFileSync(
    summaryPath,
    JSON.stringify({ generated_at: new Date().toISOString(), ...result.summary }, null, 2),
  );

  console.log("");
  console.log(`Wrote CSV   : ${csvPath}`);
  console.log(`Wrote XLSX  : ${xlsxPath}`);
  console.log(`Summary JSON: ${summaryPath}`);
  console.log("");
  console.log(`Variants loaded        : ${result.summary.total_variants_loaded}`);
  console.log(`Rows written           : ${result.summary.rows_written}`);
  console.log(`Duplicate SKUs skipped : ${result.summary.duplicates_skipped}`);
  if (result.summary.data_max_ts) {
    console.log(`data_max_ts (next cutoff): ${result.summary.data_max_ts}`);
  }
  console.log("");
  console.log("Per-column coverage (% populated of total rows):");
  const total = result.summary.rows_written;
  for (const [k, n] of Object.entries(result.summary.coverage)) {
    const pct = total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "";
    console.log(`  ${k.padEnd(24)} ${String(n).padStart(5)}  (${pct})`);
  }
}

main().catch((err) => {
  console.error("[export-shipstation-import] FAILED:", err);
  process.exit(1);
});
