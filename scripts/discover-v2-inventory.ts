/**
 * Phase 0 — discover ShipStation v2 inventory warehouses + locations.
 *
 * Read-only probe. Calls listInventoryWarehouses() (one HTTP request) and
 * for each warehouse calls listInventoryLocations(). Writes the full result
 * to reports/probes/v2-inventory-discovery-${ts}.json so we know:
 *   - whether any warehouses exist at all
 *   - whether any locations exist
 *   - which (warehouse_id, location_id) tuple to use for the §15.3 probe
 *     (and for setting workspaces.shipstation_v2_inventory_warehouse_id)
 *
 * No writes to ShipStation, no writes to our DB.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  listInventoryLocations,
  listInventoryWarehouses,
} from "@/lib/clients/shipstation-inventory-v2";

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  const warehouses = await listInventoryWarehouses();
  console.log(`found ${warehouses.length} warehouses`);

  const enriched: Array<{
    inventory_warehouse_id: string;
    name: string | null;
    locations: Array<{ inventory_location_id: string; name: string | null }>;
  }> = [];

  for (const wh of warehouses) {
    let locations: Array<{ inventory_location_id: string; name: string | null }> = [];
    try {
      const locs = await listInventoryLocations(wh.inventory_warehouse_id);
      locations = locs.map((l) => ({
        inventory_location_id: l.inventory_location_id,
        name: l.name,
      }));
    } catch (err) {
      console.error(
        `failed to list locations for ${wh.inventory_warehouse_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    enriched.push({
      inventory_warehouse_id: wh.inventory_warehouse_id,
      name: wh.name,
      locations,
    });
    console.log(
      `  warehouse ${wh.inventory_warehouse_id} (${wh.name ?? "?"}) — ${locations.length} locations`,
    );
    for (const l of locations) {
      console.log(`    - ${l.inventory_location_id} (${l.name ?? "?"})`);
    }
  }

  const out = join("reports", "probes", `v2-inventory-discovery-${ts}.json`);
  writeFileSync(out, JSON.stringify({ ts, warehouses: enriched }, null, 2));
  console.log(`\nwrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
