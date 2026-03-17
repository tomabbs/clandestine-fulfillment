/**
 * Inventory fanout — Rule #43 step (4).
 *
 * Called after recordInventoryChange succeeds.
 * Enqueues downstream pushes for affected SKU.
 */

import { tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface FanoutResult {
  storeConnectionsPushed: number;
  bandcampPushed: boolean;
}

/**
 * Determines which downstream systems need updating when an inventory SKU changes.
 * Pure logic — exported for testing.
 */
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
): Promise<FanoutResult> {
  const supabase = createServiceRoleClient();
  let storeConnectionsPushed = 0;
  let bandcampPushed = false;

  // Check if SKU has store connection mappings
  const { data: skuMappings } = await supabase
    .from("client_store_sku_mappings")
    .select("connection_id")
    .eq("is_active", true)
    .eq("remote_sku", sku);

  // Check if SKU has a Bandcamp mapping
  const { data: bandcampMappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("id")
    .eq("workspace_id", workspaceId);

  // Get the variant for this SKU to check Bandcamp mapping
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();

  const hasBandcampMapping =
    variant &&
    (bandcampMappings ?? []).some((m) => (m as Record<string, unknown>).variant_id === variant.id);

  const targets = determineFanoutTargets((skuMappings ?? []).length > 0, !!hasBandcampMapping);

  // Enqueue multi-store push (it handles all connections)
  if (targets.pushToStores) {
    try {
      await tasks.trigger("multi-store-inventory-push", {});
      storeConnectionsPushed = (skuMappings ?? []).length;
    } catch {
      // Non-critical: the cron will pick it up in the next cycle
    }
  }

  // Enqueue Bandcamp push
  if (targets.pushToBandcamp) {
    try {
      await tasks.trigger("bandcamp-inventory-push", {});
      bandcampPushed = true;
    } catch {
      // Non-critical
    }
  }

  return { storeConnectionsPushed, bandcampPushed };
}
