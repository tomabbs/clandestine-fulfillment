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

import { tasks } from "@trigger.dev/sdk";
import { inventoryAdjustQuantities } from "@/lib/clients/shopify-client";
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
  const supabase = createServiceRoleClient();

  // Pause guard — single primary-key lookup before any outbound work
  const { data: ws } = await supabase
    .from("workspaces")
    .select("inventory_sync_paused")
    .eq("id", workspaceId)
    .single();

  if (ws?.inventory_sync_paused) {
    return { storeConnectionsPushed: 0, bandcampPushed: false, shopifyPushed: false };
  }

  let storeConnectionsPushed = 0;
  let bandcampPushed = false;
  let shopifyPushed = false;

  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id, shopify_inventory_item_id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();

  // Push to Clandestine Shopify via direct API (not client_store_connections)
  if (variant?.shopify_inventory_item_id && delta != null && delta !== 0) {
    try {
      await inventoryAdjustQuantities(
        variant.shopify_inventory_item_id,
        SHOPIFY_LOCATION_ID,
        delta,
        correlationId ?? `fanout:${sku}:${Date.now()}`,
      );
      shopifyPushed = true;
    } catch (err) {
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
    (bandcampMappings ?? []).some((m) => (m as Record<string, unknown>).variant_id === variant.id);

  const targets = determineFanoutTargets((skuMappings ?? []).length > 0, !!hasBandcampMapping);

  if (targets.pushToStores) {
    try {
      await tasks.trigger("multi-store-inventory-push", {});
      storeConnectionsPushed = (skuMappings ?? []).length;
    } catch {
      /* non-critical */
    }
  }

  if (targets.pushToBandcamp) {
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
      if (!targets.pushToBandcamp) {
        try {
          await tasks.trigger("bandcamp-inventory-push", {});
        } catch {
          /* */
        }
      }
      if (!targets.pushToStores) {
        try {
          await tasks.trigger("multi-store-inventory-push", {});
        } catch {
          /* */
        }
      }
    }
  }

  return { storeConnectionsPushed, bandcampPushed, shopifyPushed };
}
