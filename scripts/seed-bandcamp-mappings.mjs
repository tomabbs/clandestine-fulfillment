/**
 * Seed Bandcamp product mappings from the SKU audit spreadsheet.
 *
 * 1. MATCHED items (BC SKU = warehouse SKU): create mapping row linking them
 * 2. SKU_NOT_FOUND items: create warehouse product + variant + mapping with BC SKU
 * 3. NO_SKU items: auto-generate SKU, create product + variant + mapping
 *
 * Usage: node scripts/seed-bandcamp-mappings.mjs [--dry-run]
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

config({ path: ".env.local" });

const dryRun = process.argv.includes("--dry-run");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE env vars"); process.exit(1); }
const sb = createClient(url, key);

// Parse the spreadsheet data using openpyxl output (pre-extracted)
async function loadSpreadsheet() {
  // Use dynamic import for openpyxl-like parsing - we'll use the TSV data directly
  const { execSync } = await import("node:child_process");
  const raw = execSync(`python3 -c "
import openpyxl, json
wb = openpyxl.load_workbook('/Users/tomabbs/Downloads/bandcamp-sku-audit.xlsx', data_only=True)
ws = wb['bandcamp-sku-audit.tsv']
items = []
for row in range(2, ws.max_row + 1):
    conn = ws.cell(row, 1).value
    if not conn: continue
    items.append({
        'connection': conn,
        'bc_sku': ws.cell(row, 2).value or None,
        'bc_title': ws.cell(row, 3).value or None,
        'album_title': ws.cell(row, 4).value or None,
        'bc_url': ws.cell(row, 5).value or None,
        'new_date': str(ws.cell(row, 6).value) if ws.cell(row, 6).value else None,
        'price': float(ws.cell(row, 7).value) if ws.cell(row, 7).value else None,
        'qty_avail': str(ws.cell(row, 8).value) if ws.cell(row, 8).value else None,
        'qty_sold': float(ws.cell(row, 9).value) if ws.cell(row, 9).value else None,
        'wh_sku': ws.cell(row, 10).value or None,
        'match_status': ws.cell(row, 14).value,
        'has_mapping': ws.cell(row, 15).value,
    })
print(json.dumps(items))
"`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(raw);
}

function generateSku(item) {
  const title = item.bc_title || "";
  let format = "MERCH";
  if (/vinyl|LP|12"|10"/i.test(title)) format = "LP";
  else if (/CD|compact disc/i.test(title)) format = "CD";
  else if (/cassette|tape/i.test(title)) format = "CS";
  else if (/t-?shirt|tee/i.test(title)) format = "TEE";

  const artist = (item.album_title || item.bc_title || "unknown")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 8);

  return `${format}-${artist}-${Date.now().toString(36).slice(-4)}`.toUpperCase();
}

async function main() {
  console.log(`Seeding Bandcamp mappings${dryRun ? " (DRY RUN)" : ""}...\n`);

  const items = await loadSpreadsheet();
  console.log(`Loaded ${items.length} items from spreadsheet`);

  // Get workspace and connections
  const { data: workspace } = await sb.from("workspaces").select("id").limit(1).single();
  const workspaceId = workspace.id;

  const { data: connections } = await sb.from("bandcamp_connections")
    .select("id, band_name, band_id, org_id")
    .eq("workspace_id", workspaceId);
  const connMap = new Map(connections.map(c => [c.band_name, c]));

  // Get existing variants and mappings
  const { data: allVariants } = await sb.from("warehouse_product_variants")
    .select("id, sku")
    .eq("workspace_id", workspaceId);
  const variantBySku = new Map((allVariants ?? []).filter(v => v.sku).map(v => [v.sku, v.id]));

  const { data: allMappings } = await sb.from("bandcamp_product_mappings")
    .select("variant_id");
  const mappedVariants = new Set((allMappings ?? []).map(m => m.variant_id));

  let createdMappings = 0;
  let createdProducts = 0;
  let skippedExisting = 0;
  let skippedNoConn = 0;
  let errors = 0;

  for (const item of items) {
    const conn = connMap.get(item.connection);
    if (!conn) { skippedNoConn++; continue; }

    const effectiveSku = item.bc_sku || generateSku(item);

    // Check if variant exists
    const existingVariantId = variantBySku.get(effectiveSku);

    if (existingVariantId && mappedVariants.has(existingVariantId)) {
      skippedExisting++;
      continue;
    }

    if (existingVariantId && !mappedVariants.has(existingVariantId)) {
      // MATCHED: variant exists, just needs mapping
      if (dryRun) {
        console.log(`  [MAP] ${item.connection} | ${effectiveSku} | ${item.bc_title?.slice(0, 40)}`);
        createdMappings++;
        continue;
      }

      const { error } = await sb.from("bandcamp_product_mappings").insert({
        workspace_id: workspaceId,
        variant_id: existingVariantId,
        bandcamp_item_id: 0,
        bandcamp_item_type: "package",
        bandcamp_member_band_id: conn.band_id,
        bandcamp_type_name: item.bc_title,
        bandcamp_new_date: item.new_date,
        bandcamp_url: item.bc_url || null,
        bandcamp_url_source: item.bc_url ? "orders_api" : null,
        bandcamp_album_title: item.album_title || null,
        bandcamp_price: item.price,
        last_synced_at: new Date().toISOString(),
        authority_status: "bandcamp_initial",
      });

      if (error) {
        if (error.code === "23505") { skippedExisting++; }
        else { console.error(`  [ERR] mapping ${effectiveSku}: ${error.message}`); errors++; }
      } else {
        createdMappings++;
        mappedVariants.add(existingVariantId);
      }
      continue;
    }

    // SKU_NOT_FOUND or NO_SKU: create product + variant + mapping
    if (dryRun) {
      console.log(`  [NEW] ${item.connection} | ${effectiveSku} | ${item.bc_title?.slice(0, 40)}`);
      createdProducts++;
      continue;
    }

    // Determine format from title
    const title = item.bc_title || "Unknown Item";
    let productType = "Merch";
    if (/vinyl|LP|12"|10"/i.test(title)) productType = "Vinyl";
    else if (/CD|compact disc/i.test(title)) productType = "CD";
    else if (/cassette|tape/i.test(title)) productType = "Cassette";
    else if (/t-?shirt|tee|hoodie/i.test(title)) productType = "Apparel";

    const artistName = item.connection;
    const fullTitle = item.album_title
      ? `${artistName} - ${item.album_title} - ${title}`
      : `${artistName} - ${title}`;

    // Create product
    const { data: product, error: prodErr } = await sb.from("warehouse_products").insert({
      workspace_id: workspaceId,
      org_id: conn.org_id,
      title: fullTitle,
      vendor: artistName,
      product_type: productType,
      status: "draft",
      tags: [],
    }).select("id").single();

    if (prodErr) {
      console.error(`  [ERR] product ${effectiveSku}: ${prodErr.message}`);
      errors++;
      continue;
    }

    // Create variant (or find existing if SKU already exists)
    let variantId;
    const { data: variant, error: varErr } = await sb.from("warehouse_product_variants").insert({
      workspace_id: workspaceId,
      product_id: product.id,
      sku: effectiveSku,
      title: title,
      price: item.price,
    }).select("id").single();

    if (varErr) {
      if (varErr.code === "23505") {
        // SKU already exists -- find the existing variant and use it
        const { data: existing } = await sb.from("warehouse_product_variants")
          .select("id").eq("workspace_id", workspaceId).eq("sku", effectiveSku).single();
        if (existing) {
          variantId = existing.id;
          // Delete the orphan product we just created
          await sb.from("warehouse_products").delete().eq("id", product.id);
        } else {
          console.error(`  [ERR] variant ${effectiveSku}: dup but can't find existing`);
          errors++;
          continue;
        }
      } else {
        console.error(`  [ERR] variant ${effectiveSku}: ${varErr.message}`);
        errors++;
        continue;
      }
    } else {
      variantId = variant.id;
    }

    // Create inventory level (skip if variant already existed)
    if (variant) {
      await sb.from("warehouse_inventory_levels").insert({
        workspace_id: workspaceId,
        variant_id: variantId,
        org_id: conn.org_id,
        sku: effectiveSku,
        available: item.qty_avail === "unlimited" ? 999 : parseInt(item.qty_avail || "0") || 0,
      }).then(() => {}, () => {}); // ignore if already exists
    }

    // Create mapping
    const { error: mapErr } = await sb.from("bandcamp_product_mappings").insert({
      workspace_id: workspaceId,
      variant_id: variantId,
      bandcamp_item_id: 0,
      bandcamp_item_type: "package",
      bandcamp_member_band_id: conn.band_id,
      bandcamp_type_name: title,
      bandcamp_new_date: item.new_date,
      bandcamp_url: item.bc_url || null,
      bandcamp_url_source: item.bc_url ? "orders_api" : null,
      bandcamp_album_title: item.album_title || null,
      bandcamp_price: item.price,
      last_synced_at: new Date().toISOString(),
      authority_status: "bandcamp_initial",
    });

    if (mapErr) {
      console.error(`  [ERR] mapping ${effectiveSku}: ${mapErr.message}`);
      errors++;
    } else {
      createdProducts++;
      createdMappings++;
      variantBySku.set(effectiveSku, variantId);
      mappedVariants.add(variantId);
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Created mappings (existing variant): ${createdMappings}`);
  console.log(`Created products + variants + mappings: ${createdProducts}`);
  console.log(`Skipped (already mapped): ${skippedExisting}`);
  console.log(`Skipped (no connection match): ${skippedNoConn}`);
  console.log(`Errors: ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
