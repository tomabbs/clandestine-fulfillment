/**
 * Phase 1 — §15.3 ShipStation v2 per-location semantics probe.
 *
 * Plan: docs/plans/shipstation-source-of-truth-plan.md §15.3
 * Finish-line plan: ~/.cursor/plans/megaplan-finish-line_d304e53c.plan.md Phase 1
 *
 * Question we are answering with empirical evidence:
 *   When a SKU is tracked at MULTIPLE inventory_location_ids inside the SAME
 *   warehouse, does ShipStation v2's `available` math (a) sum across locations
 *   per SKU, or (b) treat each (sku, location) as an independent row?
 *
 *   The §3f rewrite (Phase 2A) of `shipstation-v2-adjust-on-sku` only makes
 *   sense if (b) — i.e. per-location absolutes are independent. If (a),
 *   the SKU-total path is still canonical and the rewrite closes wontfix.
 *
 * Cases (executed sequentially against TEST locations and TEST SKU; cleanup
 * happens at end with 3-retry exponential backoff per finish-line plan v3):
 *
 *   Case 1 — Per-location independence
 *     Create Loc-A, Loc-B, Loc-C in warehouse se-214575.
 *     `increment` SKU at Loc-A=10, Loc-B=20, Loc-C=30.
 *     `listInventory({ skus:[testSku] })` and look at returned rows.
 *     EXPECTED if (b): three rows, available 10/20/30.
 *     EXPECTED if (a): one row, available 60.
 *
 *   Case 2 — Per-location decrement
 *     `decrement` Loc-A by 5.
 *     EXPECTED if (b): Loc-A row drops to 5; Loc-B/C unchanged.
 *     EXPECTED if (a): single row drops to 55.
 *
 *   Case 3 — Per-location modify
 *     `modify` Loc-B to new_available=15.
 *     EXPECTED if (b): Loc-B row becomes 15; others unchanged.
 *     EXPECTED if (a): single row replaced or 400 error.
 *
 *   Case 4 (NEW — v4 reviewer A §4) — DELETE on a location with prior history
 *     After cases 1-3, attempt to DELETE Loc-A which previously held inventory.
 *     Record HTTP status + raw body. NO halt on outcome — informational only,
 *     used by Phase 8b cleanup script design.
 *
 * Forensic logging (v3 review): writes the list of created location_ids +
 * test SKU id to reports/probes/ss-v2-per-location-${ts}.json BEFORE issuing
 * any deletes, so even total cleanup failure leaves an artifact for Phase 8b
 * `cleanup-stale-ss-locations.ts --apply` to sweep.
 *
 * Cleanup with 3-retry exponential backoff (1s → 2s → 4s).
 *
 * No DB writes. Uses workspace `1e59b9ca-...` warehouse `se-214575` directly
 * (NULL workspaces.shipstation_v2_inventory_warehouse_id is fine — probe is
 * standalone).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  adjustInventoryV2,
  createInventoryLocation,
  deleteInventoryLocation,
  listInventory,
} from "@/lib/clients/shipstation-inventory-v2";

const WAREHOUSE_ID = "se-214575"; // Clandestine Distirbution
const TEST_SKU = `TEST-PROBE-${Date.now()}`;

interface ProbeArtifact {
  ts: string;
  warehouse_id: string;
  test_sku: string;
  created_locations: Array<{ id: string; name: string }>;
  cases: Record<string, unknown>;
  cleanup: {
    attempts: Array<{ id: string; ok: boolean; tries: number; error?: string }>;
  };
  conclusion: {
    semantics: "per_location_independent" | "sku_total" | "indeterminate";
    rationale: string;
    phase_2a_decision: "ship_3f_rewrite" | "close_wontfix";
  };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function deleteWithRetry(id: string): Promise<{ ok: boolean; tries: number; error?: string }> {
  let tries = 0;
  let lastErr: string | undefined;
  for (const delay of [0, 1000, 2000, 4000]) {
    if (delay > 0) await sleep(delay);
    tries += 1;
    try {
      await deleteInventoryLocation(id);
      return { ok: true, tries };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, tries, error: lastErr };
}

async function tryAdjust(
  label: string,
  params: Parameters<typeof adjustInventoryV2>[0],
): Promise<{ label: string; ok: boolean; response?: unknown; error?: string }> {
  try {
    const response = await adjustInventoryV2(params);
    console.log(`  [${label}] OK`);
    return { label, ok: true, response };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`  [${label}] FAIL: ${error}`);
    return { label, ok: false, error };
  }
}

async function tryDelete(
  label: string,
  id: string,
): Promise<{ label: string; ok: boolean; status?: number; error?: string }> {
  try {
    await deleteInventoryLocation(id);
    console.log(`  [${label}] OK (200)`);
    return { label, ok: true, status: 200 };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const m = error.match(/ShipStation v2 (\d+)/);
    const status = m ? Number.parseInt(m[1], 10) : undefined;
    console.log(`  [${label}] ${status ?? "ERR"}: ${error.slice(0, 200)}`);
    return { label, ok: false, status, error };
  }
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const artifact: ProbeArtifact = {
    ts,
    warehouse_id: WAREHOUSE_ID,
    test_sku: TEST_SKU,
    created_locations: [],
    cases: {},
    cleanup: { attempts: [] },
    conclusion: {
      semantics: "indeterminate",
      rationale: "",
      phase_2a_decision: "close_wontfix",
    },
  };

  console.log(`Probe starting — warehouse=${WAREHOUSE_ID} test_sku=${TEST_SKU}`);

  console.log("\nCreating 3 test locations...");
  const locA = await createInventoryLocation({
    inventory_warehouse_id: WAREHOUSE_ID,
    name: `TEST-PROBE-A-${ts}`,
  });
  artifact.created_locations.push({ id: locA.inventory_location_id, name: `TEST-PROBE-A-${ts}` });
  console.log(`  Loc-A=${locA.inventory_location_id}`);

  const locB = await createInventoryLocation({
    inventory_warehouse_id: WAREHOUSE_ID,
    name: `TEST-PROBE-B-${ts}`,
  });
  artifact.created_locations.push({ id: locB.inventory_location_id, name: `TEST-PROBE-B-${ts}` });
  console.log(`  Loc-B=${locB.inventory_location_id}`);

  const locC = await createInventoryLocation({
    inventory_warehouse_id: WAREHOUSE_ID,
    name: `TEST-PROBE-C-${ts}`,
  });
  artifact.created_locations.push({ id: locC.inventory_location_id, name: `TEST-PROBE-C-${ts}` });
  console.log(`  Loc-C=${locC.inventory_location_id}`);

  // Forensic dump BEFORE any state-changing operations on the SKU.
  const out = join("reports", "probes", `ss-v2-per-location-${ts}.json`);
  writeFileSync(out, JSON.stringify(artifact, null, 2));
  console.log(`\nForensic snapshot written to ${out}`);

  try {
    // ─── Case 1: increment 10/20/30 across A/B/C ─────────────────────────────
    console.log("\nCase 1 — increment 10/20/30 across Loc-A/B/C");
    const case1 = {
      seed: [
        await tryAdjust("Loc-A +10", {
          sku: TEST_SKU,
          inventory_warehouse_id: WAREHOUSE_ID,
          inventory_location_id: locA.inventory_location_id,
          transaction_type: "increment",
          quantity: 10,
          reason: "phase1-probe-case1-A",
        }),
        await tryAdjust("Loc-B +20", {
          sku: TEST_SKU,
          inventory_warehouse_id: WAREHOUSE_ID,
          inventory_location_id: locB.inventory_location_id,
          transaction_type: "increment",
          quantity: 20,
          reason: "phase1-probe-case1-B",
        }),
        await tryAdjust("Loc-C +30", {
          sku: TEST_SKU,
          inventory_warehouse_id: WAREHOUSE_ID,
          inventory_location_id: locC.inventory_location_id,
          transaction_type: "increment",
          quantity: 30,
          reason: "phase1-probe-case1-C",
        }),
      ],
      read_after: await listInventory({
        skus: [TEST_SKU],
        inventory_warehouse_id: WAREHOUSE_ID,
      }),
    };
    artifact.cases.case1 = case1;
    console.log(`  → ${case1.read_after.length} rows returned`);
    for (const row of case1.read_after) {
      console.log(
        `    sku=${row.sku} loc=${row.inventory_location_id} on_hand=${row.on_hand} avail=${row.available}`,
      );
    }

    // ─── Case 2: decrement Loc-A by 5 ─────────────────────────────────────────
    console.log("\nCase 2 — decrement Loc-A by 5");
    const case2 = {
      action: await tryAdjust("Loc-A -5", {
        sku: TEST_SKU,
        inventory_warehouse_id: WAREHOUSE_ID,
        inventory_location_id: locA.inventory_location_id,
        transaction_type: "decrement",
        quantity: 5,
        reason: "phase1-probe-case2",
      }),
      read_after: await listInventory({
        skus: [TEST_SKU],
        inventory_warehouse_id: WAREHOUSE_ID,
      }),
    };
    artifact.cases.case2 = case2;
    console.log(`  → ${case2.read_after.length} rows`);
    for (const row of case2.read_after) {
      console.log(
        `    sku=${row.sku} loc=${row.inventory_location_id} on_hand=${row.on_hand} avail=${row.available}`,
      );
    }

    // ─── Case 3: modify Loc-B to new_available=15 ─────────────────────────────
    console.log("\nCase 3 — modify Loc-B to new_available=15");
    const case3 = {
      action: await tryAdjust("Loc-B modify 15", {
        sku: TEST_SKU,
        inventory_warehouse_id: WAREHOUSE_ID,
        inventory_location_id: locB.inventory_location_id,
        transaction_type: "modify",
        new_available: 15,
        reason: "phase1-probe-case3",
      }),
      read_after: await listInventory({
        skus: [TEST_SKU],
        inventory_warehouse_id: WAREHOUSE_ID,
      }),
    };
    artifact.cases.case3 = case3;
    console.log(`  → ${case3.read_after.length} rows`);
    for (const row of case3.read_after) {
      console.log(
        `    sku=${row.sku} loc=${row.inventory_location_id} on_hand=${row.on_hand} avail=${row.available}`,
      );
    }

    // ─── Case 4 (v4 reviewer A §4): DELETE on a location with prior history ───
    console.log("\nCase 4 — DELETE Loc-A (which held inventory)");
    const case4 = {
      action: await tryDelete("DELETE Loc-A with history", locA.inventory_location_id),
    };
    artifact.cases.case4 = case4;

    // ─── Conclusion ──────────────────────────────────────────────────────────
    const case1Rows = case1.read_after.length;
    if (case1Rows >= 3) {
      artifact.conclusion = {
        semantics: "per_location_independent",
        rationale: `Case 1 returned ${case1Rows} distinct rows after seeding 3 locations. Per-location semantics confirmed — the §3f rewrite is meaningful.`,
        phase_2a_decision: "ship_3f_rewrite",
      };
    } else if (case1Rows === 1) {
      const total =
        case1.read_after[0]?.available ?? case1.read_after[0]?.on_hand ?? 0;
      const isSum = total >= 55 && total <= 65;
      artifact.conclusion = {
        semantics: isSum ? "sku_total" : "indeterminate",
        rationale: isSum
          ? `Case 1 returned 1 row with available≈60 (=10+20+30). v2 collapses per-location seeds into a SKU total. §3f rewrite is moot.`
          : `Case 1 returned 1 row with unexpected available=${total}. Indeterminate — manual review required.`,
        phase_2a_decision: isSum ? "close_wontfix" : "close_wontfix",
      };
    } else {
      artifact.conclusion = {
        semantics: "indeterminate",
        rationale: `Case 1 returned ${case1Rows} rows. Indeterminate — manual review required.`,
        phase_2a_decision: "close_wontfix",
      };
    }

    console.log(`\nConclusion: ${artifact.conclusion.semantics}`);
    console.log(`  → ${artifact.conclusion.rationale}`);
    console.log(`  → Phase 2A decision: ${artifact.conclusion.phase_2a_decision}`);
  } finally {
    // ─── Cleanup with 3-retry exponential backoff (v3 review) ────────────────
    // Note Loc-A may already be deleted by Case 4; deleteWithRetry handles
    // 404s as failures but the artifact has the original IDs for Phase 8b.
    console.log("\nCleanup (3-retry exp backoff)...");
    for (const loc of artifact.created_locations) {
      const r = await deleteWithRetry(loc.id);
      artifact.cleanup.attempts.push({ id: loc.id, ...r });
      console.log(`  ${loc.id}: ok=${r.ok} tries=${r.tries}${r.error ? " err=" + r.error.slice(0, 100) : ""}`);
    }
    writeFileSync(out, JSON.stringify(artifact, null, 2));
    console.log(`\nFinal artifact: ${out}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
