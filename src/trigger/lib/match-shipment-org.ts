/**
 * Shipment → Organization matching logic.
 *
 * 3-tier fallback chain (mirrors old app behavior):
 *   1. warehouse_shipstation_stores lookup by store_id → org_id
 *   2. SKU-based matching: shipment item SKUs → warehouse_product_variants → warehouse_products.org_id
 *   3. Unmatched: returns null (caller decides how to handle)
 *
 * Shared by shipment-ingest (webhook) and shipstation-poll (cron).
 */

import { logger } from "@trigger.dev/sdk";
import type { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface OrgMatchResult {
  orgId: string;
  method: "store_mapping" | "sku_match";
  isDropShip: boolean;
}

/**
 * Attempt to match a ShipStation shipment to an organization.
 *
 * @param supabase - Service-role Supabase client
 * @param storeId  - ShipStation store ID (from advancedOptions or top-level)
 * @param itemSkus - SKUs from shipment items (for fallback matching)
 * @returns OrgMatchResult if matched, null if all tiers fail
 */
export async function matchShipmentOrg(
  supabase: ReturnType<typeof createServiceRoleClient>,
  storeId: number | null | undefined,
  itemSkus: string[],
): Promise<OrgMatchResult | null> {
  // Tier 1: warehouse_shipstation_stores lookup
  if (storeId) {
    const { data: store } = await supabase
      .from("warehouse_shipstation_stores")
      .select("org_id, is_drop_ship")
      .eq("store_id", storeId)
      .not("org_id", "is", null)
      .maybeSingle();

    if (store?.org_id) {
      logger.info(
        `Matched org via store mapping: store_id=${storeId} → org_id=${store.org_id}, drop_ship=${store.is_drop_ship}`,
      );
      return {
        orgId: store.org_id,
        method: "store_mapping",
        isDropShip: store.is_drop_ship ?? false,
      };
    }
  }

  // Tier 2: SKU-based matching
  const validSkus = itemSkus.filter((s) => s && s !== "UNKNOWN");
  if (validSkus.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("sku, warehouse_products!inner(org_id)")
      .in("sku", validSkus);

    if (variants && variants.length > 0) {
      // Count occurrences of each org_id — pick the majority
      const orgCounts: Record<string, number> = {};
      for (const v of variants) {
        const product = v.warehouse_products as unknown as { org_id: string } | null;
        const orgId = product?.org_id;
        if (orgId) {
          orgCounts[orgId] = (orgCounts[orgId] ?? 0) + 1;
        }
      }

      // Find the org_id with the most matches
      let bestOrgId: string | null = null;
      let bestCount = 0;
      for (const [orgId, count] of Object.entries(orgCounts)) {
        if (count > bestCount) {
          bestOrgId = orgId;
          bestCount = count;
        }
      }

      if (bestOrgId) {
        logger.info(
          `Matched org via SKU: ${bestCount}/${validSkus.length} SKUs → org_id=${bestOrgId}`,
        );
        return { orgId: bestOrgId, method: "sku_match", isDropShip: false };
      }
    }
  }

  // Tier 3: No match found
  logger.warn(`No org match for store_id=${storeId ?? "none"}, skus=[${validSkus.join(",")}]`);
  return null;
}
