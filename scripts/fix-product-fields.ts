/**
 * Fix stale variant title, product_type, and format_name for Bandcamp-mapped products.
 *
 * Runs after fix-product-titles.ts. Only touches products with authority_status = 'warehouse_reviewed'.
 * Uses raw_api_data.title for variant title, bandcamp_type_name for product_type and format_name.
 *
 * Usage:
 *   npx tsx scripts/fix-product-fields.ts --dry-run
 *   npx tsx scripts/fix-product-fields.ts --apply
 */

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (!apply && !dryRun) {
  console.error("Usage: npx tsx scripts/fix-product-fields.ts [--dry-run|--apply]");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function normalizeFormat(itemType: string | null | undefined): string | null {
  if (!itemType) return null;
  const t = itemType.toLowerCase().trim();
  if (t.includes("vinyl") || t === "lp" || t.includes("2xlp")) return "LP";
  if (t.includes("cassette") || t === "tape") return "Cassette";
  if (t.includes("cd") || t.includes("compact disc") || t.includes("digipak")) return "CD";
  if (t.includes('7"') || t.includes("7-inch")) return '7"';
  return null;
}

async function fetchAll(table: string, select: string) {
  let all: Record<string, unknown>[] = [];
  let page = 0;
  while (true) {
    const { data } = await supabase.from(table).select(select).range(page * 1000, (page + 1) * 1000 - 1);
    if (!data || data.length === 0) break;
    all = all.concat(data as unknown as Record<string, unknown>[]);
    page++;
  }
  return all;
}

async function main() {
  console.log(`\nProduct Fields Fix — ${dryRun ? "DRY RUN" : "APPLY MODE"}\n`);

  const mappings = await fetchAll("bandcamp_product_mappings",
    "variant_id, bandcamp_type_name, raw_api_data, authority_status");
  const variants = await fetchAll("warehouse_product_variants", "id, sku, title, format_name, product_id");
  const products = await fetchAll("warehouse_products", "id, product_type");
  const variantMap = new Map(variants.map((v) => [v.id as string, v]));
  const productMap = new Map(products.map((p) => [p.id as string, p]));

  const reviewed = mappings.filter((m) => m.authority_status === "warehouse_reviewed");
  console.log(`Reviewed mappings: ${reviewed.length}`);

  let variantTitleFixed = 0;
  let productTypeFixed = 0;
  let formatNameFixed = 0;
  let skipped = 0;

  for (const m of reviewed) {
    const v = variantMap.get(m.variant_id as string);
    if (!v) continue;
    const p = productMap.get(v.product_id as string);
    if (!p) continue;

    const raw = m.raw_api_data as Record<string, unknown> | null;
    const rawTitle = raw?.title as string | null;
    const bcTypeName = m.bandcamp_type_name as string | null;
    const normalized = normalizeFormat(bcTypeName);

    let changed = false;

    // Fix variant title from raw API data
    if (rawTitle && v.title !== rawTitle) {
      if (apply) {
        await supabase.from("warehouse_product_variants")
          .update({ title: rawTitle, updated_at: new Date().toISOString() })
          .eq("id", v.id as string);
      }
      variantTitleFixed++;
      changed = true;
    }

    // Fix product_type from bandcamp_type_name
    if (bcTypeName && p.product_type !== bcTypeName) {
      if (apply) {
        await supabase.from("warehouse_products")
          .update({ product_type: bcTypeName, updated_at: new Date().toISOString() })
          .eq("id", p.id as string);
      }
      productTypeFixed++;
      changed = true;
    }

    // Fix format_name from normalized format
    if (normalized && v.format_name !== normalized) {
      if (apply) {
        await supabase.from("warehouse_product_variants")
          .update({ format_name: normalized, updated_at: new Date().toISOString() })
          .eq("id", v.id as string);
      }
      formatNameFixed++;
      changed = true;
    }

    if (!changed) skipped++;
  }

  console.log(`\n=== FIELDS FIX SUMMARY (${dryRun ? "DRY RUN" : "APPLIED"}) ===`);
  console.log(`Reviewed mappings:    ${reviewed.length}`);
  console.log(`Variant titles fixed: ${variantTitleFixed}`);
  console.log(`Product types fixed:  ${productTypeFixed}`);
  console.log(`Format names fixed:   ${formatNameFixed}`);
  console.log(`Skipped (no change):  ${skipped}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
