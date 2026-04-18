#!/usr/bin/env tsx
/**
 * Phase 8b (finish-line plan v4) — stale ShipStation v2 location auditor.
 *
 * READ-ONLY by default. Lists v2 inventory_locations across all warehouses,
 * flags those that LOOK stale (TEST-PROBE-* prefix from Phase 1, STRESS-*
 * prefix from Phase 5), and writes a single low-severity review queue
 * row summarising the candidates.
 *
 * IMPORTANT: Does NOT attempt to delete. Phase 1 §15.3 probe Case 4
 * empirically confirmed that ShipStation v2 rejects DELETE on any
 * inventory_location that has ever held inventory (HTTP 400, even with
 * 3-retry exponential backoff). The 3 TEST-PROBE locations created during
 * Phase 1 are stuck in v2 forever. The right operator action is:
 *   1. Filter STRESS- and TEST-PROBE-* names out of the warehouse picker UI
 *   2. Treat them as permanent infrastructure
 *   3. Acknowledge each via the review queue
 *
 * CLI flags:
 *   --apply              Write a review queue row (default: dry-run, only logs)
 *   --include-non-test   Include locations NOT prefixed STRESS-/TEST-/PROBE-
 *                        (paranoia gate for an operator-driven cleanup pass)
 *   --workspace=<id>     Override default-first-workspace selection
 *
 * Per finish-line plan v4 §8b: invoke twice across the day:
 *   1. After Phase 5 (stress harness)
 *   2. After Phase 7c (full ramp)
 * Phase 7 was deferred today, so run #2 is naturally postponed.
 */

import { listInventoryLocations, listInventoryWarehouses } from "@/lib/clients/shipstation-inventory-v2";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const STALE_PREFIXES = ["STRESS-", "TEST-", "PROBE-", "TEST-PROBE-"];

interface CliFlags {
  apply: boolean;
  includeNonTest: boolean;
  workspaceId: string | null;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { apply: false, includeNonTest: false, workspaceId: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") flags.apply = true;
    else if (a === "--include-non-test") flags.includeNonTest = true;
    else if (a.startsWith("--workspace=")) flags.workspaceId = a.slice("--workspace=".length);
  }
  return flags;
}

interface Candidate {
  warehouseId: string;
  inventoryLocationId: string;
  name: string;
  reason: string;
}

function classifyName(name: string, includeNonTest: boolean): string | null {
  for (const p of STALE_PREFIXES) {
    if (name.startsWith(p)) return `prefix:${p}`;
  }
  if (includeNonTest) return "operator-flagged via --include-non-test";
  return null;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  const supabase = createServiceRoleClient();

  let workspaceId = flags.workspaceId;
  if (!workspaceId) {
    const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
    if (!ws) {
      console.error("no workspace found");
      process.exit(1);
    }
    workspaceId = ws.id;
  }

  const warehouses = await listInventoryWarehouses();
  console.log(`v2 warehouses: ${warehouses.length}`);

  const candidates: Candidate[] = [];
  for (const wh of warehouses) {
    const whId = wh.inventory_warehouse_id;
    if (!whId) continue;
    const locs = await listInventoryLocations(whId);
    for (const loc of locs) {
      const locName = loc.name ?? "";
      const reason = classifyName(locName, flags.includeNonTest);
      if (!reason) continue;
      candidates.push({
        warehouseId: whId,
        inventoryLocationId: loc.inventory_location_id ?? "<unknown>",
        name: locName,
        reason,
      });
    }
  }

  console.log(`stale candidates: ${candidates.length}`);
  for (const c of candidates) {
    console.log(`  - ${c.warehouseId}/${c.inventoryLocationId} "${c.name}" (${c.reason})`);
  }

  if (candidates.length === 0) {
    console.log("no candidates — nothing to do");
    return;
  }

  if (!flags.apply) {
    console.log("dry-run (no --apply) — not writing review queue row. exiting.");
    return;
  }

  const groupKey = `stale-ss-locations:${workspaceId}:${new Date().toISOString().slice(0, 10)}`;
  const { error } = await supabase.from("warehouse_review_queue").insert({
    workspace_id: workspaceId,
    severity: "low",
    title: `Stale ShipStation v2 locations detected (${candidates.length})`,
    description: JSON.stringify(
      {
        note: "v2 rejects DELETE on locations that have ever held inventory (Phase 1 §15.3 probe Case 4). These locations cannot be removed; filter them out of the warehouse picker UI instead.",
        candidates,
      },
      null,
      2,
    ),
    group_key: groupKey,
  });

  if (error) {
    console.error(`review queue write failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`review queue row written (group_key=${groupKey})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
