/**
 * Inventory fanout — Rule #43 step (4).
 *
 * Called after recordInventoryChange succeeds.
 * Pushes inventory changes to all downstream systems:
 * - Clandestine Shopify (direct API, not client_store_connections)
 * - Bandcamp (via bandcamp-inventory-push task)
 * - Client stores (via multi-store-inventory-push task)
 *
 * When workspaces.inventory_sync_paused is true, all outbound pushes are
 * skipped immediately. recordInventoryChange() still completes — Redis + Postgres
 * stay current. The updated quantities are pushed when sync resumes.
 */

import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import { inventoryAdjustQuantities } from "@/lib/clients/shopify-client";
import { loadFanoutGuard } from "@/lib/server/fanout-guard";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const SHOPIFY_LOCATION_ID = "gid://shopify/Location/104066613563";

export interface FanoutResult {
  storeConnectionsPushed: number;
  bandcampPushed: boolean;
  shopifyPushed: boolean;
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
      },
    },
    async () => {
      const supabase = createServiceRoleClient();
      const guard = await loadFanoutGuard(supabase, workspaceId);
      const effectiveCorrelationId = correlationId ?? `fanout:${sku}:${Date.now()}`;

      let storeConnectionsPushed = 0;
      let bandcampPushed = false;
      let shopifyPushed = false;

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

      return { storeConnectionsPushed, bandcampPushed, shopifyPushed };
    },
  );
}
