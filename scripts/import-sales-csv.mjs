/**
 * Import Bandcamp sales from raw CSV export files.
 *
 * Usage: node scripts/import-sales-csv.mjs <csv-file> <band-name>
 * Example: node scripts/import-sales-csv.mjs ~/Downloads/northern-spy.csv "Northern Spy Records"
 *
 * Handles UTF-16 encoding (Bandcamp's default export format).
 * Skips payout, refund, reversal rows. Filters non-numeric transaction IDs.
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
  console.error("Usage: node scripts/import-sales-csv.mjs <csv-file> <band-name>");
  process.exit(1);
}

function parseCSV(text) {
  const lines = text.split("\n");
  if (lines.length < 2) return [];

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

function safeBigint(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

function safeFloat(val) {
  if (!val) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function safeInt(val) {
  if (!val) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  try { return new Date(dateStr).toISOString(); } catch { return null; }
}

const SALE_TYPES = new Set(["track", "album", "package", "bundle"]);

async function main() {
  console.log(`Importing ${csvPath} for "${bandName}"...\n`);

  // Read CSV (try UTF-16 first, fall back to UTF-8)
  let rawText;
  try {
    rawText = readFileSync(csvPath, "utf-16le");
    if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1); // BOM
  } catch {
    rawText = readFileSync(csvPath, "utf-8");
  }

  const rows = parseCSV(rawText);
  console.log(`Parsed ${rows.length} total rows`);

  // Filter to sale types only
  const sales = rows.filter(r => SALE_TYPES.has(r["item type"]));
  console.log(`Importable sales: ${sales.length}`);

  // Filter out non-numeric transaction IDs
  const valid = sales.filter(r => safeBigint(r["bandcamp transaction id"]) !== null);
  console.log(`With valid transaction IDs: ${valid.length}`);

  // Get connection
  const { data: conn } = await sb.from("bandcamp_connections")
    .select("id, workspace_id")
    .eq("band_name", bandName)
    .single();
  if (!conn) { console.error(`Connection "${bandName}" not found`); process.exit(1); }
  console.log(`Connection: ${conn.id}`);

  // Delete existing sales for this connection (full re-import)
  const { count: existing } = await sb.from("bandcamp_sales")
    .select("*", { count: "exact", head: true })
    .eq("connection_id", conn.id);
  if (existing > 0) {
    console.log(`Deleting ${existing} existing sales for clean re-import...`);
    // Delete in batches to avoid timeouts
    let deleted = 0;
    while (deleted < existing) {
      const { data: batch } = await sb.from("bandcamp_sales")
        .select("id")
        .eq("connection_id", conn.id)
        .limit(1000);
      if (!batch?.length) break;
      await sb.from("bandcamp_sales")
        .delete()
        .in("id", batch.map(r => r.id));
      deleted += batch.length;
      process.stdout.write(`  deleted ${deleted}/${existing}\r`);
    }
    console.log(`  deleted ${deleted} rows`);
  }

  // Insert in batches
  let inserted = 0;
  let errors = 0;
  const batchSize = 100;

  for (let i = 0; i < valid.length; i += batchSize) {
    const batch = valid.slice(i, i + batchSize);
    const dbRows = batch.map(r => ({
      workspace_id: conn.workspace_id,
      connection_id: conn.id,
      bandcamp_transaction_id: safeBigint(r["bandcamp transaction id"]),
      bandcamp_transaction_item_id: safeBigint(r["bandcamp transaction id"]) * 10 + (safeInt(r["quantity"]) ?? 1),
      sale_date: parseDate(r["date"]),
      item_type: r["item type"] || null,
      item_name: r["item name"] || null,
      artist: r["artist"] || null,
      package: r["package"] || null,
      option_name: r["option"] || null,
      sku: r["sku"] || null,
      catalog_number: r["catalog number"] || null,
      upc: r["upc"] || null,
      isrc: r["isrc"] || null,
      item_url: r["item url"] || null,
      currency: r["currency"] || null,
      item_price: safeFloat(r["item price"]),
      quantity: safeInt(r["quantity"]),
      sub_total: safeFloat(r["sub total"]),
      shipping: safeFloat(r["shipping"]),
      seller_tax: safeFloat(r["seller tax"]),
      marketplace_tax: safeFloat(r["marketplace tax"]),
      tax_rate: safeFloat(r["tax rate"]),
      transaction_fee: safeFloat(r["transaction fee"]),
      fee_type: r["fee type"] || null,
      item_total: safeFloat(r["item total"]),
      amount_received: safeFloat(r["amount you received"]),
      net_amount: safeFloat(r["net amount"]),
      additional_fan_contribution: safeFloat(r["additional fan contribution"]),
      discount_code: r["discount code"] || null,
      collection_society_share: safeFloat(r["collection society share"]),
      buyer_name: r["buyer name"] || null,
      buyer_email: r["buyer email"] || null,
      buyer_phone: r["buyer phone"] || null,
      buyer_note: r["buyer note"] || null,
      ship_to_name: r["ship to name"] || null,
      ship_to_street: r["ship to street"] || null,
      ship_to_street_2: r["ship to street 2"] || null,
      ship_to_city: r["ship to city"] || null,
      ship_to_state: r["ship to state"] || null,
      ship_to_zip: r["ship to zip"] || null,
      ship_to_country: r["ship to country"] || null,
      ship_to_country_code: r["ship to country code"] || null,
      ship_date: parseDate(r["ship date"]),
      ship_notes: r["ship notes"] || null,
      ship_from_country_name: r["ship from country name"] || null,
      paid_to: r["paid to"] || null,
      payment_state: null,
      referer: r["referrer"] || null,
      referer_url: r["referrer url"] || null,
      country: r["country"] || null,
      country_code: r["country code"] || null,
      region_or_state: r["region/state"] || null,
      city: r["city"] || null,
      paypal_transaction_id: r["paypal transaction id"] || null,
    }));

    const { error } = await sb.from("bandcamp_sales").upsert(dbRows, {
      onConflict: "workspace_id,bandcamp_transaction_id,bandcamp_transaction_item_id",
      ignoreDuplicates: false,
    });

    if (error) {
      // Try one-by-one for the batch to find the bad row
      for (const row of dbRows) {
        const { error: singleErr } = await sb.from("bandcamp_sales").upsert([row], {
          onConflict: "workspace_id,bandcamp_transaction_id,bandcamp_transaction_item_id",
          ignoreDuplicates: false,
        });
        if (singleErr) errors++;
        else inserted++;
      }
    } else {
      inserted += batch.length;
    }

    if ((i + batchSize) % 1000 === 0 || i + batchSize >= valid.length) {
      process.stdout.write(`  ${inserted} inserted, ${errors} errors (${Math.round((i / valid.length) * 100)}%)\r`);
    }
  }

  console.log(`\n\nDone: ${inserted} inserted, ${errors} errors`);

  // Update backfill state
  const { count: finalCount } = await sb.from("bandcamp_sales")
    .select("*", { count: "exact", head: true })
    .eq("connection_id", conn.id);

  await sb.from("bandcamp_sales_backfill_state").upsert({
    connection_id: conn.id,
    workspace_id: conn.workspace_id,
    status: "completed",
    total_transactions: finalCount ?? 0,
    last_processed_date: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "connection_id" });

  console.log(`Backfill state updated: ${finalCount} total sales for ${bandName}`);
}

main().catch(e => { console.error(e); process.exit(1); });
