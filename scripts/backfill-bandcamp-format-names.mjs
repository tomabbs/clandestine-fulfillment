#!/usr/bin/env node
/**
 * Backfill correct format data from Bandcamp raw_api_data.title.
 *
 * Problem: bandcamp_type_name was stored once at mapping time and is wrong for many
 * items (e.g. cassettes labeled "Vinyl LP", shirts labeled "Other").
 * raw_api_data.title is the authoritative Bandcamp package name (VINYL, CASSETTE, etc.)
 *
 * This script:
 *   1. Reads raw_api_data.title for every bandcamp_product_mapping
 *   2. Normalizes it to a canonical format_name key from warehouse_format_costs
 *   3. Updates bandcamp_product_mappings.bandcamp_type_name
 *   4. Updates warehouse_product_variants.format_name via variant_id
 *
 * Canonical keys (from warehouse_format_costs):
 *   LP | 7" | CD | Cassette | Shirt (S/M) | Shirt (L/XL/XXL)
 *
 * Usage:
 *   node scripts/backfill-bandcamp-format-names.mjs [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://yspmgzphxlkcnfalndbh.supabase.co";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? (() => { throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var"); })();

const DRY_RUN = process.argv.includes("--dry-run");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Normalize a Bandcamp package title to a canonical warehouse_format_costs key.
 * Returns null for formats that have no cost row (bags, hats, etc.) — these will
 * correctly show the amber dot in the shipping log until staff adds a cost row or
 * sets a manual format_name_override on the shipment item.
 *
 * NOTE: Shirts are left null because we cannot determine S/M vs L/XL/XXL from the
 * package name alone. Staff must set format_name_override per shipment item.
 */
function normalizeToFormatName(raw) {
  if (!raw) return null;
  const t = raw.trim().toUpperCase();

  // 7-inch must come before generic VINYL check
  if (/\b7["″]\b|\b7-?INCH\b|\bSEVEN.?INCH\b/.test(t)) return '7"';

  // Cassette — catches CASSETTE, TAPE, CS, 2CS, 3CS, CASEETTE (typo in data)
  if (/\bCASS(ETTE)?\b|\bTAPE\b|\bCS\b|\bC80\b/.test(t)) return "Cassette";

  // Vinyl / LP — catches VINYL, LP, 12", 2LP, TEST PRESSING, LATHE CUT
  if (
    /\bVINYL\b|\bLP\b|\b12["″]\b|\bTEST.?PRESSING\b|\bLATHE.?CUT\b/.test(t)
  )
    return "LP";

  // CD
  if (/\bCD\b|\bCOMPACT.?DISC\b/.test(t)) return "CD";

  // Apparel — leave null, cannot determine size from name
  // (TEE, SHIRT, HOODIE, CREWNECK, SWEATSHIRT, LONGSLEEVE, LONG SLEEVE)
  // Staff sets Shirt (S/M) or Shirt (L/XL/XXL) via format_name_override per shipment item.

  return null; // bags, hats, totes, stickers, zines, posters, magnets, bundles, etc.
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}\n`);

  // Fetch all mappings with raw_api_data
  console.log("Fetching all bandcamp_product_mappings…");
  const CHUNK = 200;
  let offset = 0;
  const allMappings = [];
  while (true) {
    const { data, error } = await supabase
      .from("bandcamp_product_mappings")
      .select("id, variant_id, bandcamp_type_name, raw_api_data")
      .range(offset, offset + CHUNK - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    allMappings.push(...data);
    if (data.length < CHUNK) break;
    offset += CHUNK;
  }
  console.log(`  Fetched ${allMappings.length} mappings\n`);

  // Classify each mapping
  const toUpdate = []; // { id, variant_id, packageName, newFormatName, oldTypeName }
  const skipped = []; // no raw_api_data
  const unchanged = []; // already correct
  const noFormatRow = []; // normalized to null (no cost row)

  for (const m of allMappings) {
    const packageName = m.raw_api_data?.title ?? null;
    if (!packageName) {
      skipped.push({ id: m.id, reason: "no raw_api_data.title" });
      continue;
    }

    const newFormatName = normalizeToFormatName(packageName);
    const oldTypeName = m.bandcamp_type_name ?? null;
    const normalizedTypeName = newFormatName ?? oldTypeName; // keep old if we can't improve

    if (newFormatName === null) {
      noFormatRow.push({ id: m.id, packageName, oldTypeName });
      continue;
    }

    // Only update if bandcamp_type_name needs correcting
    if (oldTypeName === newFormatName) {
      unchanged.push(m.id);
      continue;
    }

    toUpdate.push({
      id: m.id,
      variant_id: m.variant_id,
      packageName,
      newFormatName,
      oldTypeName,
    });
  }

  console.log(`--- Classification ---`);
  console.log(`  Will update:           ${toUpdate.length}`);
  console.log(`  Already correct:       ${unchanged.length}`);
  console.log(`  No cost row (null):    ${noFormatRow.length}`);
  console.log(`  No raw_api_data:       ${skipped.length}`);
  console.log();

  // Show a sample of what will change
  if (toUpdate.length > 0) {
    console.log("Sample changes (first 20):");
    for (const u of toUpdate.slice(0, 20)) {
      console.log(`  "${u.packageName}" :: "${u.oldTypeName}" → "${u.newFormatName}"`);
    }
    if (toUpdate.length > 20) console.log(`  … and ${toUpdate.length - 20} more`);
    console.log();
  }

  if (DRY_RUN) {
    console.log("DRY RUN — no writes performed.");
    return;
  }

  // Apply updates in batches
  let mappingUpdated = 0;
  let variantUpdated = 0;
  let errors = 0;

  for (const u of toUpdate) {
    // 1. Fix bandcamp_product_mappings.bandcamp_type_name
    const { error: mErr } = await supabase
      .from("bandcamp_product_mappings")
      .update({ bandcamp_type_name: u.newFormatName })
      .eq("id", u.id);

    if (mErr) {
      console.error(`  [MAPPING ERR] ${u.id}: ${mErr.message}`);
      errors++;
      continue;
    }
    mappingUpdated++;

    // 2. Fix warehouse_product_variants.format_name
    // Only overwrite if format_name is currently null or matches the old wrong value
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id, format_name")
      .eq("id", u.variant_id)
      .single();

    if (variant && (variant.format_name === null || variant.format_name === u.oldTypeName)) {
      const { error: vErr } = await supabase
        .from("warehouse_product_variants")
        .update({ format_name: u.newFormatName })
        .eq("id", u.variant_id);

      if (vErr) {
        console.error(`  [VARIANT ERR] ${u.variant_id}: ${vErr.message}`);
        errors++;
      } else {
        variantUpdated++;
      }
    }
  }

  console.log(`--- Results ---`);
  console.log(`  bandcamp_product_mappings updated: ${mappingUpdated}`);
  console.log(`  warehouse_product_variants updated: ${variantUpdated}`);
  if (errors > 0) console.log(`  Errors: ${errors}`);
  console.log();
  console.log(`Items with no matching cost row (${noFormatRow.length} — will show amber dot):`);
  const byName = {};
  for (const n of noFormatRow) {
    byName[n.packageName] = (byName[n.packageName] ?? 0) + 1;
  }
  const sorted = Object.entries(byName).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted.slice(0, 30)) {
    console.log(`  ${name}: ${count}`);
  }
  if (sorted.length > 30) console.log(`  … and ${sorted.length - 30} more unique names`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
