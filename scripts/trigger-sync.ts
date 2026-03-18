/**
 * One-shot script: trigger bandcamp-sync + seed ShipStation cursor + trigger shipstation-poll.
 * Run with: npx tsx scripts/trigger-sync.ts
 * Delete after use.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  // 1. Get workspace ID
  const { data: ws, error: wsErr } = await supabase
    .from("workspaces")
    .select("id")
    .limit(1)
    .single();
  if (wsErr || !ws) {
    console.error("No workspace found:", wsErr?.message);
    process.exit(1);
  }
  const workspaceId = ws.id;
  console.log(`Workspace: ${workspaceId}`);

  // 2. Trigger bandcamp-sync
  console.log("\n--- Triggering bandcamp-sync ---");
  try {
    const bcHandle = await tasks.trigger("bandcamp-sync", { workspaceId });
    console.log(`bandcamp-sync triggered: run ${bcHandle.id}`);
    console.log(`Dashboard: https://cloud.trigger.dev/projects/v3/proj_lxmzyqttdjjukmshplok/runs/${bcHandle.id}`);
  } catch (err) {
    console.error("Failed to trigger bandcamp-sync:", err);
  }

  // 3. Seed ShipStation historical cursor (90 days back)
  console.log("\n--- Seeding ShipStation sync cursor (90 days back) ---");
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const { error: seedErr } = await supabase.from("warehouse_sync_state").upsert(
    {
      workspace_id: workspaceId,
      sync_type: "shipstation_poll",
      last_sync_cursor: ninetyDaysAgo.toISOString(),
      last_sync_wall_clock: ninetyDaysAgo,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,sync_type" },
  );
  if (seedErr) {
    console.error("Failed to seed ShipStation cursor:", seedErr.message);
  } else {
    console.log(`Cursor set to ${ninetyDaysAgo.toISOString()}`);
  }

  // 4. Trigger shipstation-poll
  console.log("\n--- Triggering shipstation-poll ---");
  try {
    const ssHandle = await tasks.trigger("shipstation-poll", {});
    console.log(`shipstation-poll triggered: run ${ssHandle.id}`);
    console.log(`Dashboard: https://cloud.trigger.dev/projects/v3/proj_lxmzyqttdjjukmshplok/runs/${ssHandle.id}`);
  } catch (err) {
    console.error("Failed to trigger shipstation-poll:", err);
  }

  // 5. Report current counts
  console.log("\n--- Current DB counts ---");
  const tables = [
    { table: "warehouse_products", label: "Products" },
    { table: "warehouse_product_variants", label: "Variants" },
    { table: "bandcamp_product_mappings", label: "Bandcamp mappings" },
    { table: "bandcamp_connections", label: "Bandcamp connections" },
    { table: "warehouse_shipments", label: "Shipments" },
  ];

  for (const { table, label } of tables) {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true });
    console.log(`  ${label}: ${count ?? 0}`);
  }

  // Inventory with available > 0
  const { count: invCount } = await supabase
    .from("warehouse_inventory_levels")
    .select("id", { count: "exact", head: true })
    .gt("available", 0);
  console.log(`  Inventory (available > 0): ${invCount ?? 0}`);

  console.log("\nTasks triggered. Monitor at:");
  console.log("https://cloud.trigger.dev/projects/v3/proj_lxmzyqttdjjukmshplok/runs");
}

main().catch(console.error);
