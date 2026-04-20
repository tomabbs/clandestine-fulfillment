import { config } from "dotenv";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
config({ path: ".env.local" });

(async () => {
  const sb = createServiceRoleClient();
  const { data } = await sb
    .from("warehouse_product_variants")
    .select(
      "sku, format_name, option1_name, option1_value, shopify_variant_id, shopify_inventory_item_id, warehouse_products!inner(title, status, vendor, shopify_product_id, tags)",
    )
    .like("sku", "SHIRT-NS-JJ-UO-%")
    .order("sku");
  console.log(JSON.stringify(data, null, 2));
})();
