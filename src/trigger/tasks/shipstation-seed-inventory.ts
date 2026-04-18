/**
 * ShipStation v2 inventory seed task — Phase 3 (plan §7.1.5).
 *
 * One-shot per workspace: enables inventory tracking + sets initial
 * quantities in ShipStation v2 for every fulfillment-client SKU that
 * passes the seed gate. Re-runnable safely thanks to the
 * `external_sync_events` ledger (plan §1.4.2): a duplicate
 * (system, correlation_id, sku, action) row collides on insert and the
 * second run skips the SKU.
 *
 * Seed selection rules (in order, per plan §7.1.5):
 *   1. Variant has `org_id IS NOT NULL` (fulfillment client product — distro
 *      items with `org_id IS NULL` are NEVER seeded into ShipStation v2).
 *   2. Variant has a Bandcamp mapping with `push_mode = 'normal'` (excludes
 *      `blocked_baseline`, `blocked_multi_origin`, `manual_override`).
 *   3. Bandcamp origin sum > 0 (use `computeEffectiveBandcampAvailable`,
 *      NOT the customer-facing TOP `quantity_available` — Part 9 audit).
 *   4. Variant is NOT a bundle parent (Phase 2.5 (a) — bundles derive
 *      availability from components and must not be seeded as standalone
 *      SKUs).
 *   5. `warehouse_inventory_levels.available > 0` (zero-stock policy:
 *      do NOT auto-enable tracking for zero-stock SKUs; ShipStation will
 *      create the inventory row implicitly the first time
 *      `recordInventoryChange` fires an increment for it).
 *
 * Quantity to push: `warehouse_inventory_levels.available` per variant —
 * the warehouse-truth value. Phase 1's seed correction in `bandcamp-sync`
 * (when `authority_status = 'bandcamp_initial'`) populates this from the
 * Bandcamp origin sum upstream, so by the time Phase 3 runs the warehouse
 * value IS the effective Bandcamp available. The reconcile sensor
 * (Phase 5) catches any drift.
 *
 * Idempotency: `correlation_id = "seed:{workspace_id}:{run_id}"` per run.
 * On retry, the SAME run_id is reused (Trigger.dev replays use the original
 * `ctx.run.id`), so duplicate ledger inserts skip the SKU.
 *
 * Concurrency: pinned to `shipstationQueue` (concurrencyLimit: 1) — same
 * queue used by `process-shipstation-shipment` so seed bursts cannot
 * starve real-time SHIP_NOTIFY processing or vice versa.
 *
 * Rule #7: createServiceRoleClient — bypasses RLS to read mappings and
 * inventory levels across the workspace.
 * Rule #59: bulk-style task (NOT routed through `recordInventoryChange()`).
 *           This is a catalog-shaped operation; the v2 ledger provides
 *           idempotency and the reconcile sensor provides drift coverage.
 * Rule #12: payload IDs only.
 */

import { logger, task } from "@trigger.dev/sdk";
import { adjustInventoryV2 } from "@/lib/clients/shipstation-inventory-v2";
import { computeEffectiveBandcampAvailable } from "@/lib/server/bandcamp-effective-available";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface ShipstationSeedPayload {
  workspaceId: string;
  inventoryWarehouseId: string;
  inventoryLocationId: string;
  /**
   * When true, the task evaluates every variant against the seed rules
   * and reports counts but DOES NOT call `adjustInventoryV2`. Used by the
   * admin "Preview" button so staff can sanity-check selection counts
   * before committing.
   */
  dryRun?: boolean;
}

export interface ShipstationSeedResult {
  workspace_id: string;
  dry_run: boolean;
  /** Variants matched by `org_id IS NOT NULL` for this workspace. */
  candidates: number;
  /** Variants excluded because they appear as `bundle_components.bundle_variant_id`. */
  bundle_excluded: number;
  /** Variants excluded because the Bandcamp mapping is missing or push_mode != 'normal'. */
  blocked_by_push_mode: number;
  /** Variants excluded because Bandcamp origin sum is 0 or unknown. */
  blocked_zero_origin_sum: number;
  /** Variants excluded because `warehouse_inventory_levels.available <= 0`. */
  blocked_zero_warehouse_stock: number;
  /** SKUs that successfully reached `adjustInventoryV2` (or would have, in dry-run). */
  seeded: number;
  /** SKUs whose ledger row already existed (`already_in_flight` / `already_succeeded`). */
  ledger_skipped: number;
  /** SKUs that errored during the v2 call. */
  errors: number;
}

interface VariantRow {
  id: string;
  sku: string;
  warehouse_products: { org_id: string | null } | null;
}

interface MappingRow {
  variant_id: string;
  push_mode: string;
  bandcamp_origin_quantities: unknown;
}

interface InventoryRow {
  variant_id: string;
  available: number;
}

/**
 * Inner run function — exported separately so unit tests can drive the
 * gate cascade without depending on the Trigger.dev `task()` wrapper's
 * private internals. The exported `shipstationSeedInventoryTask` simply
 * delegates here.
 */
export async function runShipstationSeedInventory(
  payload: ShipstationSeedPayload,
  ctx: { run: { id: string } },
): Promise<ShipstationSeedResult> {
  const { workspaceId, inventoryWarehouseId, inventoryLocationId, dryRun = false } = payload;
  const supabase = createServiceRoleClient();

  const result: ShipstationSeedResult = {
    workspace_id: workspaceId,
    dry_run: dryRun,
    candidates: 0,
    bundle_excluded: 0,
    blocked_by_push_mode: 0,
    blocked_zero_origin_sum: 0,
    blocked_zero_warehouse_stock: 0,
    seeded: 0,
    ledger_skipped: 0,
    errors: 0,
  };

  const startedAt = new Date().toISOString();
  if (!dryRun) {
    await supabase.from("channel_sync_log").insert({
      workspace_id: workspaceId,
      channel: "shipstation_v2",
      sync_type: "seed_inventory",
      status: "started",
      started_at: startedAt,
      metadata: {
        run_id: ctx.run.id,
        inventory_warehouse_id: inventoryWarehouseId,
        inventory_location_id: inventoryLocationId,
      },
    });
  }

  try {
    // ─── 1. Candidate variants (workspace + org-scoped fulfillment items) ──
    const { data: variantsRaw, error: variantsErr } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, warehouse_products!inner(org_id)")
      .eq("workspace_id", workspaceId);

    if (variantsErr) {
      throw new Error(`failed to load variants: ${variantsErr.message}`);
    }

    const variants = (variantsRaw ?? []) as unknown as VariantRow[];
    const fulfillmentVariants = variants.filter((v) => v.warehouse_products?.org_id != null);
    result.candidates = fulfillmentVariants.length;

    if (fulfillmentVariants.length === 0) {
      await markRunSuccess(supabase, workspaceId, ctx.run.id, result, startedAt, dryRun);
      return result;
    }

    const variantIds = fulfillmentVariants.map((v) => v.id);
    const variantById = new Map(fulfillmentVariants.map((v) => [v.id, v]));

    // ─── 2. Bundle exclusion (Phase 2.5 (a)) ────────────────────────────────
    const { data: bundleRows, error: bundleErr } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .in("bundle_variant_id", variantIds);

    if (bundleErr) {
      throw new Error(`failed to load bundle_components: ${bundleErr.message}`);
    }

    const bundleVariantIds = new Set((bundleRows ?? []).map((r) => r.bundle_variant_id as string));

    // ─── 3. Bandcamp mappings + push_mode + origin sum ─────────────────────
    const { data: mappingRows, error: mappingErr } = await supabase
      .from("bandcamp_product_mappings")
      .select("variant_id, push_mode, bandcamp_origin_quantities")
      .in("variant_id", variantIds);

    if (mappingErr) {
      throw new Error(`failed to load bandcamp mappings: ${mappingErr.message}`);
    }

    const mappingByVariant = new Map<string, MappingRow>(
      (mappingRows ?? []).map((m) => [m.variant_id as string, m as MappingRow]),
    );

    // ─── 4. Warehouse inventory levels ─────────────────────────────────────
    const { data: inventoryRows, error: inventoryErr } = await supabase
      .from("warehouse_inventory_levels")
      .select("variant_id, available")
      .in("variant_id", variantIds);

    if (inventoryErr) {
      throw new Error(`failed to load inventory levels: ${inventoryErr.message}`);
    }

    const inventoryByVariant = new Map<string, number>(
      (inventoryRows ?? []).map((r) => [
        (r as InventoryRow).variant_id,
        Number((r as InventoryRow).available) || 0,
      ]),
    );

    // ─── 5. Iterate + apply gates + push to v2 ─────────────────────────────
    for (const variantId of variantIds) {
      const variant = variantById.get(variantId);
      if (!variant) continue;

      if (bundleVariantIds.has(variantId)) {
        result.bundle_excluded++;
        continue;
      }

      const mapping = mappingByVariant.get(variantId);
      if (!mapping || mapping.push_mode !== "normal") {
        result.blocked_by_push_mode++;
        continue;
      }

      const originSum = computeEffectiveBandcampAvailable(mapping.bandcamp_origin_quantities);
      if (originSum <= 0) {
        result.blocked_zero_origin_sum++;
        continue;
      }

      const warehouseAvailable = inventoryByVariant.get(variantId) ?? 0;
      if (warehouseAvailable <= 0) {
        result.blocked_zero_warehouse_stock++;
        continue;
      }

      if (dryRun) {
        result.seeded++;
        continue;
      }

      const correlationId = `seed:${workspaceId}:${ctx.run.id}`;
      const claim = await beginExternalSync(supabase, {
        system: "shipstation_v2",
        correlation_id: correlationId,
        sku: variant.sku,
        action: "increment",
        request_body: {
          quantity: warehouseAvailable,
          inventory_warehouse_id: inventoryWarehouseId,
          inventory_location_id: inventoryLocationId,
          reason: "phase3_seed",
        },
      });

      if (!claim.acquired) {
        result.ledger_skipped++;
        continue;
      }

      try {
        const response = await adjustInventoryV2({
          sku: variant.sku,
          inventory_warehouse_id: inventoryWarehouseId,
          inventory_location_id: inventoryLocationId,
          transaction_type: "increment",
          quantity: warehouseAvailable,
          reason: "phase3_seed",
          notes: `Phase 3 initial seed (run ${ctx.run.id})`,
        });
        await markExternalSyncSuccess(supabase, claim.id, response);
        result.seeded++;
      } catch (err) {
        await markExternalSyncError(supabase, claim.id, err);
        result.errors++;
        logger.error("[shipstation-seed-inventory] adjustInventoryV2 failed", {
          sku: variant.sku,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error("[shipstation-seed-inventory] task failed", {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!dryRun) {
      await supabase
        .from("channel_sync_log")
        .update({
          status: "failed",
          error_message: err instanceof Error ? err.message : String(err),
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("channel", "shipstation_v2")
        .eq("started_at", startedAt);
    }
    throw err;
  }

  await markRunSuccess(supabase, workspaceId, ctx.run.id, result, startedAt, dryRun);
  return result;
}

export const shipstationSeedInventoryTask = task({
  id: "shipstation-seed-inventory",
  queue: shipstationQueue,
  maxDuration: 1800,
  run: async (payload: ShipstationSeedPayload, { ctx }): Promise<ShipstationSeedResult> =>
    runShipstationSeedInventory(payload, ctx),
});

async function markRunSuccess(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  runId: string,
  result: ShipstationSeedResult,
  startedAt: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  await supabase
    .from("channel_sync_log")
    .update({
      status: result.errors > 0 ? "partial" : "completed",
      items_processed: result.seeded,
      items_failed: result.errors,
      completed_at: new Date().toISOString(),
      metadata: { run_id: runId, ...result },
    })
    .eq("workspace_id", workspaceId)
    .eq("channel", "shipstation_v2")
    .eq("started_at", startedAt);
}
