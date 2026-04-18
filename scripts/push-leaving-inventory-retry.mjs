#!/usr/bin/env node
/**
 * Retry the 2 failed bands (79 items) by sending items one at a time.
 * For option-level items, fetch option IDs via get_merch_details and push per-option.
 *
 * Usage:
 *   node scripts/push-leaving-inventory-retry.mjs [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SPREADSHEET = path.join(
  "/Users/tomabbs/Downloads",
  "Copy of leaving-inventory-merged.xlsx"
);

const SUPABASE_URL = "https://yspmgzphxlkcnfalndbh.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? (() => { throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var"); })();
const WORKSPACE_ID = "1e59b9ca-ab4e-442b-952b-a649e2aadb0e";
const DRY_RUN = process.argv.includes("--dry-run");

// The 2 failed band IDs
const FAILED_BANDS = [369182255, 1097102857];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getBandcampToken() {
  const { data } = await supabase
    .from("bandcamp_credentials")
    .select("access_token, token_expires_at")
    .eq("workspace_id", WORKSPACE_ID)
    .single();
  if (!data?.access_token) throw new Error("No Bandcamp token");
  const exp = new Date(data.token_expires_at).getTime();
  if (Date.now() > exp - 5 * 60 * 1000) throw new Error("Token too close to expiry");
  return data.access_token;
}

async function fetchMerchDetails(bandId, token) {
  const res = await fetch("https://bandcamp.com/api/merchorders/1/get_merch_details", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ band_id: bandId, start_time: "2000-01-01 00:00:00" }),
  });
  if (!res.ok) throw new Error(`get_merch_details HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`get_merch_details: ${json.error_message}`);
  return json.items ?? [];
}

async function pushSingleItem(payload, token) {
  const res = await fetch("https://bandcamp.com/api/merchorders/1/update_quantities", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [payload] }),
  });
  const json = await res.json();
  return json;
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  // 1. Read spreadsheet to get desired quantities
  const wb = XLSX.readFile(SPREADSHEET);
  const ws = wb.Sheets["All Products"];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const COL = "NEW STOCK LEVELS TO PUSH";
  const qtyByItemId = new Map();
  for (const r of rows) {
    const itemId = Math.round(Number(r["Bandcamp Item ID"]));
    const qty = Math.round(Number(r[COL] ?? 0));
    if (itemId > 0) qtyByItemId.set(itemId, { qty, sku: r["Bandcamp SKU"], merch: r["Merch Name"] });
  }

  // 2. Get mappings for failed bands
  const { data: mappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("bandcamp_item_id, bandcamp_item_type, last_quantity_sold, bandcamp_member_band_id")
    .in("bandcamp_member_band_id", FAILED_BANDS);

  console.log(`Items in failed bands: ${mappings.length}`);

  // 3. Get token and fetch merch details to find option-level items
  const token = await getBandcampToken();
  console.log("Token OK\n");

  // Build option map: package_id → [{ option_id, quantity_sold, quantity_available }]
  const optionMap = new Map();
  for (const bandId of FAILED_BANDS) {
    try {
      const details = await fetchMerchDetails(bandId, token);
      for (const item of details) {
        if (item.options && item.options.length > 0) {
          optionMap.set(item.package_id, item.options.map((o) => ({
            option_id: o.option_id,
            title: o.title ?? "",
            quantity_sold: o.quantity_sold ?? 0,
            quantity_available: o.quantity_available ?? 0,
          })));
        }
      }
      console.log(`  Band ${bandId}: ${details.length} items, ${optionMap.size} have options`);
    } catch (err) {
      console.error(`  Band ${bandId}: get_merch_details failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 4. Push each item
  let pushed = 0;
  let optionPushed = 0;
  let failed = 0;
  let skipped = 0;

  for (const m of mappings) {
    const info = qtyByItemId.get(m.bandcamp_item_id);
    if (!info) { skipped++; continue; }

    const options = optionMap.get(m.bandcamp_item_id);

    if (options && options.length > 0) {
      // Option-level item: push each option with the same quantity
      console.log(`  ${info.sku} (${info.merch}): ${options.length} options → qty=${info.qty}`);
      for (const opt of options) {
        const payload = {
          id: opt.option_id,
          id_type: "o",
          quantity_available: info.qty,
          quantity_sold: opt.quantity_sold,
        };

        if (DRY_RUN) {
          console.log(`    [DRY] option ${opt.option_id} "${opt.title}": qty=${info.qty}`);
          optionPushed++;
          continue;
        }

        const result = await pushSingleItem(payload, token);
        if (result.success) {
          optionPushed++;
          console.log(`    option ${opt.option_id} "${opt.title}": OK`);
        } else {
          failed++;
          console.error(`    option ${opt.option_id} "${opt.title}": FAILED — ${result.error_message ?? JSON.stringify(result)}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } else {
      // Package-level item: push normally
      const payload = {
        id: m.bandcamp_item_id,
        id_type: "p",
        quantity_available: info.qty,
        quantity_sold: m.last_quantity_sold ?? 0,
      };

      if (DRY_RUN) {
        console.log(`  [DRY] ${info.sku} (${info.merch}): pkg ${m.bandcamp_item_id} → qty=${info.qty}`);
        pushed++;
        continue;
      }

      const result = await pushSingleItem(payload, token);
      if (result.success) {
        pushed++;
        console.log(`  ${info.sku} (${info.merch}): OK`);
      } else {
        const msg = result.error_message ?? JSON.stringify(result);
        if (msg.includes("option level")) {
          console.log(`  ${info.sku} (${info.merch}): option-level but no options found in get_merch_details — skipping`);
          skipped++;
        } else {
          failed++;
          console.error(`  ${info.sku} (${info.merch}): FAILED — ${msg}`);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`  Package-level pushed: ${pushed}`);
  console.log(`  Option-level pushed:  ${optionPushed}`);
  console.log(`  Failed:               ${failed}`);
  console.log(`  Skipped:              ${skipped}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
