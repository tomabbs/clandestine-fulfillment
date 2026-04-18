#!/usr/bin/env node
/**
 * ShipStation v2 inventory — 1 → 0 transition probe (Patch D2).
 *
 * Phase 0 BLOCKER for Phase 4 fanout. The existing
 * `scripts/test-shipstation-v2-inventory.mjs` only confirms the v2 inventory
 * API works on read paths and that `quantity: 0` is rejected on the SEED
 * write. It does not exercise what happens when an existing tracked SKU
 * goes from `available: 1` to `available: 0` via `decrement`, `adjust`, or
 * `modify`. That answer determines what `transaction_type` the
 * `inventory-fanout.ts` module must use at the 1 → 0 boundary
 * (plan §7.1.6 / §1.4.1).
 *
 * Test matrix (per plan §5.1 Patch D2):
 *
 *   1. Seed sandbox SKU at available: 1   → expect 200
 *   2. decrement by 1                     → 200 means 1→0 works via decrement
 *                                           400 means fanout MUST switch to adjust
 *   3. adjust to quantity: 0 (re-seed 1 first if step 2 succeeded)
 *                                         → originally expected 400 by symmetry
 *                                           with seed; ACTUAL FINDING (see plan
 *                                           §5.1): adjust DOES accept 0 on an
 *                                           already-tracked row (asymmetric).
 *   4. modify with new_available: 0 (re-seed 1 first if needed)
 *                                         → originally posited as the safety net.
 *                                           ACTUAL FINDING: rejected with
 *                                           "Must be greater than or equal to 1."
 *                                           `modify` cannot zero a SKU; use
 *                                           `decrement` (preferred — matches the
 *                                           natural delta) or `adjust quantity:0`.
 *
 * Records the FULL response (status + body) for every step so the decision
 * matrix can be committed verbatim to plan §5.1.
 *
 * Cleanup: deletes the sandbox SKU's inventory row at the end via a final
 * modify to new_available: 0. The probe SKU is namespaced
 * `CLAND-PROBE-DEC0-<unix-ts>` so it cannot collide with real catalog data.
 *
 * Usage:
 *   node scripts/test-shipstation-v2-decrement-to-zero.mjs
 *
 * Requires: SHIPSTATION_V2_API_KEY in .env.local
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const API_KEY = process.env.SHIPSTATION_V2_API_KEY;
if (!API_KEY) {
  console.error("Error: SHIPSTATION_V2_API_KEY not set in .env.local");
  console.error(
    "Generate at: ShipStation → Settings → Account → API Settings → 'V2 API' → Generate",
  );
  process.exit(1);
}

const BASE = "https://api.shipstation.com";
const headers = { "api-key": API_KEY, "Content-Type": "application/json" };

const PROBE_SKU = `CLAND-PROBE-DEC0-${Date.now()}`;

const results = {
  probe_sku: PROBE_SKU,
  ran_at: new Date().toISOString(),
  steps: [],
  decision: null,
  warnings: [],
};

async function call(label, path, init = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`${init.method ?? "GET"} ${path}`);
  if (init.body) {
    try {
      console.log("Request body:", JSON.stringify(JSON.parse(init.body), null, 2));
    } catch {
      console.log("Request body:", init.body);
    }
  }
  let status = 0;
  let body;
  let raw;
  try {
    const res = await fetch(`${BASE}${path}`, { headers, ...init });
    status = res.status;
    raw = await res.text();
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    console.log(`Status: ${status}`);
    const printable = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    console.log(printable.length > 2000 ? `${printable.slice(0, 2000)}\n...(truncated)` : printable);
  } catch (err) {
    console.error(`Network error: ${err.message}`);
    body = { network_error: err.message };
  }
  return { label, status, body };
}

async function getInventory(sku) {
  return call(
    `Read back inventory for ${sku}`,
    `/v2/inventory?sku=${encodeURIComponent(sku)}`,
  );
}

async function ensureWarehouseAndLocation() {
  const wh = await call("Discover warehouses", "/v2/inventory_warehouses");
  const warehouses = wh.body?.inventory_warehouses ?? wh.body?.warehouses ?? [];
  if (!warehouses.length) {
    throw new Error("No inventory warehouses returned by v2 API — cannot run probe");
  }
  const warehouse = warehouses[0];
  const warehouseId = warehouse.inventory_warehouse_id ?? warehouse.warehouse_id;
  console.log(`\nUsing warehouse: ${warehouseId} (${warehouse.name ?? "unnamed"})`);

  const locs = await call(
    "Discover locations in that warehouse",
    `/v2/inventory_locations?inventory_warehouse_id=${encodeURIComponent(warehouseId)}`,
  );
  const locations = locs.body?.inventory_locations ?? locs.body?.locations ?? [];
  if (!locations.length) {
    throw new Error(`Warehouse ${warehouseId} has no locations — cannot run probe`);
  }
  const location = locations[0];
  const locationId = location.inventory_location_id ?? location.location_id;
  console.log(`Using location:  ${locationId} (${location.name ?? "unnamed"})`);

  return { warehouseId, locationId };
}

async function step1_seed(warehouseId, locationId) {
  const r = await call("STEP 1 — seed sandbox SKU at available: 1", "/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      transaction_type: "increment",
      sku: PROBE_SKU,
      quantity: 1,
      inventory_warehouse_id: warehouseId,
      inventory_location_id: locationId,
      reason: "Phase 0 Patch D2 decrement-to-zero probe — initial seed",
    }),
  });
  results.steps.push({
    step: 1,
    operation: "increment from 0 to 1 (seed)",
    expected: "200 OK",
    status: r.status,
    body: r.body,
    interpretation: r.status === 200 ? "PASS — sandbox SKU created" : "FAIL — cannot run remaining matrix",
  });
  if (r.status !== 200) {
    results.warnings.push("Seed step did not return 200; aborting before destructive steps");
    throw new Error(`Step 1 failed with HTTP ${r.status}; cannot proceed`);
  }
  await getInventory(PROBE_SKU);
}

async function step2_decrement(warehouseId, locationId) {
  const r = await call("STEP 2 — decrement by 1 (1 → 0)", "/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      transaction_type: "decrement",
      sku: PROBE_SKU,
      quantity: 1,
      inventory_warehouse_id: warehouseId,
      inventory_location_id: locationId,
      reason: "Phase 0 Patch D2 decrement-to-zero probe — STEP 2",
    }),
  });
  const after = await getInventory(PROBE_SKU);
  results.steps.push({
    step: 2,
    operation: "decrement by 1 (1 → 0)",
    expected: "200 OK with available: 0",
    status: r.status,
    body: r.body,
    available_after: extractAvailable(after.body),
    interpretation:
      r.status === 200
        ? "PASS — fanout may use `decrement` for the 1 → 0 boundary"
        : `FAIL (HTTP ${r.status}) — fanout MUST switch to \`modify\` for 1 → 0`,
  });
  return r.status === 200;
}

async function step3_adjust(warehouseId, locationId) {
  // If step 2 succeeded the SKU is at 0; re-seed back to 1 so adjust→0 is meaningful.
  await call("STEP 3a — re-seed to available: 1 before adjust", "/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      transaction_type: "increment",
      sku: PROBE_SKU,
      quantity: 1,
      inventory_warehouse_id: warehouseId,
      inventory_location_id: locationId,
      reason: "Phase 0 Patch D2 — pre-adjust reseed",
    }),
  });
  const r = await call("STEP 3b — adjust to quantity: 0 (1 → 0 via adjust)", "/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      transaction_type: "adjust",
      sku: PROBE_SKU,
      quantity: 0,
      inventory_warehouse_id: warehouseId,
      inventory_location_id: locationId,
      reason: "Phase 0 Patch D2 decrement-to-zero probe — STEP 3",
    }),
  });
  const after = await getInventory(PROBE_SKU);
  results.steps.push({
    step: 3,
    operation: "adjust to 0 (1 → 0)",
    expected: "Likely 400 by symmetry with seed (quantity >= 1)",
    status: r.status,
    body: r.body,
    available_after: extractAvailable(after.body),
    interpretation:
      r.status === 200
        ? "PASS — `adjust` accepts quantity: 0 on existing rows (asymmetry vs seed)"
        : `EXPECTED FAIL (HTTP ${r.status}) — \`adjust\` rejects quantity: 0; use \`modify\``,
  });
}

async function step4_modify(warehouseId, locationId) {
  // Re-seed in case step 3 succeeded and zeroed it; modify works regardless but be deterministic.
  await call("STEP 4a — re-seed to available: 1 before modify", "/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      transaction_type: "increment",
      sku: PROBE_SKU,
      quantity: 1,
      inventory_warehouse_id: warehouseId,
      inventory_location_id: locationId,
      reason: "Phase 0 Patch D2 — pre-modify reseed",
    }),
  });
  const r = await call("STEP 4b — modify with new_available: 0", "/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      transaction_type: "modify",
      sku: PROBE_SKU,
      new_available: 0,
      inventory_warehouse_id: warehouseId,
      inventory_location_id: locationId,
      reason: "Phase 0 Patch D2 decrement-to-zero probe — STEP 4",
    }),
  });
  const after = await getInventory(PROBE_SKU);
  results.steps.push({
    step: 4,
    operation: "modify new_available: 0 (1 → 0)",
    expected: "200 OK with available: 0 — `modify` is the safety net",
    status: r.status,
    body: r.body,
    available_after: extractAvailable(after.body),
    interpretation:
      r.status === 200
        ? "PASS — `modify` is the safe fallback for any rejected 1 → 0 transition"
        : `CRITICAL (HTTP ${r.status}) — even \`modify\` rejected; escalate to ShipStation support`,
  });
}

function extractAvailable(body) {
  if (!body || typeof body !== "object") return null;
  const arr = body.inventory ?? body.items ?? null;
  if (Array.isArray(arr) && arr.length) {
    const item = arr[0];
    return item.available ?? item.on_hand ?? item.quantity_available ?? null;
  }
  return body.available ?? body.on_hand ?? null;
}

function summarize() {
  const decrementOk = results.steps.find((s) => s.step === 2)?.status === 200;
  const adjustOk = results.steps.find((s) => s.step === 3)?.status === 200;
  const modifyOk = results.steps.find((s) => s.step === 4)?.status === 200;

  // Empirical finding (Phase 0 run, 2026-04-17): `modify new_available: 0`
  // is rejected by v2. The real safety net is `adjust quantity: 0`.
  if (decrementOk) {
    results.decision = {
      fanout_strategy_at_one_to_zero: "decrement",
      rationale:
        "ShipStation v2 accepts a `decrement` from 1 to 0. Fanout uses the natural delta operation; no special-case branch required at the 1 → 0 boundary.",
      adjust_works: adjustOk,
      modify_works_for_zero: modifyOk,
      safety_net: adjustOk
        ? "adjust quantity: 0 (proven on this run)"
        : "none other than decrement; investigate before Phase 4",
    };
  } else if (adjustOk) {
    results.decision = {
      fanout_strategy_at_one_to_zero: "adjust",
      rationale:
        "ShipStation v2 rejects `decrement` to 0 but accepts `adjust quantity: 0`. `inventory-fanout.ts` MUST detect the 1 → 0 boundary and switch to `adjust quantity: 0`. Plan §7.1.6 + §1.4.1 require amendment.",
      adjust_works: true,
      modify_works_for_zero: modifyOk,
    };
  } else if (modifyOk) {
    results.decision = {
      fanout_strategy_at_one_to_zero: "modify",
      rationale:
        "ShipStation v2 rejects both `decrement` and `adjust` to 0; only `modify new_available: 0` works. This contradicts the empirical finding from the 2026-04-17 run — re-verify before relying on it.",
      adjust_works: false,
      modify_works_for_zero: true,
    };
  } else {
    results.decision = {
      fanout_strategy_at_one_to_zero: "BLOCKED",
      rationale:
        "All three transaction types failed to land available: 0. Phase 4 fanout cannot ship. Escalate to ShipStation support before continuing.",
    };
  }

  console.log("\n\n=================================================================");
  console.log("PROBE SUMMARY (paste into plan §5.1 Patch D2 results section)");
  console.log("=================================================================");
  console.log(JSON.stringify(results, null, 2));
  console.log("\nDecision (also goes in plan §7.1.6):");
  console.log(`  → fanout strategy at 1 → 0: ${results.decision.fanout_strategy_at_one_to_zero}`);
  console.log(`  → ${results.decision.rationale}`);
}

async function main() {
  console.log("ShipStation v2 — decrement-to-zero probe (Patch D2)");
  console.log("====================================================");
  console.log(`Probe SKU: ${PROBE_SKU}`);
  console.log(`Key prefix: ${API_KEY.slice(0, 12)}...\n`);

  let warehouseId;
  let locationId;
  try {
    ({ warehouseId, locationId } = await ensureWarehouseAndLocation());
  } catch (err) {
    console.error(`Discovery failed: ${err.message}`);
    process.exit(1);
  }

  try {
    await step1_seed(warehouseId, locationId);
    await step2_decrement(warehouseId, locationId);
    await step3_adjust(warehouseId, locationId);
    await step4_modify(warehouseId, locationId);
  } catch (err) {
    console.error(`\nProbe aborted: ${err.message}`);
  } finally {
    // Final cleanup: ensure the probe SKU is zeroed.
    //
    // Empirically (this script's own findings), `modify new_available: 0`
    // is rejected by ShipStation v2 with "quantity: Must be greater than or
    // equal to 1." So we read current `available` and post a matching
    // `decrement` delta — the only operation proven to land at 0.
    try {
      const current = await getInventory(PROBE_SKU);
      const available = extractAvailable(current.body);
      if (typeof available === "number" && available > 0) {
        await call(`CLEANUP — decrement probe SKU by ${available} to land at 0`, "/v2/inventory", {
          method: "POST",
          body: JSON.stringify({
            transaction_type: "decrement",
            sku: PROBE_SKU,
            quantity: available,
            inventory_warehouse_id: warehouseId,
            inventory_location_id: locationId,
            reason: "Phase 0 Patch D2 probe — final cleanup (zero via decrement)",
          }),
        });
      } else {
        console.log(`\nCleanup skipped — probe SKU already at ${available ?? "unknown"}.`);
      }
    } catch (err) {
      results.warnings.push(`Cleanup failed: ${err.message}`);
    }
    summarize();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
