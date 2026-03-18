import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function poll() {
  console.log(`\n=== Sync Status @ ${new Date().toISOString()} ===\n`);

  const { data: logs } = await supabase
    .from("channel_sync_log")
    .select("channel, sync_type, status, items_processed, items_failed, error_message, started_at, completed_at")
    .order("created_at", { ascending: false })
    .limit(5);

  console.log("Recent sync logs:");
  for (const log of logs ?? []) {
    console.log(`  ${log.channel}/${log.sync_type}: ${log.status} — ${log.items_processed ?? 0} processed, ${log.items_failed ?? 0} failed${log.error_message ? `\n    ERROR: ${log.error_message.slice(0, 200)}` : ""}`);
  }

  const tables = [
    { table: "warehouse_products", label: "Products" },
    { table: "warehouse_product_variants", label: "Variants" },
    { table: "bandcamp_product_mappings", label: "Bandcamp mappings" },
    { table: "bandcamp_connections", label: "Bandcamp connections" },
    { table: "warehouse_shipments", label: "Shipments" },
  ];

  console.log("\nDB counts:");
  for (const { table, label } of tables) {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true });
    console.log(`  ${label}: ${count ?? 0}`);
  }

  const { count: invCount } = await supabase
    .from("warehouse_inventory_levels")
    .select("id", { count: "exact", head: true })
    .gt("available", 0);
  console.log(`  Inventory (available > 0): ${invCount ?? 0}`);

  const { count: reviewCount } = await supabase
    .from("warehouse_review_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  console.log(`  Open review items: ${reviewCount ?? 0}`);
}

poll().catch(console.error);
