/**
 * Phase 1 §9.2 D2 — per-SKU Clandestine Shopify push.
 *
 * Replaces the inline `inventoryAdjustQuantities` block at
 * [`src/lib/server/inventory-fanout.ts:182-214`](src/lib/server/inventory-fanout.ts).
 * Same skip cascade rationale as the client-store sibling task, scoped
 * to the env-singleton Clandestine Shopify store (the brand's own
 * storefront — NOT a `client_store_connections` row).
 *
 * Pass 1 vs Pass 2 layering:
 *   Pass 1 keeps the existing **delta-based** `inventoryAdjustQuantities`
 *   semantics. The fanout caller passes the raw `delta` from the
 *   originating `recordInventoryChange()` event; this task simply
 *   forwards it after the guard cascade. We do NOT compute
 *   `effective_sellable` here in Pass 1 because the Clandestine path
 *   has no `last_pushed_quantity` baseline (no per-SKU mapping row to
 *   record one against), so an absolute "set to N" semantic would
 *   require either:
 *     (a) a new `warehouse_product_variants.clandestine_last_pushed_*`
 *         column pair (not yet migrated), or
 *     (b) a Shopify GET round-trip per push to learn the current
 *         remote value (latency tax + race window).
 *   Pass 2 introduces both via the `shopify-cas.ts` helper
 *   (`inventorySetQuantities` + `changeFromQuantity` + `@idempotent`)
 *   and adopts `effective_sellable` semantics through that contract.
 *
 * Skip cascade:
 *   1. fanout-guard `clandestine_shopify` integration kill switch +
 *      per-workspace rollout bucket.
 *   2. variant lookup fails OR variant has no
 *      `shopify_inventory_item_id` (not synced to Shopify yet — e.g.
 *      brand-new draft product).
 *   3. delta is zero — no push to make.
 *   4. external_sync_events ledger acquired
 *      (`UNIQUE(system='clandestine_shopify', correlation_id, sku,
 *      action='adjust')`).
 *
 * Rules: #7 (service-role), #12 (IDs only), #15 (stable correlation_id).
 *
 * Why a single env-pinned location?
 *   The Clandestine Shopify store has exactly one staff-managed
 *   warehouse location. The constant `CLANDESTINE_SHOPIFY_LOCATION_ID`
 *   matches the value already inlined in `inventory-fanout.ts`. When
 *   we add a second location (e.g. EU warehouse), this constant moves
 *   to env validation + the task takes a `locationId?` payload field
 *   that defaults to the env value.
 */

import { logger, task } from "@trigger.dev/sdk";
import { inventoryAdjustQuantities } from "@/lib/clients/shopify-client";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { clandestineShopifyPushQueue } from "@/trigger/lib/client-store-push-queues";

/**
 * Mirror of the value previously inlined as `SHOPIFY_LOCATION_ID` in
 * `inventory-fanout.ts`. Single-location store today; promote to env
 * + payload override when EU warehouse lands.
 */
export const CLANDESTINE_SHOPIFY_LOCATION_ID = "gid://shopify/Location/104066613563";

export interface ClandestineShopifyPushOnSkuPayload {
  workspaceId: string;
  sku: string;
  /** Raw delta from the originating recordInventoryChange event. Pass 1 forwards verbatim. */
  delta: number;
  correlationId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export type ClandestineShopifyPushOnSkuResult =
  | {
      status: "ok";
      sku: string;
      delta: number;
      ledgerId: string;
    }
  | {
      status:
        | "skipped_guard"
        | "skipped_unknown_variant"
        | "skipped_no_shopify_item"
        | "skipped_zero_delta"
        | "skipped_ledger_duplicate";
      sku: string;
      reason: string;
    };

export const clandestineShopifyPushOnSkuTask = task({
  id: "clandestine-shopify-push-on-sku",
  queue: clandestineShopifyPushQueue,
  maxDuration: 60,
  run: async (
    payload: ClandestineShopifyPushOnSkuPayload,
  ): Promise<ClandestineShopifyPushOnSkuResult> => {
    const { workspaceId, sku, delta, correlationId, reason, metadata } = payload;
    const supabase = createServiceRoleClient();

    // 1) fanout-guard
    const guard = await loadFanoutGuard(supabase, workspaceId);
    const decision = guard.evaluate("clandestine_shopify", correlationId);
    if (!decision.allow) {
      logger.info("[clandestine-shopify-push-on-sku] guard skip", {
        workspaceId,
        sku,
        correlationId,
        reason: decision.reason,
      });
      return { status: "skipped_guard", sku, reason: decision.reason };
    }

    // 2) variant lookup — must have shopify_inventory_item_id
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id, shopify_inventory_item_id")
      .eq("workspace_id", workspaceId)
      .eq("sku", sku)
      .maybeSingle();

    if (!variant) {
      logger.warn("[clandestine-shopify-push-on-sku] variant not found", {
        workspaceId,
        sku,
      });
      return { status: "skipped_unknown_variant", sku, reason: "variant_not_found" };
    }

    if (!variant.shopify_inventory_item_id) {
      logger.info("[clandestine-shopify-push-on-sku] variant not synced to Shopify yet", {
        sku,
      });
      return {
        status: "skipped_no_shopify_item",
        sku,
        reason: "shopify_inventory_item_id_missing",
      };
    }

    // 3) zero-delta short-circuit
    if (delta === 0) {
      return { status: "skipped_zero_delta", sku, reason: "zero_delta" };
    }

    // 4) ledger acquire — idempotency
    const claim = await beginExternalSync(supabase, {
      system: "clandestine_shopify",
      correlation_id: correlationId,
      sku,
      action: "adjust",
      request_body: {
        delta,
        location_id: CLANDESTINE_SHOPIFY_LOCATION_ID,
        inventory_item_id: variant.shopify_inventory_item_id,
        reason,
        metadata: metadata ?? null,
      },
    });

    if (!claim.acquired) {
      logger.info("[clandestine-shopify-push-on-sku] ledger short-circuit", {
        sku,
        correlationId,
        reason: claim.reason,
        existing_status: claim.existing_status,
      });
      return { status: "skipped_ledger_duplicate", sku, reason: claim.reason };
    }

    // 5) push delta to Clandestine Shopify
    try {
      await inventoryAdjustQuantities(
        variant.shopify_inventory_item_id as string,
        CLANDESTINE_SHOPIFY_LOCATION_ID,
        delta,
        correlationId,
      );
      await markExternalSyncSuccess(supabase, claim.id, { delta, ok: true });
      return { status: "ok", sku, delta, ledgerId: claim.id };
    } catch (err) {
      await markExternalSyncError(supabase, claim.id, err);
      logger.error("[clandestine-shopify-push-on-sku] push failed", {
        sku,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
