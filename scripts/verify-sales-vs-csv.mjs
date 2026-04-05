/**
 * Compare Bandcamp sales in the DB against a raw CSV export.
 *
 * Usage: node scripts/verify-sales-vs-csv.mjs <csv-file> <band-name>
 *
 * Reports:
 * - Total rows: CSV vs DB
 * - By year: CSV vs DB
 * - Missing years/months
 * - Revenue comparison
 * - Transaction IDs in CSV but not DB
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE env vars"); process.exit(1); }
const sb = createClient(url, key);

const csvPath = process.argv[2];
const bandName = process.argv[3];
if (!csvPath || !bandName) {
  console.error("Usage: node scripts/verify-sales-vs-csv.mjs <csv-file> <band-name>");
  process.exit(1);
}

function parseCSV(text) {
  const lines = text.split("\n");
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]?.trim()] = values[j]?.trim() ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

const SALE_TYPES = new Set(["track", "album", "package", "bundle"]);

async function main() {
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  SALES VERIFICATION: ${bandName}`);
  console.log(`═══════════════════════════════════════════════\n`);

  // Read CSV
  let rawText;
  try {
    rawText = readFileSync(csvPath, "utf-16le");
    if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);
  } catch {
    rawText = readFileSync(csvPath, "utf-8");
  }

  const allRows = parseCSV(rawText);
  const csvSales = allRows.filter(r => SALE_TYPES.has(r["item type"]));

  // Get DB data
  const { data: conn } = await sb.from("bandcamp_connections")
    .select("id").eq("band_name", bandName).single();
  if (!conn) { console.error(`Connection "${bandName}" not found`); process.exit(1); }

  const { count: dbTotal } = await sb.from("bandcamp_sales")
    .select("*", { count: "exact", head: true })
    .eq("connection_id", conn.id);

  // === TOTALS ===
  console.log("─── Totals ───");
  console.log(`  CSV total rows:     ${allRows.length.toLocaleString()}`);
  console.log(`  CSV sale rows:      ${csvSales.length.toLocaleString()}`);
  console.log(`  DB rows:            ${(dbTotal ?? 0).toLocaleString()}`);
  console.log(`  MISSING:            ${(csvSales.length - (dbTotal ?? 0)).toLocaleString()}`);
  console.log(`  Coverage:           ${dbTotal ? Math.round((dbTotal / csvSales.length) * 100) : 0}%`);

  // === BY YEAR ===
  console.log("\n─── By Year ───");
  console.log("  Year".padEnd(10), "CSV".padStart(8), "DB".padStart(8), "Missing".padStart(8), "Coverage");

  const csvByYear = {};
  const csvRevenueByYear = {};
  for (const r of csvSales) {
    const date = r["date"] ?? "";
    let year;
    if (date.includes("/")) {
      const parts = date.split("/");
      year = parts[2]?.split(" ")[0];
      if (year?.length === 2) year = "20" + year;
    } else {
      year = date.slice(0, 4);
    }
    if (!year || year === "NaN") year = "unknown";
    csvByYear[year] = (csvByYear[year] ?? 0) + 1;
    csvRevenueByYear[year] = (csvRevenueByYear[year] ?? 0) + (parseFloat(r["net amount"]) || 0);
  }

  for (const year of Object.keys(csvByYear).sort()) {
    const csvCount = csvByYear[year];
    const { count: dbCount } = await sb.from("bandcamp_sales")
      .select("*", { count: "exact", head: true })
      .eq("connection_id", conn.id)
      .gte("sale_date", year + "-01-01")
      .lt("sale_date", (parseInt(year) + 1) + "-01-01");
    const missing = csvCount - (dbCount ?? 0);
    const pct = dbCount ? Math.round((dbCount / csvCount) * 100) : 0;
    const flag = pct < 50 ? " ← LOW" : pct < 90 ? " ← PARTIAL" : "";
    console.log(`  ${year.padEnd(10)} ${String(csvCount).padStart(8)} ${String(dbCount ?? 0).padStart(8)} ${String(missing).padStart(8)} ${pct}%${flag}`);
  }

  // === REVENUE ===
  console.log("\n─── Revenue ───");
  const csvRevenue = csvSales.reduce((s, r) => s + (parseFloat(r["net amount"]) || 0), 0);
  // Get DB revenue (paginated)
  let dbRevenue = 0;
  let offset = 0;
  while (true) {
    const { data: page } = await sb.from("bandcamp_sales")
      .select("net_amount")
      .eq("connection_id", conn.id)
      .not("net_amount", "is", null)
      .range(offset, offset + 999);
    if (!page?.length) break;
    for (const r of page) dbRevenue += Number(r.net_amount) || 0;
    if (page.length < 1000) break;
    offset += 1000;
  }
  console.log(`  CSV net revenue:    $${csvRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
  console.log(`  DB net revenue:     $${dbRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
  console.log(`  Missing revenue:    $${(csvRevenue - dbRevenue).toLocaleString(undefined, { minimumFractionDigits: 2 })}`);

  // === UNITS ===
  const csvUnits = csvSales.reduce((s, r) => s + (parseInt(r["quantity"]) || 0), 0);
  console.log(`\n  CSV units:          ${csvUnits.toLocaleString()}`);

  // === BY TYPE ===
  console.log("\n─── By Item Type ───");
  const csvTypes = {};
  for (const r of csvSales) { csvTypes[r["item type"]] = (csvTypes[r["item type"]] ?? 0) + 1; }
  for (const [type, count] of Object.entries(csvTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(12)} ${String(count).padStart(8)}`);
  }

  console.log("\n═══════════════════════════════════════════════");
  console.log(`  ${bandName}: ${dbTotal ?? 0} of ${csvSales.length} sales in DB (${dbTotal ? Math.round((dbTotal / csvSales.length) * 100) : 0}%)`);
  console.log("═══════════════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exit(1); });
