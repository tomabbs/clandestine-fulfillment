#!/usr/bin/env node
/**
 * Export full Leaving Records merch list from Bandcamp product mappings.
 *
 * Outputs:
 *   - scripts/output/leaving-merch-list.csv   (machine-friendly)
 *   - scripts/output/leaving-merch-list.xlsx  (human-friendly spreadsheet)
 *
 * Columns:
 *   SKU | Artist | Merch Title | Format | Bandcamp URL | Bandcamp Item ID
 *
 * Usage:
 *   node scripts/export-leaving-merch-list.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://yspmgzphxlkcnfalndbh.supabase.co";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? (() => { throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var"); })();

const LEAVING_ORG_ID = "2f6adc0e-7f3b-4ba0-9d91-aa8017dc6d89";
const WORKSPACE_ID = "1e59b9ca-ab4e-442b-952b-a649e2aadb0e";
const CHUNK = 200;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Get a fresh Bandcamp access token from bandcamp_credentials.
 * Returns the stored token if still valid; does NOT refresh (no refresh_token call here).
 */
async function getBandcampToken(supabase) {
  const { data, error } = await supabase
    .from("bandcamp_credentials")
    .select("access_token, token_expires_at")
    .eq("workspace_id", WORKSPACE_ID)
    .single();
  if (error || !data?.access_token) throw new Error("No valid Bandcamp token found");
  return data.access_token;
}

/**
 * Call Bandcamp getMerchDetails for one band_id.
 * Returns array of { package_id, quantity_available }.
 */
async function fetchBandcampStock(bandId, accessToken) {
  const response = await fetch("https://bandcamp.com/api/merchorders/1/get_merch_details", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ band_id: bandId, start_time: "2000-01-01 00:00:00" }),
  });
  if (!response.ok) {
    throw new Error(`getMerchDetails HTTP ${response.status} for band ${bandId}`);
  }
  const json = await response.json();
  if (json.error) throw new Error(`getMerchDetails API error for band ${bandId}: ${json.error_message}`);
  return (json.items ?? []).map((item) => ({
    package_id: item.package_id,
    quantity_available: item.quantity_available ?? null,
  }));
}

/**
 * Parse "Artist Name - Release Title [Format]" → { artist, title }
 * Falls back to raw title if no separator found.
 */
function parseArtistAndTitle(rawTitle) {
  if (!rawTitle) return { artist: "", title: "" };
  const t = rawTitle.trim();
  const idx = t.indexOf(" - ");
  if (idx === -1) return { artist: "", title: t };
  return {
    artist: t.slice(0, idx).trim(),
    title: t.slice(idx + 3).trim(),
  };
}

async function main() {
  console.log("Fetching Leaving Records products…");

  // 1. Get all products for Leaving Records
  const { data: products, error: prodErr } = await supabase
    .from("warehouse_products")
    .select("id, title")
    .eq("org_id", LEAVING_ORG_ID);

  if (prodErr) throw new Error(`Products fetch failed: ${prodErr.message}`);
  console.log(`  Found ${products.length} products`);

  const productMap = Object.fromEntries(products.map((p) => [p.id, p.title]));
  const productIds = products.map((p) => p.id);

  // 2. Get all variants for those products (chunked — .in() URL length limit)
  console.log("Fetching variants…");
  const allVariants = [];
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const chunk = productIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, product_id")
      .in("product_id", chunk);
    if (error) throw new Error(`Variants fetch failed: ${error.message}`);
    allVariants.push(...(data ?? []));
  }
  const variants = allVariants;
  console.log(`  Found ${variants.length} variants`);

  const variantMap = Object.fromEntries(variants.map((v) => [v.id, v]));
  const variantIds = variants.map((v) => v.id);

  // 3. Get Bandcamp product mappings for those variants
  console.log("Fetching Bandcamp product mappings…");
  const allMappings = [];
  for (let i = 0; i < variantIds.length; i += CHUNK) {
    const chunk = variantIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("bandcamp_product_mappings")
      .select(
        "variant_id, bandcamp_item_id, bandcamp_member_band_id, bandcamp_album_title, bandcamp_type_name, bandcamp_url, last_synced_at, raw_api_data"
      )
      .in("variant_id", chunk);
    if (error) throw new Error(`Mappings fetch failed: ${error.message}`);
    allMappings.push(...(data ?? []));
  }
  console.log(`  Found ${allMappings.length} Bandcamp mappings`);

  // 4. Build stock map — primary: raw_api_data.quantity_available (synced today from Bandcamp)
  //    Override: live getMerchDetails call for bands where we have admin access
  console.log("\nBuilding stock from synced Bandcamp data…");

  // package_id (number) → { qty, source }
  const stockMap = new Map();
  for (const m of allMappings) {
    const qty = m.raw_api_data?.quantity_available ?? null;
    if (qty !== null && m.bandcamp_item_id) {
      stockMap.set(m.bandcamp_item_id, { qty, source: "synced" });
    }
  }
  console.log(`  ${stockMap.size} items from today's sync`);

  // Try live API for bands where the account has admin access
  console.log("  Overlaying live stock for admin-accessible bands…");
  const token = await getBandcampToken(supabase);
  const uniqueBandIds = [...new Set(
    allMappings.map((m) => m.bandcamp_member_band_id).filter(Boolean)
  )];

  let liveOverrides = 0;
  let bandErrors = 0;
  for (const bandId of uniqueBandIds) {
    try {
      const items = await fetchBandcampStock(bandId, token);
      for (const item of items) {
        stockMap.set(item.package_id, { qty: item.quantity_available, source: "live" });
        liveOverrides++;
      }
    } catch {
      bandErrors++;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`  Live overrides: ${liveOverrides} items (${uniqueBandIds.length - bandErrors} admin bands)`);
  console.log();

  // 5. Build rows
  const rows = allMappings.map((m) => {
    const raw = m.raw_api_data ?? {};
    // SKU and package title come from Bandcamp's own raw_api_data
    const bandcampSku = raw.sku ?? "";
    const packageName = raw.title ?? "";          // e.g. "VINYL", "CASSETTE", "TEST PRESSING"
    const albumTitle = m.bandcamp_album_title ?? raw.album_title ?? "";

    // Parse artist from our product title (most reliable source for label/artist split)
    const variant = variantMap[m.variant_id];
    const rawProductTitle = variant ? productMap[variant.product_id] ?? "" : "";
    const { artist } = parseArtistAndTitle(rawProductTitle);

    const stockEntry = stockMap.get(m.bandcamp_item_id);
    const stockQty = stockEntry?.qty ?? "";

    return {
      "Bandcamp SKU": bandcampSku,
      "Artist": artist,
      "Album Title": albumTitle,
      "Merch Name": packageName,                   // VINYL / CASSETTE / TEST PRESSING
      "Stock on Bandcamp": stockQty,
      "Bandcamp URL": m.bandcamp_url ?? "",
      "Bandcamp Item ID": m.bandcamp_item_id ?? "",
    };
  });

  // Sort: artist A→Z, then album A→Z, then merch name A→Z
  rows.sort((a, b) => {
    const ac = (a["Artist"] ?? "").localeCompare(b["Artist"] ?? "");
    if (ac !== 0) return ac;
    const bc = (a["Album Title"] ?? "").localeCompare(b["Album Title"] ?? "");
    if (bc !== 0) return bc;
    return (a["Merch Name"] ?? "").localeCompare(b["Merch Name"] ?? "");
  });

  // 5. Write output
  const outputDir = path.join(__dirname, "output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // CSV
  const csvPath = path.join(outputDir, "leaving-merch-list.csv");
  const headers = Object.keys(rows[0] ?? {});
  const csvLines = [
    headers.join(","),
    ...rows.map((r) =>
      headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")
    ),
  ];
  fs.writeFileSync(csvPath, csvLines.join("\n"), "utf8");
  console.log(`\nCSV written → ${csvPath}`);

  // XLSX
  const xlsxPath = path.join(outputDir, "leaving-merch-list.xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });

  // Auto-size columns
  const colWidths = headers.map((h) => ({
    wch: Math.max(
      h.length,
      ...rows.map((r) => String(r[h] ?? "").length)
    ),
  }));
  ws["!cols"] = colWidths;

  XLSX.utils.book_append_sheet(wb, ws, "Leaving Records Merch");
  XLSX.writeFile(wb, xlsxPath);
  console.log(`XLSX written → ${xlsxPath}`);

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`Total items:  ${rows.length}`);
  const byMerch = {};
  for (const r of rows) {
    byMerch[r["Merch Name"]] = (byMerch[r["Merch Name"]] ?? 0) + 1;
  }
  const sorted = Object.entries(byMerch).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`  ${name || "(no name)"}: ${count}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
