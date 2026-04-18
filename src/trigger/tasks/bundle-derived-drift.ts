/**
 * Bundle derived-drift sensor — Phase 2.5(c) (plan §7.1.5).
 *
 * Phase 2.5(a) deliberately EXCLUDES bundle parent variants from the
 * `shipstation-seed-inventory` task because a bundle's availability is
 * derived from its components, not stored as a standalone v2 row. But
 * ShipStation v2 may still hold a row for a bundle SKU because:
 *   (1) the merchant manually added it via the ShipStation UI before
 *       Clandestine took over inventory truth, or
 *   (2) a future version of Phase 4 ends up pushing a derived value
 *       (so the sensor double-checks our own derivation), or
 *   (3) ShipStation's catalog import created the SKU as a side effect
 *       of an order line item.
 *
 * Whichever path put the row there, we want a sensor that catches when
 * v2's stored `available` drifts from our derived value. The sensor is
 * a scheduled Trigger task pinned to `shipstationQueue` so it shares
 * the v2 60 req/min budget with seed and SHIP_NOTIFY processing.
 *
 * Algorithm (per workspace):
 *   1. Load every bundle parent variant (`bundle_components.bundle_variant_id`)
 *      with its components.
 *   2. Bulk-load `warehouse_inventory_levels` for every component variant
 *      (one query per workspace, no N+1).
 *   3. Compute the derived value via `computeEffectiveBundleAvailable(
 *        bundle_stock, components, componentInventory)` — the same shared
 *      helper Bandcamp fanout uses (Phase 2.5(b)).
 *   4. Batch-fetch v2 inventory for the bundle SKUs via `listInventory({ skus })`
 *      (the v2 client is batch-only — Rule from TRUTH_LAYER).
 *   5. For each bundle SKU that v2 returns: if `|v2.available - derived| >
 *      DRIFT_TOLERANCE`, upsert a `warehouse_review_queue` row keyed on
 *      `group_key='bundle.derived_drift:{workspace_id}:{sku}'` (idempotent —
 *      Rule #55 dedupe semantics). Bundle SKUs that v2 does NOT have are
 *      silently skipped — they are the (a) exclusion case.
 *   6. Log a `channel_sync_log` row per workspace summarizing the run.
 *
 * The sensor never writes to v2 inventory itself; it is purely a detector.
 *
 * Cron: hourly (`0 * * * *`). Bundle composition rarely changes, so an
 * hourly cadence catches drift fast enough for ops without burning the v2
 * budget. The schedule is exported separately so the test surface stays
 * pure.
 *
 * Rule #7: createServiceRoleClient. Rule #20: never bypasses
 * `recordInventoryChange` (it does not write inventory at all). Rule #59
 * exception does NOT apply (this is a sensor, not a bulk sync).
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import { listInventory } from "@/lib/clients/shipstation-inventory-v2";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { type BundleComponentSpec, computeEffectiveBundleAvailable } from "@/lib/server/bundles";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

/**
 * Quantity-difference tolerance before we open a review item. Bundles can
 * race between a SHIP_NOTIFY decrement and the next sensor pass; one or
 * two units of drift inside a few minutes is normal. Three or more is a
 * real divergence worth a staff look.
 */
export const BUNDLE_DRIFT_TOLERANCE = 2;

export interface BundleDriftSensorPayload {
  /**
   * Optional list of workspace IDs to scope the run. Defaults to every
   * workspace returned by `getAllWorkspaceIds`. Keeps tests narrow.
   */
  workspaceIds?: string[];
  /** Skip the v2 fetch — used by tests that pre-stub the listInventory call. */
  skipShipstationFetch?: boolean;
}

export interface BundleDriftSensorRow {
  sku: string;
  bundle_variant_id: string;
  derived: number;
  v2_available: number;
  drift: number;
}

export interface BundleDriftSensorWorkspaceResult {
  workspaceId: string;
  bundlesEvaluated: number;
  v2RowsFound: number;
  driftDetected: number;
  reviewItemsUpserted: number;
  drifts: BundleDriftSensorRow[];
  notes?: string;
}

export interface BundleDriftSensorResult {
  workspaces: BundleDriftSensorWorkspaceResult[];
}

interface BundleComponentRow {
  bundle_variant_id: string;
  component_variant_id: string;
  quantity: number;
}

interface BundleVariantRow {
  id: string;
  sku: string | null;
}

interface InventoryLevelRow {
  variant_id: string;
  available: number;
}

/**
 * Inner run function — exported so tests can drive it without spinning up
 * Trigger.dev's task wrapper. Accepts a Supabase-shaped client and an
 * optional `inventoryFetcher` so the v2 HTTP call can be stubbed.
 */
export async function runBundleDerivedDriftSensor(
  payload: BundleDriftSensorPayload,
  ctx: { run: { id: string } },
  deps: {
    supabase: ReturnType<typeof createServiceRoleClient>;
    inventoryFetcher?: typeof listInventory;
    getWorkspaceIds?: typeof getAllWorkspaceIds;
  },
): Promise<BundleDriftSensorResult> {
  const supabase = deps.supabase;
  const fetchInventory = payload.skipShipstationFetch
    ? async () => []
    : (deps.inventoryFetcher ?? listInventory);
  const getWorkspaces = deps.getWorkspaceIds ?? getAllWorkspaceIds;

  const workspaceIds =
    payload.workspaceIds && payload.workspaceIds.length > 0
      ? payload.workspaceIds
      : await getWorkspaces(supabase);

  const result: BundleDriftSensorResult = { workspaces: [] };

  for (const workspaceId of workspaceIds) {
    const startedAt = new Date().toISOString();
    const wsResult = await runWorkspace(workspaceId, ctx, fetchInventory, supabase);
    result.workspaces.push(wsResult);

    await supabase.from("channel_sync_log").insert({
      workspace_id: workspaceId,
      channel: "shipstation_v2",
      sync_type: "bundle_derived_drift",
      status: "completed",
      items_processed: wsResult.bundlesEvaluated,
      items_failed: wsResult.driftDetected,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      metadata: {
        run_id: ctx.run.id,
        v2_rows_found: wsResult.v2RowsFound,
        review_items_upserted: wsResult.reviewItemsUpserted,
        notes: wsResult.notes ?? null,
      },
    });
  }

  return result;
}

async function runWorkspace(
  workspaceId: string,
  ctx: { run: { id: string } },
  fetchInventory: typeof listInventory,
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<BundleDriftSensorWorkspaceResult> {
  const baseResult: BundleDriftSensorWorkspaceResult = {
    workspaceId,
    bundlesEvaluated: 0,
    v2RowsFound: 0,
    driftDetected: 0,
    reviewItemsUpserted: 0,
    drifts: [],
  };

  const { data: components } = await supabase
    .from("bundle_components")
    .select("bundle_variant_id, component_variant_id, quantity")
    .eq("workspace_id", workspaceId);
  const componentRows = (components ?? []) as BundleComponentRow[];
  if (componentRows.length === 0) {
    baseResult.notes = "no_bundles";
    return baseResult;
  }

  const bundleIds = Array.from(new Set(componentRows.map((c) => c.bundle_variant_id)));
  const componentIds = Array.from(new Set(componentRows.map((c) => c.component_variant_id)));
  const allVariantIds = Array.from(new Set([...bundleIds, ...componentIds]));

  const { data: variants } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku")
    .in("id", bundleIds);
  const bundleSkuById = new Map<string, string>();
  for (const v of (variants ?? []) as BundleVariantRow[]) {
    if (v.sku) bundleSkuById.set(v.id, v.sku);
  }

  const { data: levels } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id, available")
    .in("variant_id", allVariantIds);
  const inventoryByVariant = new Map<string, { available: number }>(
    ((levels ?? []) as InventoryLevelRow[]).map((l) => [
      l.variant_id,
      { available: Number(l.available) || 0 },
    ]),
  );

  const componentsByBundle = new Map<string, BundleComponentSpec[]>();
  for (const c of componentRows) {
    const arr = componentsByBundle.get(c.bundle_variant_id) ?? [];
    arr.push({ component_variant_id: c.component_variant_id, quantity: c.quantity });
    componentsByBundle.set(c.bundle_variant_id, arr);
  }

  const derivedBySku = new Map<string, { bundleVariantId: string; derived: number }>();
  for (const bundleId of bundleIds) {
    const sku = bundleSkuById.get(bundleId);
    if (!sku) continue;
    const components = componentsByBundle.get(bundleId) ?? [];
    const bundleStock = inventoryByVariant.get(bundleId)?.available ?? 0;
    const derived = computeEffectiveBundleAvailable(bundleStock, components, inventoryByVariant);
    derivedBySku.set(sku, { bundleVariantId: bundleId, derived });
  }
  baseResult.bundlesEvaluated = derivedBySku.size;
  if (derivedBySku.size === 0) {
    baseResult.notes = "no_bundle_skus";
    return baseResult;
  }

  const v2Records = await fetchInventory({ skus: Array.from(derivedBySku.keys()) });
  baseResult.v2RowsFound = v2Records.length;

  for (const record of v2Records) {
    const ours = derivedBySku.get(record.sku);
    if (!ours) continue;
    const v2Available = Number(record.available) || 0;
    const drift = v2Available - ours.derived;
    if (Math.abs(drift) <= BUNDLE_DRIFT_TOLERANCE) continue;

    baseResult.driftDetected++;
    baseResult.drifts.push({
      sku: record.sku,
      bundle_variant_id: ours.bundleVariantId,
      derived: ours.derived,
      v2_available: v2Available,
      drift,
    });

    const groupKey = `bundle.derived_drift:${workspaceId}:${record.sku}`;
    const { data: existing } = await supabase
      .from("warehouse_review_queue")
      .select("id, occurrence_count")
      .eq("group_key", groupKey)
      .eq("status", "open")
      .maybeSingle();

    if (existing?.id) {
      await supabase
        .from("warehouse_review_queue")
        .update({
          occurrence_count: ((existing.occurrence_count as number) ?? 1) + 1,
          last_seen_at: new Date().toISOString(),
          metadata: {
            sku: record.sku,
            bundle_variant_id: ours.bundleVariantId,
            derived: ours.derived,
            v2_available: v2Available,
            drift,
            sensor_run_id: ctx.run.id,
          },
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: workspaceId,
        category: "inventory_drift",
        severity: "medium",
        title: `Bundle drift on ${record.sku}: ShipStation v2=${v2Available}, derived=${ours.derived}`,
        description: `The bundle SKU ${record.sku} shows |drift|=${Math.abs(drift)} units between ShipStation v2's stored available (${v2Available}) and the value derived from its components (${ours.derived}). This usually means either a manual ShipStation edit, an out-of-band fanout, or a stale component count. Bundles are intentionally NOT seeded by shipstation-seed-inventory (Phase 2.5(a)); the v2 row exists from the merchant's pre-existing setup or a fanout side effect.`,
        metadata: {
          sku: record.sku,
          bundle_variant_id: ours.bundleVariantId,
          derived: ours.derived,
          v2_available: v2Available,
          drift,
          sensor_run_id: ctx.run.id,
        },
        group_key: groupKey,
        status: "open",
        occurrence_count: 1,
      });
      baseResult.reviewItemsUpserted++;
    }
  }

  logger.info("[bundle-derived-drift] workspace done", {
    workspaceId,
    bundlesEvaluated: baseResult.bundlesEvaluated,
    v2RowsFound: baseResult.v2RowsFound,
    driftDetected: baseResult.driftDetected,
  });

  return baseResult;
}

export const bundleDerivedDriftSensorTask = task({
  id: "bundle-derived-drift-sensor",
  queue: shipstationQueue,
  maxDuration: 300,
  run: async (payload: BundleDriftSensorPayload, { ctx }): Promise<BundleDriftSensorResult> =>
    runBundleDerivedDriftSensor(payload, ctx, { supabase: createServiceRoleClient() }),
});

export const bundleDerivedDriftSensorSchedule = schedules.task({
  id: "bundle-derived-drift-sensor-schedule",
  cron: "0 * * * *",
  queue: shipstationQueue,
  maxDuration: 300,
  run: async (_payload, { ctx }): Promise<BundleDriftSensorResult> =>
    runBundleDerivedDriftSensor({}, ctx, { supabase: createServiceRoleClient() }),
});
