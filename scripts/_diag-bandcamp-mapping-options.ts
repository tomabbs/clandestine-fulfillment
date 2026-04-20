import { config } from "dotenv";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

(async () => {
  const sb = createServiceRoleClient();
  const sampleBandcampItemIds = [3910723131, 1006307261, 970019443, 236867486, 1110968847];
  const { data, error } = await sb
    .from("bandcamp_product_mappings")
    .select(
      "id, workspace_id, variant_id, bandcamp_item_id, bandcamp_options, bandcamp_option_skus, authority_status, warehouse_product_variants:variant_id(id, sku, product_id, warehouse_products:product_id(id, title, shopify_product_id))",
    )
    .in("bandcamp_item_id", sampleBandcampItemIds);
  if (error) throw error;
  for (const m of data ?? []) {
    const v = (m as unknown as { warehouse_product_variants?: { id: string; sku: string; product_id: string; warehouse_products?: { id: string; title: string; shopify_product_id: string | null } } }).warehouse_product_variants;
    console.log("---");
    console.log("mapping_id:", m.id);
    console.log("bandcamp_item_id:", m.bandcamp_item_id);
    console.log("variant_id:", m.variant_id);
    console.log("umbrella_sku:", v?.sku ?? null);
    console.log("warehouse_product_id:", v?.product_id ?? null);
    console.log("product_title:", v?.warehouse_products?.title ?? null);
    console.log("shopify_product_id:", v?.warehouse_products?.shopify_product_id ?? null);
    console.log("authority_status:", m.authority_status);
    console.log("bandcamp_option_skus:", m.bandcamp_option_skus);
    const opts = m.bandcamp_options as unknown as Array<Record<string, unknown>> | null;
    if (Array.isArray(opts)) {
      console.log("bandcamp_options:");
      for (const o of opts.slice(0, 3)) console.log("   ", JSON.stringify(o));
      if (opts.length > 3) console.log(`    ... ${opts.length - 3} more`);
    } else {
      console.log("bandcamp_options: (null)");
    }
  }

  // Check sibling warehouse_product_variants under same product_id (does each size have its own variant row already?)
  console.log("\n=== siblings under same warehouse_products row ===");
  const productIds = (data ?? [])
    .map((m) => (m as any).warehouse_product_variants?.product_id)
    .filter(Boolean) as string[];
  if (productIds.length > 0) {
    const { data: siblings, error: sibErr } = await sb
      .from("warehouse_product_variants")
      .select("id, product_id, sku, option1_name, option1_value, format_name, shopify_variant_id, shopify_inventory_item_id")
      .in("product_id", productIds);
    if (sibErr) throw sibErr;
    const byProduct = new Map<string, typeof siblings>();
    for (const s of siblings ?? []) {
      const arr = byProduct.get(s.product_id) ?? [];
      arr.push(s);
      byProduct.set(s.product_id, arr);
    }
    for (const [pid, sibs] of byProduct) {
      console.log(`product_id=${pid} variant_count=${sibs?.length}`);
      for (const s of sibs ?? []) {
        console.log(
          `   variant=${s.id.slice(0, 8)} sku=${s.sku} opt1=[${s.option1_name ?? ""}=${s.option1_value ?? ""}] format=${s.format_name ?? ""} shop_var=${s.shopify_variant_id ?? ""}`,
        );
      }
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
