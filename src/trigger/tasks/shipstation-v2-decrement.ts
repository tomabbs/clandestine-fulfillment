/**
 * Phase 4 — sale-poll → ShipStation v2 decrement bridge.
 *
 * Triggered by `bandcamp-sale-poll` after a successful
 * `recordInventoryChange()` for a Bandcamp sale. Mirrors the decrement
 * onto ShipStation v2 inventory via the `external_sync_events` ledger
 * (plan §1.4.2) so retries are idempotent.
 *
 * Why a separate task (not inline in sale-poll):
 *   - sale-poll runs on `bandcampQueue` (concurrencyLimit: 1, serialized
 *     for Bandcamp OAuth). Calling v2 inventory inline would burn the v2
 *     60 req/min budget without serialization. Pinning this task to
 *     `shipstationQueue` (also concurrencyLimit: 1) keeps v2 calls
 *     serialized across the whole app — sale bursts can never exceed v2
 *     rate limits.
 *
 * Skip rules (in order):
 *   1. `fanout-guard` (`shipstation` integration kill switch + per-workspace
 *      rollout bucket). Logs the structured skip reason.
 *   2. Workspace has no v2 defaults configured
 *      (`shipstation_v2_inventory_warehouse_id` /
 *      `shipstation_v2_inventory_location_id` IS NULL). Phase 3 admin sets
 *      these.
 *   3. Variant is a bundle parent — bundles are intentionally absent from
 *      v2 (Phase 2.5 (a) seed exclusion). The bundle-derived-drift sensor
 *      handles bundle SKUs that DID get a v2 row via the legacy path.
 *   4. Ledger short-circuit (`already_in_flight` / `already_succeeded` /
 *      `already_errored`) — duplicate retry, bail without re-calling v2.
 *
 * Decrement contract (Phase 0 Patch D2 outcome — plan §7.1.6.0):
 *   `transaction_type: "decrement"` with `quantity: |delta|` for every
 *   case, including the 1 → 0 boundary. NEVER `modify new_available: 0`.
 *
 * Rule #7  — service-role client.
 * Rule #12 — payload IDs only.
 * Rule #43 — fanout step (4) for Bandcamp-originated inventory writes.
 */

import { logger, task } from "@trigger.dev/sdk";
import { adjustInventoryV2 } from "@/lib/clients/shipstation-inventory-v2";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface ShipstationV2DecrementPayload {
  workspaceId: string;
  sku: string;
  /** Magnitude of the decrement. Always positive (the source delta is negative). */
  quantity: number;
  /** Stable per-logical-operation. e.g. `sale:{band_id}:{package_id}:{newSold}:{sku}`. */
  correlationId: string;
  /** Free-text reason recorded on the v2 transaction. e.g. `bandcamp_sale`. */
  reason: string;
  /** Optional metadata captured on the ledger row for debugging. */
  metadata?: Record<string, unknown>;
}

export type ShipstationV2DecrementResult =
  | {
      status: "ok";
      correlationId: string;
      sku: string;
      quantity: number;
      ledger_id: string;
    }
  | {
      status:
        | "skipped_guard"
        | "skipped_no_v2_defaults"
        | "skipped_bundle_parent"
        | "skipped_unknown_variant"
        | "skipped_ledger_duplicate";
      correlationId: string;
      sku: string;
      reason: string;
    };

export const shipstationV2DecrementTask = task({
  id: "shipstation-v2-decrement",
  queue: shipstationQueue,
  maxDuration: 60,
  run: async (payload: ShipstationV2DecrementPayload): Promise<ShipstationV2DecrementResult> => {
    const { workspaceId, sku, quantity, correlationId, reason, metadata } = payload;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(
        `[shipstation-v2-decrement] invalid quantity ${quantity} for sku=${sku}; expected positive integer`,
      );
    }

    const supabase = createServiceRoleClient();

    // 1) fanout-guard
    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("shipstation", correlationId);
    if (!decision.allow) {
      logger.info("[shipstation-v2-decrement] guard skip", {
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

    // 2) workspace v2 defaults must be configured
    const { data: ws } = await supabase
      .from("workspaces")
      .select("shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id")
      .eq("id", workspaceId)
      .single();

    const inventoryWarehouseId = ws?.shipstation_v2_inventory_warehouse_id ?? null;
    const inventoryLocationId = ws?.shipstation_v2_inventory_location_id ?? null;
    if (!inventoryWarehouseId || !inventoryLocationId) {
      logger.warn("[shipstation-v2-decrement] no v2 defaults configured — skipping", {
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

    // 3) bundle parent exclusion (Phase 2.5 (a))
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .maybeSingle();

    if (!variant) {
      logger.warn("[shipstation-v2-decrement] unknown variant — skipping", {
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
      logger.info("[shipstation-v2-decrement] variant is bundle parent — skipping", {
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

    // 4) ledger acquire — idempotency
    const claim = await beginExternalSync(supabase, {
      system: "shipstation_v2",
      correlation_id: correlationId,
      sku,
      action: "decrement",
      request_body: {
        quantity,
        reason,
        inventory_warehouse_id: inventoryWarehouseId,
        inventory_location_id: inventoryLocationId,
        metadata: metadata ?? null,
      },
    });

    if (!claim.acquired) {
      logger.info("[shipstation-v2-decrement] ledger short-circuit", {
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

    // 5) v2 decrement (NEVER modify; Phase 0 Patch D2 contract)
    try {
      const response = await adjustInventoryV2({
        sku,
        inventory_warehouse_id: inventoryWarehouseId,
        inventory_location_id: inventoryLocationId,
        transaction_type: "decrement",
        quantity,
        reason,
        notes: metadata ? JSON.stringify(metadata).slice(0, 500) : undefined,
      });
      await markExternalSyncSuccess(supabase, claim.id, response);
      return {
        status: "ok",
        correlationId,
        sku,
        quantity,
        ledger_id: claim.id,
      };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      logger.error("[shipstation-v2-decrement] adjustInventoryV2 failed", {
        workspaceId,
        sku,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
