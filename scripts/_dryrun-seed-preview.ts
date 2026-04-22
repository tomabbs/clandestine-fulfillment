/**
 * Read-only seed dry-run preview — evaluates the seed gate cascade for the
 * given workspace WITHOUT calling ShipStation v2. Mirrors the
 * `previewShipStationSeed` Server Action minus the auth wrapper.
 *
 * Usage:
 *   npx tsx scripts/_dryrun-seed-preview.ts <workspaceId> [warehouseId] [locationId]
 *
 * Side effects: NONE. The seed task respects `dryRun: true` and skips all
 * `adjustInventoryV2` calls — it only counts which SKUs would be touched.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { runShipstationSeedInventory } from "@/trigger/tasks/shipstation-seed-inventory";

async function main() {
  const [workspaceId, warehouseId = "se-214575", locationId = "se-3213662"] = process.argv.slice(2);
  if (!workspaceId) {
    console.error("usage: tsx scripts/_dryrun-seed-preview.ts <workspaceId> [warehouseId] [locationId]");
    process.exit(1);
  }

  console.log("\n=== Seed dry-run gate cascade ===");
  console.log(`workspace_id        = ${workspaceId}`);
  console.log(`warehouse_id (mock) = ${warehouseId}  (irrelevant in dry-run)`);
  console.log(`location_id (mock)  = ${locationId}   (irrelevant in dry-run)`);

  const fakeRunId = `dryrun:${Date.now()}`;
  const result = await runShipstationSeedInventory(
    {
      workspaceId,
      inventoryWarehouseId: warehouseId,
      inventoryLocationId: locationId,
      dryRun: true,
    },
    { run: { id: fakeRunId } },
  );

  console.log("\n=== Dry-run counts ===");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
