#!/usr/bin/env node
/**
 * Verify ShipStation v2 Inventory API capabilities.
 *
 * Usage:
 *   node scripts/test-shipstation-v2-inventory.mjs
 *
 * Requires: SHIPSTATION_V2_API_KEY in .env.local
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const API_KEY = process.env.SHIPSTATION_V2_API_KEY;
if (!API_KEY) {
  console.error("Error: SHIPSTATION_V2_API_KEY not set in .env.local");
  console.error("Generate at: Settings → Account → API Settings → Select 'V2 API' → Generate");
  process.exit(1);
}

const BASE = "https://api.shipstation.com";
const headers = { "api-key": API_KEY, "Content-Type": "application/json" };

async function call(label, path, init = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`${init.method ?? "GET"} ${path}`);
  try {
    const res = await fetch(`${BASE}${path}`, { headers, ...init });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    try {
      const json = JSON.parse(text);
      const trunc = JSON.stringify(json, null, 2);
      console.log(trunc.length > 3000 ? trunc.slice(0, 3000) + "\n...(truncated)..." : trunc);
      return { status: res.status, body: json };
    } catch {
      console.log(text.slice(0, 500));
      return { status: res.status, body: text };
    }
  } catch (err) {
    console.error(`Network error: ${err.message}`);
    return { error: err.message };
  }
}

async function main() {
  console.log("ShipStation v2 Inventory API — Verification");
  console.log("===========================================");
  console.log(`Key prefix: ${API_KEY.slice(0, 12)}...\n`);

  // TEST 1: Warehouses
  const warehouses = await call("1. List inventory warehouses", "/v2/inventory_warehouses");

  // TEST 2: Locations
  await call("2. List inventory locations", "/v2/inventory_locations");

  // TEST 3: First page of inventory
  const inv = await call("3. List first 10 SKUs in inventory", "/v2/inventory?page_size=10");

  if (inv.body?.inventory?.[0]) {
    console.log("\n--- Sample inventory item shape ---");
    console.log(JSON.stringify(inv.body.inventory[0], null, 2));
  }

  // TEST 4: Look up a known Bandcamp SKU
  await call("4. Look up Bandcamp SKU AC-CIP-V", "/v2/inventory?sku=AC-CIP-V");
  await call("5. Look up Bandcamp SKU GH-AHFA-BV", "/v2/inventory?sku=GH-AHFA-BV");

  // TEST 5: Products
  await call("6. List products (v2)", "/v2/products?page_size=5");

  // TEST 6: Webhooks
  await call("7. List webhook subscriptions", "/v2/webhooks");

  // TEST 7: Total count
  await call("8. Total inventory size (page_size=1)", "/v2/inventory?page_size=1");

  // TEST 8: Environment info
  await call("9. Environment / account info", "/v2/environment/tags");

  console.log("\n\n=== SUMMARY — WHAT TO CHECK ===");
  console.log("  [ ] Test 1: 200 with warehouses? (need inventory_warehouse_id for pushes)");
  console.log("  [ ] Test 2: 200 with locations? (need inventory_location_id for pushes)");
  console.log("  [ ] Test 3: 200 with inventory array? (confirms shape)");
  console.log("  [ ] Test 4/5: Are Bandcamp SKUs in ShipStation already? (answers: do we need to seed?)");
  console.log("  [ ] Test 6: 200 with products? (v2 products endpoint works)");
  console.log("  [ ] Test 7: webhooks available? (inventory event webhooks for real-time sync vs polling)");
  console.log("\nCopy all output above and paste it back.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
