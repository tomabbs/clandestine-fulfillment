/**
 * Inventory fanout — Rule #43 step (4).
 *
 * Called after recordInventoryChange succeeds.
 * Pushes inventory changes to all downstream systems:
 * - Clandestine Shopify (direct API, not client_store_connections)
 * - Bandcamp (via bandcamp-inventory-push task)
 * - Client stores (via multi-store-inventory-push task)
 * - ShipStation v2 (via shipstation-v2-adjust-on-sku task) — added by audit
 *   fix F1 (2026-04-13). SKU-total path; per-location rewrite still gated on
 *   the §15.3 probe (`ws3-3f-per-location-rewrite`).
 *
 * When workspaces.inventory_sync_paused is true, all outbound pushes are
 * skipped immediately at the top of this function (audit fix F2, 2026-04-13).
 * recordInventoryChange() still completes — Redis + Postgres stay current.
 * The updated quantities are pushed when sync resumes.
 *
 * Echo-cancellation (audit fix F1, Rule #65): when the originating event
 * already represents ShipStation v2 state — either because v2 itself wrote
 * it (`source === 'shipstation'` SHIP_NOTIFY, `source === 'reconcile'` drift
 * sensor) OR because **ShipStation Inventory Sync** has already mirrored a
 * storefront sale into v2 natively (`source IN ('shopify','squarespace',
 * 'woocommerce','bandcamp')`) — we MUST NOT push back to ShipStation v2.
 * Doing so would double-decrement v2, since SS would then push the doubled
 * value back to the storefront, which would re-emit a webhook, etc. (the
 * classic Rule #65 echo loop).
 *
 * Storefront echo-skip context (2026-04-13 audit, second pass):
 * - The operator activated **ShipStation Inventory Sync** for every connected
 *   Shopify / Squarespace / WooCommerce account AND ShipStation has native
 *   Bandcamp store integrations registered in `warehouse_shipstation_stores`.
 * - SS Inventory Sync subscribes directly to each storefront's order/inventory
 *   webhooks and decrements v2 the moment SS imports the order — completely
 *   independent of our app's webhook processing.
 * - Therefore EVERY sale-driven `recordInventoryChange()` we make in response
 *   to a storefront webhook (`shopify`, `squarespace`, `woocommerce`,
 *   `bandcamp`) is an event v2 has already absorbed. Pushing back is the bug.
 * - The skip applies ONLY to the v2 leg — Clandestine Shopify, Bandcamp focus
 *   pushes, and client-store fanout still fire (their state is independent of
 *   the originating storefront).
 *
 * Sources that DO fanout to v2 (warehouse-side writes v2 has not yet seen):
 *   `manual`, `manual_inventory_count`, `cycle_count`, `inbound`, `preorder`,
 *   `backfill`. These represent staff actions / inbound check-ins / count
 *   sessions originating in our app — v2 must be told.
 *
 * Safety nets when echo-skip is "wrong" (e.g. an operator disables SS
 * Inventory Sync for one store): Phase 5 reconcile sensor (`shipstation-
 * bandcamp-reconcile-{hot,warm,cold}`) detects v2 ↔ DB drift and auto-fixes
 * via `recordInventoryChange({ source:'reconcile' })` — which itself echo-
 * skips, breaking the cycle.
 */

import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import { inventoryAdjustQuantities } from "@/lib/clients/shopify-client";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { InventorySource } from "@/lib/shared/types";
import type { ShipstationV2AdjustOnSkuPayload } from "@/trigger/tasks/shipstation-v2-adjust-on-sku";

const SHOPIFY_LOCATION_ID = "gid://shopify/Location/104066613563";

/**
 * Sources whose originating event already reflects ShipStation v2 state.
 * Pushing back would create an echo loop. See Rule #65 + audit F1 rationale
 * in the file-level docstring above.
 *
 * Membership criteria: a `source` belongs here iff every event tagged with
 * that source has ALREADY been absorbed by ShipStation v2 by the time it
 * reaches `fanoutInventoryChange()`. Two distinct categories qualify:
 *
 *   1. Direct v2 writes — `shipstation` (SHIP_NOTIFY processor decremented
 *      v2 inline) and `reconcile` (Phase 5 sensor pulled DB into v2's value;
 *      pushing back oscillates).
 *   2. ShipStation-Inventory-Sync-mirrored events — `shopify`, `squarespace`,
 *      `woocommerce`, `bandcamp` (SS subscribes to each storefront's order
 *      webhooks and decrements v2 natively at import time, independent of
 *      our app's webhook processing).
 *
 * Adding a new sales channel? It belongs here ONLY if SS Inventory Sync
 * supports it AND the operator has activated it. Otherwise add to the
 * "DOES fanout" comment block in the file-level docstring instead.
 */
const SHIPSTATION_V2_ECHO_SOURCES: ReadonlySet<InventorySource> = new Set<InventorySource>([
  "shipstation",
  "reconcile",
  "shopify",
  "squarespace",
  "woocommerce",
  "bandcamp",
]);

export function shouldEchoSkipShipstationV2(source: InventorySource | undefined): boolean {
  if (!source) return false;
  return SHIPSTATION_V2_ECHO_SOURCES.has(source);
}

export interface FanoutResult {
  storeConnectionsPushed: number;
  bandcampPushed: boolean;
  shopifyPushed: boolean;
  /**
   * Whether the ShipStation v2 SKU-total push was enqueued (best-effort —
   * the task itself may still skip via its own guard cascade). False when
   * skipped at fanout level due to pause / echo / no-variant / no-delta /
   * fanout-guard / kill switch.
   */
  shipstationV2Enqueued: boolean;
}

export function determineFanoutTargets(
  hasStoreConnections: boolean,
  hasBandcampMapping: boolean,
): { pushToStores: boolean; pushToBandcamp: boolean } {
  return {
    pushToStores: hasStoreConnections,
    pushToBandcamp: hasBandcampMapping,
  };
}

export async function fanoutInventoryChange(
  workspaceId: string,
  sku: string,
  _newQuantity: number,
  delta?: number,
  correlationId?: string,
  source?: InventorySource,
): Promise<FanoutResult> {
  return Sentry.startSpan(
    {
      name: "inventory.fanout",
      op: "fanout.dispatch",
      attributes: {
        "fanout.workspace_id": workspaceId,
        "fanout.sku": sku,
        "fanout.delta": delta ?? 0,
        "fanout.correlation_id": correlationId ?? "",
        "fanout.source": source ?? "",
      },
    },
    async (span) => {
      const supabase = createServiceRoleClient();

      // Audit fix F2 (2026-04-13): honor the global inventory_sync_paused
      // kill switch immediately, before any Trigger enqueue. Pre-fix the
      // docstring promised this behavior but the body did not implement
      // it — downstream tasks gated correctly so no remote API hit landed,
      // but Trigger.dev still received enqueues and the kill switch was
      // not "immediate" as documented. This early-return makes the flag
      // behave the way operators (and §19 rollback) expect.
      const { data: ws } = await supabase
        .from("workspaces")
        .select("inventory_sync_paused")
        .eq("id", workspaceId)
        .maybeSingle();
      if (ws?.inventory_sync_paused) {
        span?.setAttribute("fanout.skipped", "inventory_sync_paused");
        return {
          storeConnectionsPushed: 0,
          bandcampPushed: false,
          shopifyPushed: false,
          shipstationV2Enqueued: false,
        };
      }

      const guard = await loadFanoutGuard(supabase, workspaceId);
      const effectiveCorrelationId = correlationId ?? `fanout:${sku}:${Date.now()}`;

      let storeConnectionsPushed = 0;
      let bandcampPushed = false;
      let shopifyPushed = false;
      let shipstationV2Enqueued = false;

      const { data: variant } = await supabase
        .from("warehouse_product_variants")
        .select("id, shopify_inventory_item_id")
        .eq("workspace_id", workspaceId)
        .eq("sku", sku)
        .single();

      if (
        variant?.shopify_inventory_item_id &&
        delta != null &&
        delta !== 0 &&
        guard.shouldFanout("clandestine_shopify", effectiveCorrelationId)
      ) {
        try {
          await Sentry.startSpan(
            {
              name: "inventory.fanout.shopify",
              op: "fanout.shopify",
              attributes: { "fanout.sku": sku, "fanout.delta": delta },
            },
            () =>
              inventoryAdjustQuantities(
                variant.shopify_inventory_item_id as string,
                SHOPIFY_LOCATION_ID,
                delta,
                effectiveCorrelationId,
              ),
          );
          shopifyPushed = true;
        } catch (err) {
          Sentry.captureException(err, {
            tags: { fanout_target: "clandestine_shopify", sku },
            extra: { workspaceId, correlationId: effectiveCorrelationId },
          });
          console.error(
            `[fanout] Shopify push failed for SKU=${sku}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const { data: skuMappings } = await supabase
        .from("client_store_sku_mappings")
        .select("connection_id")
        .eq("is_active", true)
        .eq("remote_sku", sku);

      const { data: bandcampMappings } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, variant_id")
        .eq("workspace_id", workspaceId);

      const hasBandcampMapping =
        variant &&
        (bandcampMappings ?? []).some(
          (m) => (m as Record<string, unknown>).variant_id === variant.id,
        );

      const targets = determineFanoutTargets((skuMappings ?? []).length > 0, !!hasBandcampMapping);

      if (targets.pushToStores && guard.shouldFanout("client_store", effectiveCorrelationId)) {
        try {
          await tasks.trigger("multi-store-inventory-push", {});
          storeConnectionsPushed = (skuMappings ?? []).length;
        } catch {
          /* non-critical */
        }
      }

      if (targets.pushToBandcamp && guard.shouldFanout("bandcamp", effectiveCorrelationId)) {
        try {
          await tasks.trigger("bandcamp-inventory-push", {});
          bandcampPushed = true;
        } catch {
          /* non-critical */
        }
      }

      // Audit fix F1 (2026-04-13) — ShipStation v2 SKU-total fanout target.
      // Closes the FR-1 gap from the weekend mega-plan (§12 + §15.2): inline
      // Avail-cell edits, inbound check-ins, and any non-sale recordInventoryChange()
      // call now propagates to ShipStation v2 within the same correlation as
      // the originating event.
      //
      // Skip cascade:
      //   1. Source already reflects v2 state (Rule #65 echo cancellation):
      //        a. v2 itself wrote it — `shipstation` (SHIP_NOTIFY processor),
      //           `reconcile` (Phase 5 drift sensor).
      //        b. ShipStation Inventory Sync already mirrored a storefront
      //           sale into v2 — `shopify`, `squarespace`, `woocommerce`,
      //           `bandcamp` (added 2026-04-13 second-pass audit fix).
      //   2. No variant resolved (variant block at top of function).
      //   3. delta missing or zero — nothing to push.
      //   4. fanout-guard `shipstation` integration kill switch denies.
      //
      // The downstream task itself enforces another four guards (workspace v2
      // defaults present, variant exists, not a bundle parent, ledger not
      // already claimed) — so duplicate enqueues from sibling paths
      // (`shipstation-v2-decrement` for sales, `shipstation-v2-adjust-on-sku`
      // direct call from `submitManualInventoryCounts`) short-circuit safely
      // via `external_sync_events` UNIQUE on
      // `(system='shipstation_v2', correlation_id, sku, action)`.
      //
      // Per-location semantics rewrite is the deferred WS3 §3f task — gated
      // on the §15.3 probe. Sticky `has_per_location_data` flag is the pivot
      // key for that future rewrite; this SKU-total path is the interim.
      if (
        variant &&
        delta != null &&
        delta !== 0 &&
        !shouldEchoSkipShipstationV2(source) &&
        guard.shouldFanout("shipstation", effectiveCorrelationId)
      ) {
        try {
          const payload: ShipstationV2AdjustOnSkuPayload = {
            workspaceId,
            sku,
            delta,
            correlationId: effectiveCorrelationId,
            reason: source ? `fanout:${source}` : "fanout",
            metadata: {
              origin: "inventory-fanout",
              source: source ?? null,
            },
          };
          await tasks.trigger("shipstation-v2-adjust-on-sku", payload);
          shipstationV2Enqueued = true;
        } catch (err) {
          Sentry.captureException(err, {
            tags: { fanout_target: "shipstation_v2", sku },
            extra: { workspaceId, correlationId: effectiveCorrelationId, source },
          });
          console.error(
            `[fanout] ShipStation v2 enqueue failed for SKU=${sku}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (variant) {
        const { data: parentBundles } = await supabase
          .from("bundle_components")
          .select("bundle_variant_id")
          .eq("workspace_id", workspaceId)
          .eq("component_variant_id", variant.id)
          .limit(1);

        if (parentBundles?.length) {
          if (!targets.pushToBandcamp && guard.shouldFanout("bandcamp", effectiveCorrelationId)) {
            try {
              await tasks.trigger("bandcamp-inventory-push", {});
            } catch {
              /* */
            }
          }
          if (!targets.pushToStores && guard.shouldFanout("client_store", effectiveCorrelationId)) {
            try {
              await tasks.trigger("multi-store-inventory-push", {});
            } catch {
              /* */
            }
          }
        }
      }

      return { storeConnectionsPushed, bandcampPushed, shopifyPushed, shipstationV2Enqueued };
    },
  );
}
