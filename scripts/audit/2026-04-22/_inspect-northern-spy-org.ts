import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();

  console.log("=== org 4d778a4e-ff30-40ae-bec3-74f4042ce862 (owns northernspyrecs.com woo conn) ===");
  const { data: byId } = await sb
    .from("organizations")
    .select("*")
    .eq("id", "4d778a4e-ff30-40ae-bec3-74f4042ce862");
  console.log(JSON.stringify(byId, null, 2));

  console.log("\n=== orgs whose name/slug contains 'northern' or 'nspy' or 'spy' ===");
  const { data: matches } = await sb
    .from("organizations")
    .select("id, name, slug, workspace_id, created_at")
    .or("name.ilike.%northern%,slug.ilike.%northern%,name.ilike.%spy%,slug.ilike.%spy%,name.ilike.%nspy%");
  console.log(JSON.stringify(matches, null, 2));

  console.log("\n=== True Panther org (4350cb01) — connections + contacts ===");
  const { data: tp } = await sb
    .from("organizations")
    .select("*")
    .eq("id", "4350cb01-8c7e-48eb-9eba-cb8e818de46d");
  console.log(JSON.stringify(tp, null, 2));

  console.log("\n=== bandcamp_connections for True Panther ===");
  const { data: bc } = await sb
    .from("bandcamp_connections")
    .select("id, band_id, band_name, org_id, last_synced_at")
    .eq("org_id", "4350cb01-8c7e-48eb-9eba-cb8e818de46d");
  console.log(JSON.stringify(bc, null, 2));

  console.log("\n=== client_store_sku_mappings for the 2b65b8 connection ===");
  const { data: mappings } = await sb
    .from("client_store_sku_mappings")
    .select("id, sku, remote_product_id, remote_variant_id, remote_inventory_item_id, last_synced_at")
    .eq("connection_id", "93225922-357f-4607-a5a4-2c1ad3a9beac");
  console.log("mappings count:", mappings?.length ?? 0);
  console.log(JSON.stringify(mappings?.slice(0, 5) ?? [], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
