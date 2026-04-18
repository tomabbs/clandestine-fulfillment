#!/usr/bin/env node
/**
 * Push inventory levels from the reviewed spreadsheet to Bandcamp + our DB.
 *
 * Reads "NEW STOCK LEVELS TO PUSH" from the spreadsheet, then:
 *   1. Calls Bandcamp API updateQuantities per band (grouped by band_id)
 *   2. Updates bandcamp_product_mappings.raw_api_data→quantity_available in our DB
 *
 * Usage:
 *   node scripts/push-leaving-inventory.mjs [--dry-run]
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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getBandcampToken() {
  const { data, error } = await supabase
    .from("bandcamp_credentials")
    .select("access_token, token_expires_at")
    .eq("workspace_id", WORKSPACE_ID)
    .single();
  if (error || !data?.access_token) throw new Error("No Bandcamp token found");

  const expiresAt = new Date(data.token_expires_at).getTime();
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    throw new Error(
      `Bandcamp token expires at ${data.token_expires_at} — too close to expiry. ` +
      `Trigger a bandcamp-sync task first to refresh it.`
    );
  }
  return data.access_token;
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no API calls)" : "LIVE — pushing to Bandcamp"}\n`);

  // 1. Read spreadsheet
  console.log("Reading spreadsheet…");
  const wb = XLSX.readFile(SPREADSHEET);
  const ws = wb.Sheets["All Products"];
  if (!ws) throw new Error("Sheet 'All Products' not found");
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const COL = "NEW STOCK LEVELS TO PUSH";
  const items = rows
    .filter((r) => r["Bandcamp Item ID"] != null && r["Bandcamp Item ID"] !== "")
    .map((r) => ({
      sku: r["Bandcamp SKU"],
      itemId: Math.round(Number(r["Bandcamp Item ID"])),
      newQty: Math.max(0, Math.round(Number(r[COL] ?? 0))),
      merchName: r["Merch Name"],
    }))
    .filter((r) => !isNaN(r.itemId) && r.itemId > 0);

  console.log(`  ${items.length} items to push`);
  const nonZero = items.filter((i) => i.newQty > 0);
  const zeros = items.filter((i) => i.newQty === 0);
  console.log(`  ${nonZero.length} with stock > 0, ${zeros.length} zeroed out`);
  const totalUnits = items.reduce((s, i) => s + i.newQty, 0);
  console.log(`  Total units: ${totalUnits}\n`);

  // 2. Get quantity_sold from our DB for each item
  console.log("Fetching current quantity_sold from DB…");
  const CHUNK = 200;
  const allMappings = [];
  const allItemIds = items.map((i) => i.itemId);
  for (let i = 0; i < allItemIds.length; i += CHUNK) {
    const chunk = allItemIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("bandcamp_product_mappings")
      .select("bandcamp_item_id, bandcamp_item_type, last_quantity_sold, bandcamp_member_band_id")
      .in("bandcamp_item_id", chunk);
    if (error) throw new Error(`DB fetch: ${error.message}`);
    allMappings.push(...(data ?? []));
  }

  const mappingsByItemId = Object.fromEntries(
    allMappings.map((m) => [m.bandcamp_item_id, m])
  );
  console.log(`  Found ${allMappings.length} mappings in DB\n`);

  // 3. Build API payloads grouped by band_id
  const byBand = new Map();
  const skippedNoMapping = [];

  for (const item of items) {
    const mapping = mappingsByItemId[item.itemId];
    if (!mapping) {
      skippedNoMapping.push(item);
      continue;
    }

    const bandId = mapping.bandcamp_member_band_id;
    if (!byBand.has(bandId)) byBand.set(bandId, []);
    byBand.get(bandId).push({
      item_id: item.itemId,
      item_type: mapping.bandcamp_item_type || "package",
      quantity_available: item.newQty,
      quantity_sold: mapping.last_quantity_sold ?? 0,
      // metadata for logging
      _sku: item.sku,
      _merch: item.merchName,
    });
  }

  console.log(`Grouped into ${byBand.size} bands`);
  if (skippedNoMapping.length > 0) {
    console.log(`Skipped ${skippedNoMapping.length} items (no DB mapping):`);
    for (const s of skippedNoMapping.slice(0, 10)) {
      console.log(`  ${s.sku} (item_id: ${s.itemId})`);
    }
  }

  // 4. Get token
  const token = await getBandcampToken();
  console.log("Bandcamp token OK\n");

  // 5. Push to Bandcamp API
  let bandsPushed = 0;
  let bandErrors = 0;
  let itemsPushed = 0;
  const errors = [];

  for (const [bandId, bandItems] of byBand) {
    const apiPayload = bandItems.map((i) => ({
      id: i.item_id,
      id_type: "p",
      quantity_available: i.quantity_available,
      quantity_sold: i.quantity_sold,
    }));

    if (DRY_RUN) {
      console.log(`  [DRY] Band ${bandId}: ${bandItems.length} items`);
      for (const i of bandItems.slice(0, 3)) {
        console.log(`    ${i._sku}: qty=${i.quantity_available}`);
      }
      if (bandItems.length > 3) console.log(`    … +${bandItems.length - 3} more`);
      bandsPushed++;
      itemsPushed += bandItems.length;
      continue;
    }

    try {
      const response = await fetch(
        "https://bandcamp.com/api/merchorders/1/update_quantities",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ items: apiPayload }),
        }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      const json = await response.json();
      if (json.error) {
        const msg = json.error_message ?? JSON.stringify(json);
        // If a single option-level item poisons the batch, retry without it
        if (msg.includes("option level")) {
          // Extract the problematic package ID
          const match = msg.match(/package (\d+)/);
          const badId = match ? Number(match[1]) : null;
          if (badId) {
            const filtered = apiPayload.filter((i) => i.id !== badId);
            if (filtered.length > 0) {
              const retry = await fetch(
                "https://bandcamp.com/api/merchorders/1/update_quantities",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ items: filtered }),
                }
              );
              const rj = await retry.json();
              if (rj.success) {
                bandsPushed++;
                itemsPushed += filtered.length;
                console.log(`  Band ${bandId}: ${filtered.length}/${bandItems.length} items pushed OK (skipped option-level item ${badId})`);
                continue;
              }
            }
          }
        }
        throw new Error(`API error: ${msg}`);
      }

      bandsPushed++;
      itemsPushed += bandItems.length;
      console.log(`  Band ${bandId}: ${bandItems.length} items pushed OK`);
    } catch (err) {
      bandErrors++;
      errors.push({ bandId, count: bandItems.length, error: err.message });
      console.error(`  Band ${bandId}: FAILED — ${err.message}`);
    }

    // Rate limit: 150ms between API calls
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`\n--- Bandcamp API Results ---`);
  console.log(`  Bands pushed:  ${bandsPushed}`);
  console.log(`  Bands failed:  ${bandErrors}`);
  console.log(`  Items pushed:  ${itemsPushed}`);

  if (DRY_RUN) {
    console.log("\nDRY RUN — no Bandcamp API calls or DB writes performed.");
    return;
  }

  // 6. Update our DB: raw_api_data→quantity_available
  console.log("\nUpdating our database…");
  let dbUpdated = 0;
  let dbErrors = 0;

  for (const item of items) {
    const mapping = mappingsByItemId[item.itemId];
    if (!mapping) continue;

    const { data: current, error: fetchErr } = await supabase
      .from("bandcamp_product_mappings")
      .select("id, raw_api_data")
      .eq("bandcamp_item_id", item.itemId)
      .single();

    if (fetchErr || !current) { dbErrors++; continue; }

    const updatedRaw = { ...(current.raw_api_data ?? {}), quantity_available: item.newQty };
    const { error: uErr } = await supabase
      .from("bandcamp_product_mappings")
      .update({
        raw_api_data: updatedRaw,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", current.id);

    if (uErr) {
      dbErrors++;
      if (dbErrors <= 3) console.error(`  DB error: ${uErr.message}`);
    } else {
      dbUpdated++;
    }
  }

  console.log(`  DB rows updated: ${dbUpdated}`);
  if (dbErrors > 0) console.log(`  DB errors: ${dbErrors}`);

  console.log("\nDone.");
  if (errors.length > 0) {
    console.log("\nFailed bands:");
    for (const e of errors) {
      console.log(`  Band ${e.bandId} (${e.count} items): ${e.error}`);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
