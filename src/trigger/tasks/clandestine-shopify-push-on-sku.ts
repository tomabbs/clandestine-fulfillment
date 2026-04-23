/**
 * Phase 1 §9.2 D2 + Pass 2 D5 — per-SKU Clandestine Shopify push.
 *
 * Pass 2 swaps the delta-based `inventoryAdjustQuantities` path for an
 * absolute-with-CAS write through `setShopifyInventoryCas` (env-singleton
 * transport). The CAS contract is the structural fix for the race where
 * a Shopify-side webhook lands between our read and our write — the old
 * delta path would silently overstate inventory by 1 per concurrent
 * sale; the new path retries with a fresh remote read up to 3× before
 * filing a `cas_exhausted` review queue item.
 *
 * Pass 1 → Pass 2 layering:
 *   - Pass 1 forwarded the raw `delta` from the originating
 *     `recordInventoryChange()` event verbatim and called
 *     `inventoryAdjustQuantities`.
 *   - Pass 2 IGNORES `delta` in the WRITE — it remains in the payload
 *     for diagnostic logging only — and instead computes
 *     `effective_sellable` (Postgres truth) per attempt and absolute-
 *     sets Shopify to that value via CAS. Each attempt re-reads
 *     `effective_sellable` so a sale that lands between attempts moves
 *     the desired value with the truth instead of falling out of sync.
 *
 * Skip cascade (in order, all short-circuit):
 *   1. fanout-guard `clandestine_shopify` integration kill switch +
 *      per-workspace rollout bucket.
 *   2. variant lookup fails OR variant has no
 *      `shopify_inventory_item_id` (not synced to Shopify yet — e.g.
 *      brand-new draft product).
 *   3. `external_sync_events` ledger acquired
 *      (`UNIQUE(system='clandestine_shopify', correlation_id, sku,
 *      action='cas_set')`). Duplicate retries collide and short-circuit.
 *
 * NOTE: Pass 2 deliberately drops the `skipped_zero_delta` short-circuit
 * from the Pass 1 task. CAS is absolute, not delta-based, so a "delta=0"
 * upstream event doesn't imply "no push needed" — Shopify might be out
 * of sync from a prior failed write, and the absolute push will reconcile
 * it. The `skipped_unchanged_quantity` short-circuit (effective_sellable
 * already equals remote available) lives inside CAS via the @idempotent
 * directive — a write of `desired == current` is a no-op on Shopify's
 * side, no extra short-circuit needed here.
 *
 * Rules: #7 (service-role), #12 (IDs only), #15 (stable correlation_id),
 *        #43 (single-write fanout step 4), #58 (single owner file),
 *        Phase 1 §9.2 D5 (CAS retry loop owns its own audit + review).
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
import { computeEffectiveSellable } from "@/lib/server/effective-sellable";
import { beginExternalSync, markExternalSyncError } from "@/lib/server/external-sync-events";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { setShopifyInventoryCas } from "@/lib/server/shopify-cas-retry";
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
  /**
   * Raw delta from the originating recordInventoryChange event. PASS 2
   * KEEPS THIS IN THE PAYLOAD FOR DIAGNOSTIC LOGGING ONLY — the CAS
   * write is absolute (effective_sellable), not delta-based. Removing
   * the field would force every caller to be edited in lockstep; keeping
   * it costs nothing and lets the request_body row carry the upstream
   * intent for triage.
   */
  delta: number;
  correlationId: string;
  reason: string;
  metadata?: Record<string, unknown>;
  /** Optional org_id for review queue rows. */
  orgId?: string | null;
}

export type ClandestineShopifyPushOnSkuResult =
  | {
      status: "ok";
      sku: string;
      pushedQuantity: number;
      ledgerId: string;
      attempts: number;
    }
  | {
      status: "cas_exhausted";
      sku: string;
      ledgerId: string;
      attempts: number;
      lastActualQuantity: number | null;
    }
  | {
      status:
        | "skipped_guard"
        | "skipped_unknown_variant"
        | "skipped_no_shopify_item"
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
    const { workspaceId, sku, delta, correlationId, reason, metadata, orgId } = payload;
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

    // 3) ledger acquire — idempotency (action='cas_set' to segment Pass 2
    //    CAS writes from the legacy 'adjust' verb on analytics).
    const claim = await beginExternalSync(supabase, {
      system: "clandestine_shopify",
      correlation_id: correlationId,
      sku,
      action: "cas_set",
      request_body: {
        delta_diagnostic: delta,
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

    // 4) CAS hot-path retry loop. The helper:
    //    - reads Shopify's actual `available` for compareQuantity
    //    - calls computeDesired() with that value (we ignore it and
    //      use Postgres truth — see callback comment)
    //    - issues `inventorySetQuantities` with @idempotent
    //    - retries up to 3× on compare_mismatch with 50/150/400ms backoff
    //    - on success: marks ledger success
    //    - on exhaustion: marks ledger error + upserts cas_exhausted
    //      review queue row (severity:medium, dedup'd by group_key)
    //    - on non-CAS error: marks ledger error + re-throws
    try {
      const result = await setShopifyInventoryCas({
        supabase,
        transport: { kind: "env_singleton" },
        inventoryItemId: variant.shopify_inventory_item_id as string,
        locationId: CLANDESTINE_SHOPIFY_LOCATION_ID,
        workspaceId,
        orgId: orgId ?? null,
        sku,
        correlationId,
        system: "clandestine_shopify",
        ledgerId: claim.id,
        // The `remoteAvailable` parameter is the Shopify-side number;
        // we DO NOT use it to compute desired. Postgres is truth — we
        // recompute effective_sellable each attempt so a sale that
        // landed between attempts moves the desired value with the
        // truth. The remote value is consumed by the helper as
        // `expectedQuantity` for CAS, which is what protects us from
        // the race in the first place.
        computeDesired: async () => {
          const sellable = await computeEffectiveSellable(supabase, {
            workspaceId,
            sku,
            channel: "clandestine_shopify",
          });
          return sellable.effectiveSellable;
        },
        reason: "correction",
      });

      if (result.ok) {
        return {
          status: "ok",
          sku,
          pushedQuantity: result.finalNewQuantity,
          ledgerId: claim.id,
          attempts: result.attempts.length,
        };
      }
      // CAS exhausted — helper already marked ledger error + filed
      // review queue. Don't throw: the task succeeded operationally
      // (the reconcile sweep will pick up the residual drift).
      return {
        status: "cas_exhausted",
        sku,
        ledgerId: claim.id,
        attempts: result.attempts.length,
        lastActualQuantity: result.lastActualQuantity,
      };
    } catch (err) {
      // Defensive: helper already marks ledger error on transport/
      // throw paths. This catch is for the (rare) case the helper
      // itself fails BEFORE acquiring the ledger update — e.g. a
      // computeDesired throw. Mark ledger error idempotently and
      // re-throw so Trigger.dev framework retries.
      try {
        await markExternalSyncError(supabase, claim.id, err);
      } catch {
        // ignore double-mark errors
      }
      logger.error("[clandestine-shopify-push-on-sku] CAS pipeline failed", {
        sku,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
