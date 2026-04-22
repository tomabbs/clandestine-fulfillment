import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();

  const { data: stores } = await sb
    .from("warehouse_shipstation_stores")
    .select("store_id, store_name, marketplace_name, org_id, is_drop_ship, created_at")
    .order("created_at", { ascending: false });
  console.log("=== warehouse_shipstation_stores ===");
  console.log(`total: ${stores?.length ?? 0}`);
  console.log(JSON.stringify(stores, null, 2));

  const { count: ssCount } = await sb
    .from("shipstation_orders")
    .select("*", { count: "exact", head: true });
  console.log("\n=== shipstation_orders total rows:", ssCount, "===");

  // Count by marketplace_name
  const { data: ssAll } = await sb
    .from("shipstation_orders")
    .select("marketplace_name, store_id")
    .limit(2000);
  const byMkt: Record<string, number> = {};
  for (const r of ssAll ?? []) {
    const k = `${r.marketplace_name ?? "<null>"} (store_id=${r.store_id ?? "null"})`;
    byMkt[k] = (byMkt[k] ?? 0) + 1;
  }
  console.log("by marketplace_name (sample):", byMkt);

  const { data: bcConns } = await sb
    .from("bandcamp_connections")
    .select("id, band_id, band_name, last_synced_at")
    .limit(20);
  console.log("\n=== bandcamp_connections ===");
  console.log("total:", bcConns?.length);
  console.log(JSON.stringify(bcConns, null, 2));

  // Look for "bandcamp" in store names/marketplaces (case insensitive)
  const { data: bcStores } = await sb
    .from("warehouse_shipstation_stores")
    .select("*")
    .ilike("marketplace_name", "%bandcamp%");
  console.log("\n=== ShipStation stores w/ marketplace ilike '%bandcamp%' ===");
  console.log(JSON.stringify(bcStores, null, 2));
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
