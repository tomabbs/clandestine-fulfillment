import type { SupabaseClient } from "@supabase/supabase-js";
import { detectFormat } from "./format-detector";

interface BillingPeriod {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  label: string; // YYYY-MM
}

interface ShipmentLineItem {
  shipment_id: string;
  tracking_number: string | null;
  ship_date: string | null;
  carrier: string | null;
  shipping_cost: number;
  format_name: string;
  pick_pack_cost: number;
  material_cost: number;
  items: Array<{
    sku: string;
    quantity: number;
    product_title: string | null;
  }>;
}

interface ExcludedShipment {
  shipment_id: string;
  tracking_number: string | null;
  reason: "already_billed" | "voided" | "outside_period" | "no_ship_date";
}

interface StorageLineItem {
  sku: string;
  total_inventory: number;
  active_stock_threshold: number;
  billable_units: number;
  storage_fee: number;
}

export interface BillingSnapshotData {
  billing_period: string;
  org_id: string;
  workspace_id: string;
  generated_at: string;
  included_shipments: ShipmentLineItem[];
  excluded_shipments: ExcludedShipment[];
  storage_line_items: StorageLineItem[];
  adjustments: Array<{
    id: string;
    amount: number;
    reason: string | null;
  }>;
  totals: {
    total_shipping: number;
    total_pick_pack: number;
    total_materials: number;
    total_storage: number;
    total_adjustments: number;
    grand_total: number;
  };
}

/**
 * Main billing aggregation function. Computes a complete billing snapshot
 * for one org in one billing period. Rule #16: itemized breakdown with
 * inclusion/exclusion reasons.
 *
 * Rule #22: billing math stays in TypeScript; row locking in Postgres via RPC.
 */
export async function calculateBillingForOrg(
  supabase: SupabaseClient,
  workspaceId: string,
  orgId: string,
  billingPeriod: BillingPeriod,
): Promise<BillingSnapshotData> {
  // Fetch all data in parallel
  const [
    shipmentsResult,
    shipmentItemsResult,
    formatRulesResult,
    formatCostsResult,
    rulesResult,
    adjustmentsResult,
    orgResult,
    inventoryResult,
  ] = await Promise.all([
    // All shipments for the org in the period (not filtering billed/voided yet — we need them for exclusion reasons)
    supabase
      .from("warehouse_shipments")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("org_id", orgId)
      .gte("ship_date", billingPeriod.start)
      .lte("ship_date", billingPeriod.end),

    // Shipment items (need for format detection)
    supabase.from("warehouse_shipment_items").select("*").eq("workspace_id", workspaceId),

    // Format rules for detection
    supabase
      .from("warehouse_format_rules")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("priority", { ascending: false }),

    // Format costs for pricing
    supabase.from("warehouse_format_costs").select("*").eq("workspace_id", workspaceId),

    // Billing rules (active, effective before period end)
    supabase
      .from("warehouse_billing_rules")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .lte("effective_from", billingPeriod.end),

    // Manual adjustments for this period
    supabase
      .from("warehouse_billing_adjustments")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("org_id", orgId)
      .eq("billing_period", billingPeriod.label)
      .is("snapshot_id", null),

    // Org details (for storage fee waiver check)
    supabase
      .from("organizations")
      .select("storage_fee_waived, warehouse_grace_period_ends_at")
      .eq("id", orgId)
      .single(),

    // Inventory levels for storage calculation
    supabase
      .from("warehouse_inventory_levels")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("org_id", orgId),
  ]);

  const shipments = shipmentsResult.data ?? [];
  const allShipmentItems = shipmentItemsResult.data ?? [];
  const formatRules = formatRulesResult.data ?? [];
  const formatCosts = formatCostsResult.data ?? [];
  const rules = rulesResult.data ?? [];
  const adjustments = adjustmentsResult.data ?? [];
  const org = orgResult.data;
  const inventoryLevels = inventoryResult.data ?? [];

  // Build format cost lookup
  const formatCostMap = new Map<string, { pick_pack_cost: number; material_cost: number }>();
  for (const fc of formatCosts) {
    formatCostMap.set(fc.format_name, {
      pick_pack_cost: fc.pick_pack_cost,
      material_cost: fc.material_cost,
    });
  }

  // Build shipment items lookup by shipment_id
  const itemsByShipment = new Map<string, typeof allShipmentItems>();
  for (const item of allShipmentItems) {
    const existing = itemsByShipment.get(item.shipment_id) ?? [];
    existing.push(item);
    itemsByShipment.set(item.shipment_id, existing);
  }

  // Process shipments — Rule #16: track included AND excluded with reasons
  const includedShipments: ShipmentLineItem[] = [];
  const excludedShipments: ExcludedShipment[] = [];

  // Also fetch shipments with no ship_date for exclusion tracking
  const noDateResult = await supabase
    .from("warehouse_shipments")
    .select("id, tracking_number")
    .eq("workspace_id", workspaceId)
    .eq("org_id", orgId)
    .is("ship_date", null);

  for (const s of noDateResult.data ?? []) {
    excludedShipments.push({
      shipment_id: s.id,
      tracking_number: s.tracking_number,
      reason: "no_ship_date",
    });
  }

  for (const shipment of shipments) {
    if (shipment.voided) {
      excludedShipments.push({
        shipment_id: shipment.id,
        tracking_number: shipment.tracking_number,
        reason: "voided",
      });
      continue;
    }

    if (shipment.billed) {
      excludedShipments.push({
        shipment_id: shipment.id,
        tracking_number: shipment.tracking_number,
        reason: "already_billed",
      });
      continue;
    }

    // Get items for this shipment
    const items = itemsByShipment.get(shipment.id) ?? [];
    const primaryTitle = items[0]?.product_title ?? null;
    const primarySku = items[0]?.sku ?? null;

    // Detect format from first item
    const formatName = detectFormat(primaryTitle, primarySku, [], formatRules);
    const costs = formatCostMap.get(formatName) ?? { pick_pack_cost: 0, material_cost: 0 };

    includedShipments.push({
      shipment_id: shipment.id,
      tracking_number: shipment.tracking_number,
      ship_date: shipment.ship_date,
      carrier: shipment.carrier,
      shipping_cost: shipment.shipping_cost ?? 0,
      format_name: formatName,
      pick_pack_cost: costs.pick_pack_cost,
      material_cost: costs.material_cost,
      items: items.map((i) => ({
        sku: i.sku,
        quantity: i.quantity,
        product_title: i.product_title,
      })),
    });
  }

  // Calculate shipping/pick_pack/materials totals
  let totalShipping = 0;
  let totalPickPack = 0;
  let totalMaterials = 0;

  for (const s of includedShipments) {
    totalShipping += s.shipping_cost;
    totalPickPack += s.pick_pack_cost;
    totalMaterials += s.material_cost;
  }

  // Apply billing rules (per_shipment, per_item types)
  for (const rule of rules) {
    if (rule.rule_type === "per_shipment") {
      totalPickPack += rule.amount * includedShipments.length;
    }
  }

  // Storage calculation
  const storageLineItems: StorageLineItem[] = [];
  let totalStorage = 0;

  const today = new Date().toISOString().split("T")[0];
  const storageWaived =
    org?.storage_fee_waived === true ||
    (org?.warehouse_grace_period_ends_at != null && org.warehouse_grace_period_ends_at > today);

  if (!storageWaived) {
    // Get shipment counts per SKU in the last 6 months for "active stock" determination
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().split("T")[0];

    const recentShipmentsResult = await supabase
      .from("warehouse_shipments")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("org_id", orgId)
      .eq("voided", false)
      .gte("ship_date", sixMonthsAgoStr);

    const recentShipmentIds = (recentShipmentsResult.data ?? []).map((s) => s.id);

    // Get item quantities shipped per SKU in last 6 months
    const skuSalesMap = new Map<string, number>();
    if (recentShipmentIds.length > 0) {
      const recentItemsResult = await supabase
        .from("warehouse_shipment_items")
        .select("sku, quantity")
        .in("shipment_id", recentShipmentIds);

      for (const item of recentItemsResult.data ?? []) {
        skuSalesMap.set(item.sku, (skuSalesMap.get(item.sku) ?? 0) + item.quantity);
      }
    }

    // Find the storage rule for fee amount
    const storageRule = rules.find((r) => r.rule_type === "storage");
    const storageFeePerUnit = storageRule?.amount ?? 0;

    for (const inv of inventoryLevels) {
      if (inv.available <= 0) continue;

      const activeStockThreshold = skuSalesMap.get(inv.sku) ?? 0;
      const billableUnits = Math.max(0, inv.available - activeStockThreshold);

      if (billableUnits > 0) {
        const fee = billableUnits * storageFeePerUnit;
        totalStorage += fee;
        storageLineItems.push({
          sku: inv.sku,
          total_inventory: inv.available,
          active_stock_threshold: activeStockThreshold,
          billable_units: billableUnits,
          storage_fee: fee,
        });
      }
    }
  }

  // Adjustments
  const totalAdjustments = adjustments.reduce((sum, a) => sum + (a.amount ?? 0), 0);

  const grandTotal =
    totalShipping + totalPickPack + totalMaterials + totalStorage + totalAdjustments;

  return {
    billing_period: billingPeriod.label,
    org_id: orgId,
    workspace_id: workspaceId,
    generated_at: new Date().toISOString(),
    included_shipments: includedShipments,
    excluded_shipments: excludedShipments,
    storage_line_items: storageLineItems,
    adjustments: adjustments.map((a) => ({
      id: a.id,
      amount: a.amount,
      reason: a.reason,
    })),
    totals: {
      total_shipping: totalShipping,
      total_pick_pack: totalPickPack,
      total_materials: totalMaterials,
      total_storage: totalStorage,
      total_adjustments: totalAdjustments,
      grand_total: grandTotal,
    },
  };
}
