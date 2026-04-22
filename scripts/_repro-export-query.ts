import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();
  const PAGE = 1000;
  let from = 0;
  let last = PAGE;
  let totalRows = 0;
  const skuCounts = new Map<string, number>();
  const variantIdCounts = new Map<string, number>();
  let pageNum = 0;
  while (last === PAGE) {
    pageNum++;
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select(
        `
        id, sku, title, barcode, weight, weight_unit, length_in, width_in, height_in,
        cost, price, option1_value, format_name, bandcamp_option_title,
        hs_tariff_code, is_preorder, created_at,
        warehouse_products(
          id, title, vendor, product_type, status, bandcamp_upc, org_id,
          organizations(id, name)
        )
      `,
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    last = batch.length;
    from += PAGE;
    totalRows += batch.length;
    for (const r of batch as Array<{ id: string; sku: string }>) {
      skuCounts.set(r.sku, (skuCounts.get(r.sku) ?? 0) + 1);
      variantIdCounts.set(r.id, (variantIdCounts.get(r.id) ?? 0) + 1);
    }
    console.log(`page ${pageNum}: returned=${batch.length}`);
  }
  console.log(`\ntotal rows returned: ${totalRows}`);
  console.log(`distinct skus: ${skuCounts.size}`);
  console.log(`distinct variant_ids: ${variantIdCounts.size}`);

  // Show duplicates
  const dupVariantIds = [...variantIdCounts.entries()].filter(([, c]) => c > 1);
  console.log(`variants returned more than once: ${dupVariantIds.length}`);
  if (dupVariantIds.length > 0) {
    console.log("first 5 duplicates:");
    for (const [id, c] of dupVariantIds.slice(0, 5)) console.log(`  ${id}  count=${c}`);
  }

  // Inspect one returned row to see shape
  const { data: oneRow } = await sb
    .from("warehouse_product_variants")
    .select(
      `id, sku, warehouse_products(id, organizations(id, name))`,
    )
    .limit(1);
  console.log("\nshape probe:", JSON.stringify(oneRow, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
