/**
 * Go-live reconnaissance — read-only.
 *
 * Reports:
 *   1. Workspaces + current sync flags + v2 IDs
 *   2. ShipStation v2 warehouses + locations (live API call)
 *   3. DB↔v2 inventory drift sample (so we know if a seed is needed)
 *
 * Side effects: NONE. Pure read.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  listInventory,
  listInventoryLocations,
  listInventoryWarehouses,
} from "@/lib/clients/shipstation-inventory-v2";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();

  console.log("\n=== Workspaces ===");
  const { data: workspaces, error: wsErr } = await sb
    .from("workspaces")
    .select(
      "id, name, inventory_sync_paused, fanout_rollout_percent, shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id, shipstation_sync_paused, bandcamp_sync_paused, clandestine_shopify_sync_paused, client_store_sync_paused",
    )
    .order("created_at", { ascending: true });
  if (wsErr) {
    console.error("workspaces error:", wsErr);
    process.exit(1);
  }
  for (const ws of workspaces ?? []) {
    console.log(JSON.stringify(ws, null, 2));
  }

  console.log("\n=== ShipStation v2 — warehouses + locations ===");
  let v2Warehouses: Awaited<ReturnType<typeof listInventoryWarehouses>> = [];
  try {
    v2Warehouses = await listInventoryWarehouses();
    for (const wh of v2Warehouses) {
      console.log(`\nwarehouse_id=${wh.inventory_warehouse_id}  name=${wh.name}`);
      const locs = await listInventoryLocations(wh.inventory_warehouse_id);
      console.log(`  ${locs.length} locations`);
      // Show first 5 + (Unspecified) if present
      const unspecified = locs.find((l) => /unspecified/i.test(l.name ?? ""));
      if (unspecified) {
        console.log(
          `  default candidate: location_id=${unspecified.inventory_location_id}  name=${unspecified.name}`,
        );
      }
      for (const loc of locs.slice(0, 3)) {
        console.log(`    location_id=${loc.inventory_location_id}  name=${loc.name}`);
      }
      if (locs.length > 3) console.log(`    … ${locs.length - 3} more`);
    }
  } catch (e) {
    console.error("v2 warehouses fetch failed:", e instanceof Error ? e.message : e);
  }

  console.log("\n=== DB↔v2 sample drift (first 15 SKUs per workspace) ===");
  for (const ws of workspaces ?? []) {
    const { data: levels } = await sb
      .from("warehouse_inventory_levels")
      .select("sku, available")
      .eq("workspace_id", ws.id)
      .gt("available", 0)
      .order("sku", { ascending: true })
      .limit(15);

    if (!levels || levels.length === 0) {
      console.log(`workspace ${ws.id} (${ws.name}): no positive-stock SKUs in DB`);
      continue;
    }

    const skus = levels.map((l) => l.sku);
    let v2Levels: Array<{ sku: string; available: number }> = [];
    try {
      const v2 = await listInventory({ skus, limit: 100 });
      const rows = v2.inventory ?? v2.inventory_levels ?? [];
      v2Levels = rows.map((r: Record<string, unknown>) => ({
        sku: String(r.sku ?? ""),
        available: Number(r.available ?? 0),
      }));
    } catch (e) {
      console.log(
        `workspace ${ws.id} (${ws.name}): v2 read failed — ${e instanceof Error ? e.message : e}`,
      );
      continue;
    }

    const v2Map = new Map(v2Levels.map((r) => [r.sku, r.available]));
    let aligned = 0;
    let drift = 0;
    let missingInV2 = 0;
    const driftRows: Array<{ sku: string; db: number; v2: number; delta: number }> = [];
    for (const lvl of levels) {
      const v2Avail = v2Map.get(lvl.sku);
      if (v2Avail === undefined) {
        missingInV2++;
        driftRows.push({ sku: lvl.sku, db: lvl.available, v2: 0, delta: -lvl.available });
        continue;
      }
      if (v2Avail === lvl.available) {
        aligned++;
      } else {
        drift++;
        driftRows.push({
          sku: lvl.sku,
          db: lvl.available,
          v2: v2Avail,
          delta: v2Avail - lvl.available,
        });
      }
    }

    console.log(
      `workspace ${ws.id} (${ws.name}): sample=${levels.length}, aligned=${aligned}, drift=${drift}, missingInV2=${missingInV2}`,
    );
    if (driftRows.length > 0) {
      console.log("  drift rows:");
      for (const d of driftRows.slice(0, 10)) {
        console.log(`    ${d.sku}: db=${d.db} v2=${d.v2} delta=${d.delta}`);
      }
    }
  }

  console.log("\n=== Recent fanout activity (last 24h) ===");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await sb
    .from("external_sync_events")
    .select("system, action, status, count")
    .gte("created_at", since);
  const buckets = new Map<string, number>();
  for (const r of recent ?? []) {
    const key = `${r.system}/${r.action}/${r.status}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  if (buckets.size === 0) {
    console.log("(no external_sync_events rows in last 24h)");
  } else {
    for (const [k, v] of [...buckets.entries()].sort()) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
