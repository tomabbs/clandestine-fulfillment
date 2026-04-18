/**
 * Saturday Workstream 2 (2026-04-18) — manual-count → ShipStation v2 sync bridge.
 *
 * Triggered by the `submitManualInventoryCounts` Server Action after every
 * successful `recordInventoryChange()` write. Mirrors the absolute-set delta
 * onto ShipStation v2 inventory via the `external_sync_events` ledger so
 * retries are idempotent.
 *
 * Why a separate task (sibling of `shipstation-v2-decrement`):
 *   - `shipstation-v2-decrement` handles SALE-driven writes only (negative-only,
 *     correlation `sale:{band_id}:{package_id}:{sku}`). Extending it to take
 *     positive deltas would entangle two unrelated event sources.
 *   - Manual count writes can go EITHER direction (current=50, new=47 → -3;
 *     current=30, new=47 → +17). v2 contract (Phase 0 Patch D2):
 *       - delta > 0 → `transaction_type: 'increment'` quantity: |delta|
 *       - delta < 0 → `transaction_type: 'decrement'` quantity: |delta|
 *       - delta == 0 should NEVER reach this task (Server Action filters; if it
 *         does we no-op early to keep the contract pure).
 *   - Pinned to `shipstationQueue` (concurrencyLimit: 1) so manual entry by
 *     staff cannot exceed the v2 60 req/min budget shared with sale fanout,
 *     seed, reconcile, and bundle drift sensor.
 *
 * Skip rules (in order — exact same cascade as `shipstation-v2-decrement`):
 *   1. fanout-guard (`shipstation` integration kill switch + per-workspace
 *      rollout bucket).
 *   2. Workspace v2 defaults missing
 *      (`shipstation_v2_inventory_warehouse_id` / `_location_id` IS NULL).
 *   3. Variant unknown (defensive — Server Action already verified).
 *   4. Bundle parent (Phase 2.5(a) seed exclusion — bundles are derived).
 *   5. Ledger short-circuit on duplicate retry.
 *
 * Rule #7  — service-role client.
 * Rule #12 — payload IDs only.
 * Rule #43 — fanout step (4) for manual-count-originated inventory writes.
 * Rule #48 — never call this task's logic directly from a Server Action.
 */

import { logger, task } from "@trigger.dev/sdk";
import { adjustInventoryV2 } from "@/lib/clients/shipstation-inventory-v2";
import {
  beginExternalSync,
  type ExternalSyncAction,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface ShipstationV2AdjustOnSkuPayload {
  workspaceId: string;
  sku: string;
  /** Signed delta. Positive ⇒ increment; negative ⇒ decrement; 0 ⇒ no-op. */
  delta: number;
  /** Stable per-logical-operation. e.g. `manual-count:{userId}:{batchId}:{sku}`. */
  correlationId: string;
  /** Free-text reason recorded on the v2 transaction. e.g. `manual_inventory_count`. */
  reason: string;
  /** Optional metadata captured on the ledger row for debugging. */
  metadata?: Record<string, unknown>;
}

export type ShipstationV2AdjustOnSkuResult =
  | {
      status: "ok";
      correlationId: string;
      sku: string;
      action: "increment" | "decrement";
      quantity: number;
      ledger_id: string;
    }
  | {
      status:
        | "skipped_zero_delta"
        | "skipped_guard"
        | "skipped_inventory_sync_paused"
        | "skipped_no_v2_defaults"
        | "skipped_bundle_parent"
        | "skipped_unknown_variant"
        | "skipped_ledger_duplicate";
      correlationId: string;
      sku: string;
      reason: string;
    };

export const shipstationV2AdjustOnSkuTask = task({
  id: "shipstation-v2-adjust-on-sku",
  queue: shipstationQueue,
  maxDuration: 60,
  run: async (
    payload: ShipstationV2AdjustOnSkuPayload,
  ): Promise<ShipstationV2AdjustOnSkuResult> => {
    const { workspaceId, sku, delta, correlationId, reason, metadata } = payload;

    if (!Number.isFinite(delta)) {
      throw new Error(`[shipstation-v2-adjust-on-sku] non-finite delta ${delta} for sku=${sku}`);
    }

    if (delta === 0) {
      logger.info("[shipstation-v2-adjust-on-sku] zero delta — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_zero_delta",
        correlationId,
        sku,
        reason: "delta_is_zero",
      };
    }

    const supabase = createServiceRoleClient();

    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("shipstation", correlationId);
    if (!decision.allow) {
      logger.info("[shipstation-v2-adjust-on-sku] guard skip", {
        workspaceId,
        sku,
        correlationId,
        reason: decision.reason,
      });
      return {
        status: "skipped_guard",
        correlationId,
        sku,
        reason: decision.reason,
      };
    }

    const { data: ws } = await supabase
      .from("workspaces")
      .select(
        "shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id, inventory_sync_paused",
      )
      .eq("id", workspaceId)
      .single();

    // Audit fix F3 (2026-04-13): honor the global inventory_sync_paused
    // kill switch the same way bandcamp-inventory-push and
    // multi-store-inventory-push do. Operator pauses → nothing leaves
    // Clandestine, period. Pre-fix this task ignored the global flag and
    // only respected the fanout-guard `shipstation` integration switch.
    if (ws?.inventory_sync_paused) {
      logger.info("[shipstation-v2-adjust-on-sku] inventory_sync_paused — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_inventory_sync_paused",
        correlationId,
        sku,
        reason: "inventory_sync_paused",
      };
    }

    const inventoryWarehouseId = ws?.shipstation_v2_inventory_warehouse_id ?? null;
    const inventoryLocationId = ws?.shipstation_v2_inventory_location_id ?? null;
    if (!inventoryWarehouseId || !inventoryLocationId) {
      logger.warn("[shipstation-v2-adjust-on-sku] no v2 defaults configured — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_no_v2_defaults",
        correlationId,
        sku,
        reason: "workspace_v2_defaults_missing",
      };
    }

    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .maybeSingle();

    if (!variant) {
      logger.warn("[shipstation-v2-adjust-on-sku] unknown variant — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_unknown_variant",
        correlationId,
        sku,
        reason: "variant_not_found",
      };
    }

    const { data: bundleHit } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("bundle_variant_id", variant.id)
      .limit(1)
      .maybeSingle();

    if (bundleHit) {
      logger.info("[shipstation-v2-adjust-on-sku] variant is bundle parent — skipping", {
        workspaceId,
        sku,
        correlationId,
      });
      return {
        status: "skipped_bundle_parent",
        correlationId,
        sku,
        reason: "bundle_excluded_from_v2",
      };
    }

    const action: ExternalSyncAction = delta > 0 ? "increment" : "decrement";
    const quantity = Math.abs(delta);

    const claim = await beginExternalSync(supabase, {
      system: "shipstation_v2",
      correlation_id: correlationId,
      sku,
      action,
      request_body: {
        delta,
        quantity,
        reason,
        inventory_warehouse_id: inventoryWarehouseId,
        inventory_location_id: inventoryLocationId,
        metadata: metadata ?? null,
      },
    });

    if (!claim.acquired) {
      logger.info("[shipstation-v2-adjust-on-sku] ledger short-circuit", {
        workspaceId,
        sku,
        correlationId,
        reason: claim.reason,
        existing_status: claim.existing_status,
      });
      return {
        status: "skipped_ledger_duplicate",
        correlationId,
        sku,
        reason: claim.reason,
      };
    }

    try {
      const response = await adjustInventoryV2({
        sku,
        inventory_warehouse_id: inventoryWarehouseId,
        inventory_location_id: inventoryLocationId,
        transaction_type: action,
        quantity,
        reason,
        notes: metadata ? JSON.stringify(metadata).slice(0, 500) : undefined,
      });
      await markExternalSyncSuccess(supabase, claim.id, response);
      return {
        status: "ok",
        correlationId,
        sku,
        action,
        quantity,
        ledger_id: claim.id,
      };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      logger.error("[shipstation-v2-adjust-on-sku] adjustInventoryV2 failed", {
        workspaceId,
        sku,
        correlationId,
        action,
        quantity,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
