/**
 * Storage fee calculation — cron 1st of month at 1 AM EST.
 * Runs BEFORE monthly-billing (2 AM) so storage adjustments are ready.
 *
 * Active stock = units shipped per SKU in last 6 months.
 * Billable storage = max(0, total inventory - active stock).
 * Skips orgs with storage_fee_waived=true or warehouse_grace_period_ends_at > today.
 *
 * Rule #7: Uses createServiceRoleClient().
 */

import { schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface StorageCalcResult {
  orgsProcessed: number;
  orgsSkipped: number;
  totalBillableUnits: number;
}

export function computeActiveStock(
  salesBySkuLast6Months: Map<string, number>,
  inventoryBySku: Map<string, number>,
): Array<{ sku: string; totalInventory: number; activeStock: number; billableUnits: number }> {
  const results: Array<{
    sku: string;
    totalInventory: number;
    activeStock: number;
    billableUnits: number;
  }> = [];

  for (const [sku, available] of Array.from(inventoryBySku.entries())) {
    if (available <= 0) continue;
    const activeStock = salesBySkuLast6Months.get(sku) ?? 0;
    const billableUnits = Math.max(0, available - activeStock);
    results.push({ sku, totalInventory: available, activeStock, billableUnits });
  }

  return results;
}

export function shouldSkipOrg(org: {
  storage_fee_waived: boolean | null;
  warehouse_grace_period_ends_at: string | null;
}): boolean {
  if (org.storage_fee_waived === true) return true;
  if (org.warehouse_grace_period_ends_at) {
    const today = new Date().toISOString().split("T")[0];
    if (org.warehouse_grace_period_ends_at > today) return true;
  }
  return false;
}

export const storageCalcTask = schedules.task({
  id: "storage-calc",
  cron: {
    pattern: "0 1 1 * *",
    timezone: "America/New_York",
  },
  maxDuration: 600, // 10 min — iterates all inventory per org
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const now = new Date();
    const billingMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const billingYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const billingPeriod = `${billingYear}-${String(billingMonth).padStart(2, "0")}`;

    let orgsProcessed = 0;
    let orgsSkipped = 0;
    let totalBillableUnits = 0;

    for (const workspaceId of workspaceIds) {
      const { data: orgs } = await supabase
        .from("organizations")
        .select("id, storage_fee_waived, warehouse_grace_period_ends_at")
        .eq("workspace_id", workspaceId);

      if (!orgs) continue;

      // Get storage fee rate
      const { data: storageRule } = await supabase
        .from("warehouse_billing_rules")
        .select("amount")
        .eq("workspace_id", workspaceId)
        .eq("rule_type", "storage")
        .eq("is_active", true)
        .single();

      const storageFeePerUnit = storageRule?.amount ?? 0;
      if (storageFeePerUnit === 0) {
        orgsSkipped += orgs.length;
        continue;
      }

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const sixMonthsAgoStr = sixMonthsAgo.toISOString().split("T")[0];

      for (const org of orgs) {
        if (shouldSkipOrg(org)) {
          orgsSkipped++;
          continue;
        }

        // Get inventory levels for this org
        const { data: levels } = await supabase
          .from("warehouse_inventory_levels")
          .select("sku, available")
          .eq("workspace_id", workspaceId)
          .eq("org_id", org.id);

        const inventoryBySku = new Map((levels ?? []).map((l) => [l.sku, l.available as number]));

        // Get sales in last 6 months
        const { data: recentShipments } = await supabase
          .from("warehouse_shipments")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("org_id", org.id)
          .eq("voided", false)
          .gte("ship_date", sixMonthsAgoStr);

        const salesBySku = new Map<string, number>();
        if (recentShipments && recentShipments.length > 0) {
          const shipmentIds = recentShipments.map((s) => s.id);
          const { data: items } = await supabase
            .from("warehouse_shipment_items")
            .select("sku, quantity")
            .in("shipment_id", shipmentIds);

          for (const item of items ?? []) {
            salesBySku.set(item.sku, (salesBySku.get(item.sku) ?? 0) + item.quantity);
          }
        }

        const activeStockResults = computeActiveStock(salesBySku, inventoryBySku);
        const orgBillableUnits = activeStockResults.reduce((sum, r) => sum + r.billableUnits, 0);

        if (orgBillableUnits > 0) {
          const totalFee = orgBillableUnits * storageFeePerUnit;

          // Write as billing adjustment for the monthly-billing task to consume
          await supabase.from("warehouse_billing_adjustments").insert({
            workspace_id: workspaceId,
            org_id: org.id,
            billing_period: billingPeriod,
            amount: totalFee,
            reason: "storage_fee",
          });

          totalBillableUnits += orgBillableUnits;
        }

        orgsProcessed++;
      }
    }

    return { orgsProcessed, orgsSkipped, totalBillableUnits };
  },
});
