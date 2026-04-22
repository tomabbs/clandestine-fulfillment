import { config } from "dotenv";
config({ path: ".env.local" });

import {
  listInventory,
  listInventoryLocations,
  listInventoryWarehouses,
} from "@/lib/clients/shipstation-inventory-v2";

async function main() {
  const whs = await listInventoryWarehouses();
  for (const wh of whs) {
    const locs = await listInventoryLocations(wh.inventory_warehouse_id);
    console.log(
      JSON.stringify(
        {
          warehouse_id: wh.inventory_warehouse_id,
          name: wh.name,
          location_count: locs.length,
        },
        null,
        2,
      ),
    );
    const inv = await listInventory({
      inventory_warehouse_ids: [wh.inventory_warehouse_id],
      limit: 5,
    });
    const rows = (inv.inventory ?? inv.inventory_levels ?? []) as Array<Record<string, unknown>>;
    console.log(`  v2 inventory rows visible (limit 5): ${rows.length}`);
    for (const r of rows.slice(0, 3)) {
      console.log("   ", JSON.stringify(r));
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
