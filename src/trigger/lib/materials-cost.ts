/**
 * Materials cost calculation — determines packaging materials cost for a shipment.
 *
 * Ported from release-manager warehouse/billing.ts sumMaterials pattern.
 * Uses format detection + warehouse_format_costs lookup.
 *
 * The billing calculator (src/lib/clients/billing-calculator.ts) computes
 * authoritative materials costs at snapshot time. This module provides
 * on-demand cost estimation for operational visibility (e.g. Shipping page,
 * shipment detail view).
 */

import type { createServiceRoleClient } from "@/lib/server/supabase-server";
import { detectShipmentFormat, type ShipmentItem } from "./format-detection";

/** Round to 2 decimal places (currency precision). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface MaterialsCostResult {
  formatKey: string;
  formatDisplayName: string;
  pickPackCost: number;
  materialCost: number;
  totalMaterialsCost: number;
  found: boolean;
}

/**
 * Estimate materials cost for a shipment based on its items.
 *
 * 1. Detects dominant format via detectShipmentFormat()
 * 2. Looks up warehouse_format_costs for that format
 * 3. Returns pick_pack_cost + material_cost
 *
 * Returns { found: false } if no format cost entry exists.
 */
export async function estimateMaterialsCost(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  items: ShipmentItem[],
): Promise<MaterialsCostResult> {
  const format = detectShipmentFormat(items);

  if (format.formatKey === "unknown") {
    return {
      formatKey: "unknown",
      formatDisplayName: "Unknown",
      pickPackCost: 0,
      materialCost: 0,
      totalMaterialsCost: 0,
      found: false,
    };
  }

  const { data } = await supabase
    .from("warehouse_format_costs")
    .select("pick_pack_cost, material_cost")
    .eq("workspace_id", workspaceId)
    .eq("format_name", format.formatKey)
    .maybeSingle();

  if (!data) {
    return {
      formatKey: format.formatKey,
      formatDisplayName: format.displayName,
      pickPackCost: 0,
      materialCost: 0,
      totalMaterialsCost: 0,
      found: false,
    };
  }

  const pickPack = round2(Number(data.pick_pack_cost));
  const material = round2(Number(data.material_cost));

  return {
    formatKey: format.formatKey,
    formatDisplayName: format.displayName,
    pickPackCost: pickPack,
    materialCost: material,
    totalMaterialsCost: round2(pickPack + material),
    found: true,
  };
}
