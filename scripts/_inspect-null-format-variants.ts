import { config } from "dotenv";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
config({ path: ".env.local" });

(async () => {
  const sb = createServiceRoleClient();

  const { data: nulls, error } = await sb
    .from("warehouse_product_variants")
    .select("id, sku, title, product_id, warehouse_products!inner(title, vendor, shopify_product_id)")
    .is("format_name", null)
    .limit(2000);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const rows = (nulls ?? []) as unknown as Array<{
    id: string;
    sku: string;
    title: string | null;
    product_id: string;
    warehouse_products: {
      title: string | null;
      vendor: string | null;
      shopify_product_id: string | null;
    } | null;
  }>;
  console.log(`null-format variants: ${rows.length}`);

  // Check how many have a bandcamp mapping
  const variantIds = rows.map((r) => r.id);
  const productIds = [...new Set(rows.map((r) => r.product_id))];

  const { data: mappings } = await sb
    .from("bandcamp_product_mappings")
    .select("variant_id, bandcamp_item_id")
    .in("variant_id", variantIds);
  const variantsWithBandcamp = new Set((mappings ?? []).map((m) => m.variant_id));

  // SKU prefix breakdown
  const prefixCounts = new Map<string, number>();
  for (const r of rows) {
    const p = (r.sku ?? "").split("-")[0]?.toUpperCase() || "(none)";
    prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  console.log("\nSKU prefix distribution:");
  for (const [k, c] of [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.toString().padStart(4)}  ${k}`);
  }

  console.log(`\nVariants with Bandcamp mapping: ${variantsWithBandcamp.size} / ${rows.length}`);
  console.log(`Variants with shopify_product_id: ${rows.filter((r) => r.warehouse_products?.shopify_product_id).length}`);
  console.log(`Distinct products containing null-format variants: ${productIds.length}`);

  console.log("\nSample (first 25):");
  for (const r of rows.slice(0, 25)) {
    console.log(
      `  sku=${r.sku.padEnd(28)} title="${(r.title ?? r.warehouse_products?.title ?? "").slice(0, 60)}"  vendor="${r.warehouse_products?.vendor ?? ""}"`,
    );
  }
})();
