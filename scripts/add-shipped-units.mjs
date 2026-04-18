#!/usr/bin/env node
/**
 * Add "Units Shipped (8 wks)" column to leaving-inventory-merged.xlsx
 * by pulling warehouse_shipment_items for Leaving Records over the last 8 weeks.
 *
 * Usage:
 *   node scripts/add-shipped-units.mjs
 */

import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MERGED_XLSX = path.join(__dirname, "output", "leaving-inventory-merged.xlsx");
const OUT_XLSX    = path.join(__dirname, "output", "leaving-inventory-merged.xlsx");

const SUPABASE_URL = "https://yspmgzphxlkcnfalndbh.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? (() => { throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var"); })();
const LEAVING_ORG = "2f6adc0e-7f3b-4ba0-9d91-aa8017dc6d89";

// 8 weeks ago from today (April 15 2026)
const EIGHT_WEEKS_AGO = new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log(`Pulling shipments since ${EIGHT_WEEKS_AGO} for Leaving Records…`);

  // 1. Get all shipment IDs in window
  const { data: shipments, error: sErr } = await supabase
    .from("warehouse_shipments")
    .select("id")
    .eq("org_id", LEAVING_ORG)
    .gte("ship_date", EIGHT_WEEKS_AGO)
    .eq("voided", false);

  if (sErr) throw new Error(`Shipments fetch: ${sErr.message}`);
  console.log(`  ${shipments.length} shipments`);

  if (shipments.length === 0) {
    console.log("No shipments found — nothing to add.");
    return;
  }

  const shipmentIds = shipments.map((s) => s.id);

  // 2. Get all items for those shipments (chunked)
  const CHUNK = 200;
  const allItems = [];
  for (let i = 0; i < shipmentIds.length; i += CHUNK) {
    const chunk = shipmentIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("warehouse_shipment_items")
      .select("sku, quantity")
      .in("shipment_id", chunk);
    if (error) throw new Error(`Items fetch: ${error.message}`);
    allItems.push(...(data ?? []));
  }
  console.log(`  ${allItems.length} shipment line items`);

  // 3. Aggregate: sku → total units shipped
  const unitsBysku = {};
  for (const item of allItems) {
    if (!item.sku) continue;
    unitsBysku[item.sku] = (unitsBysku[item.sku] ?? 0) + (item.quantity ?? 1);
  }
  const uniqueSkus = Object.keys(unitsBysku).length;
  console.log(`  ${uniqueSkus} unique SKUs shipped`);

  // 4. Load existing merged spreadsheet
  console.log("\nLoading merged spreadsheet…");
  const wb = XLSX.readFile(MERGED_XLSX);
  const COL_LABEL = `Units Shipped (8 wks)`;

  // 5. Update all tabs
  let totalMatched = 0;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    console.log(`  Tab "${sheetName}": ${rows.length} rows`);

    let tabMatched = 0;
    const outputRows = rows.map((r) => {
      const sku = r["Bandcamp SKU"];
      const shipped = sku && unitsBysku[sku] != null ? unitsBysku[sku] : "";
      if (shipped !== "") tabMatched++;
      return { ...r, [COL_LABEL]: shipped };
    });

    console.log(`    → ${tabMatched} rows matched a shipped SKU`);
    totalMatched += tabMatched;

    const newWs = XLSX.utils.json_to_sheet(outputRows, {
      header: [...Object.keys(outputRows[0])],
    });
    const headers = Object.keys(outputRows[0]);
    newWs["!cols"] = headers.map((h) => ({
      wch: Math.min(60, Math.max(h.length + 2,
        ...outputRows.slice(0, 50).map((r) => String(r[h] ?? "").length)
      )),
    }));
    wb.Sheets[sheetName] = newWs;
  }

  console.log(`  Total matched: ${totalMatched}`);
  XLSX.writeFile(wb, OUT_XLSX);

  console.log(`\nWritten → ${OUT_XLSX}`);

  // 7. Summary: top shipped SKUs
  console.log("\nTop 15 SKUs by units shipped:");
  const sorted = Object.entries(unitsBysku).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [sku, qty] of sorted) {
    console.log(`  ${sku.padEnd(20)} ${qty} units`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
