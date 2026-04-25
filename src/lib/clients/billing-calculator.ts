import type { SupabaseClient } from "@supabase/supabase-js";
import { getEffectiveRate } from "@/lib/shared/billing-rates";
import { detectFormat } from "./format-detector";

// ── Consignment Payout Types (V7.2) ─────────────────────────────────────────

export interface ConsignmentPayoutSummary {
  org_id: string;
  total_payout_amount: number;
  order_count: number;
  order_ids: string[];
}

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
  drop_ship_cost: number;
  is_drop_ship: boolean;
  total_units: number;
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

interface AppliedRate {
  ruleType: string;
  ruleName: string;
  amount: number;
  source: "override" | "default";
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
  applied_rates: AppliedRate[];
  totals: {
    total_shipping: number;
    total_pick_pack: number;
    total_materials: number;
    total_drop_ship: number;
    total_storage: number;
    total_adjustments: number;
    grand_total: number;
  };
  warnings?: string[];
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
    formatRulesResult,
    formatCostsResult,
    rulesResult,
    adjustmentsResult,
    orgResult,
  ] = await Promise.all([
    supabase
      .from("warehouse_shipments")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("org_id", orgId)
      .gte("ship_date", billingPeriod.start)
      .lte("ship_date", billingPeriod.end),

    supabase
      .from("warehouse_format_rules")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("priority", { ascending: false }),

    supabase.from("warehouse_format_costs").select("*").eq("workspace_id", workspaceId),

    supabase
      .from("warehouse_billing_rules")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .lte("effective_from", billingPeriod.end),

    supabase
      .from("warehouse_billing_adjustments")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("org_id", orgId)
      .eq("billing_period", billingPeriod.label)
      .is("snapshot_id", null),

    supabase
      .from("organizations")
      .select("storage_fee_waived, warehouse_grace_period_ends_at")
      .eq("id", orgId)
      .single(),
  ]);

  const shipments = shipmentsResult.data ?? [];

  // Scoped + chunked items fetch (prevents unbounded query)
  const CHUNK_SIZE = 500;
  const shipmentIds = shipments.map((s) => s.id);
  type ShipmentItemRow = {
    id: string;
    shipment_id: string;
    sku: string;
    quantity: number;
    product_title: string | null;
    variant_title: string | null;
    workspace_id: string;
    [key: string]: unknown;
  };
  let allShipmentItems: ShipmentItemRow[] = [];

  for (let i = 0; i < shipmentIds.length; i += CHUNK_SIZE) {
    const chunk = shipmentIds.slice(i, i + CHUNK_SIZE);
    const { data } = await supabase
      .from("warehouse_shipment_items")
      .select("*")
      .in("shipment_id", chunk);
    if (data) allShipmentItems = allShipmentItems.concat(data as ShipmentItemRow[]);
  }
  const formatRules = formatRulesResult.data ?? [];
  const formatCosts = formatCostsResult.data ?? [];
  const _rules = rulesResult.data ?? [];
  const adjustments = adjustmentsResult.data ?? [];
  const _org = orgResult.data;

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
    const isDropShip = shipment.is_drop_ship ?? false;
    const totalUnits = shipment.total_units ?? items.reduce((s, i) => s + (i.quantity ?? 1), 0);

    includedShipments.push({
      shipment_id: shipment.id,
      tracking_number: shipment.tracking_number,
      ship_date: shipment.ship_date,
      carrier: shipment.carrier,
      shipping_cost: shipment.shipping_cost ?? 0,
      format_name: formatName,
      pick_pack_cost: isDropShip ? 0 : costs.pick_pack_cost,
      material_cost: costs.material_cost,
      drop_ship_cost: 0, // calculated below with rates
      is_drop_ship: isDropShip,
      total_units: totalUnits,
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
  let totalDropShip = 0;

  for (const s of includedShipments) {
    totalShipping += s.shipping_cost;
    totalPickPack += s.pick_pack_cost;
    totalMaterials += s.material_cost;
  }

  // Apply billing rules with org-specific overrides (two-tier lookup)
  const effectiveDate = billingPeriod.start;
  const appliedRates: AppliedRate[] = [];

  // Regular shipments: per_shipment rate (applied only to non-drop-ship)
  const regularShipments = includedShipments.filter((s) => !s.is_drop_ship);
  const dropShipments = includedShipments.filter((s) => s.is_drop_ship);

  const perShipmentRate = await getEffectiveRate(
    supabase,
    workspaceId,
    orgId,
    "per_shipment",
    effectiveDate,
  );
  if (perShipmentRate) {
    totalPickPack += perShipmentRate.amount * regularShipments.length;
    appliedRates.push({
      ruleType: "per_shipment",
      ruleName: perShipmentRate.ruleName,
      amount: perShipmentRate.amount,
      source: perShipmentRate.source,
    });
  }

  // Drop-ship shipments: base + per-unit rate
  if (dropShipments.length > 0) {
    const dropShipBaseRate = await getEffectiveRate(
      supabase,
      workspaceId,
      orgId,
      "per_shipment",
      effectiveDate,
    );
    const dropShipPerUnitRate = await getEffectiveRate(
      supabase,
      workspaceId,
      orgId,
      "per_item",
      effectiveDate,
    );

    const baseRate = dropShipBaseRate?.amount ?? 0;
    const perUnitRate = dropShipPerUnitRate?.amount ?? 0;

    if (dropShipBaseRate) {
      appliedRates.push({
        ruleType: "drop_ship_base",
        ruleName: dropShipBaseRate.ruleName,
        amount: dropShipBaseRate.amount,
        source: dropShipBaseRate.source,
      });
    }
    if (dropShipPerUnitRate) {
      appliedRates.push({
        ruleType: "drop_ship_per_unit",
        ruleName: dropShipPerUnitRate.ruleName,
        amount: dropShipPerUnitRate.amount,
        source: dropShipPerUnitRate.source,
      });
    }

    for (const s of dropShipments) {
      const units = Math.max(s.total_units, 1);
      const cost = baseRate + Math.max(units - 1, 0) * perUnitRate;
      s.drop_ship_cost = cost;
      totalDropShip += cost;
    }
  }

  // Storage: sourced from storage_fee adjustments written by storage-calc.ts
  // (no inline calc — prevents double-counting)
  const storageAdjustments = adjustments.filter((a) => a.reason === "storage_fee");
  const manualAdjustments = adjustments.filter((a) => a.reason !== "storage_fee");

  const totalStorage = storageAdjustments.reduce((sum, a) => sum + (a.amount ?? 0), 0);
  const totalAdjustments = manualAdjustments.reduce((sum, a) => sum + (a.amount ?? 0), 0);

  // Build storage line items from the JSONB details on storage_fee adjustments
  const storageLineItems: StorageLineItem[] = [];
  for (const adj of storageAdjustments) {
    const details = (adj as Record<string, unknown>).details as
      | { line_items?: StorageLineItem[] }
      | null
      | undefined;
    if (details?.line_items) {
      storageLineItems.push(...details.line_items);
    }
  }

  const grandTotal =
    totalShipping +
    totalPickPack +
    totalMaterials +
    totalDropShip +
    totalStorage +
    totalAdjustments;

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
    applied_rates: appliedRates,
    totals: {
      total_shipping: totalShipping,
      total_pick_pack: totalPickPack,
      total_materials: totalMaterials,
      total_drop_ship: totalDropShip,
      total_storage: totalStorage,
      total_adjustments: totalAdjustments,
      grand_total: grandTotal,
    },
  };
}

/**
 * Calculate consignment payouts owed to a client org for a billing period.
 *
 * Queries mailorder_orders with client_payout_status = 'pending' for orders
 * created within the billing period.
 *
 * Payout formula: client_payout_amount (= subtotal * 0.5, set at order insert).
 * NEVER use total_price — shipping belongs 100% to Clandestine.
 *
 * Rule #22: math stays in TypeScript; DB updates happen in monthly-billing.ts.
 */
export async function calculateConsignmentPayouts(
  supabase: SupabaseClient,
  workspaceId: string,
  orgId: string,
  billingPeriod: BillingPeriod,
): Promise<ConsignmentPayoutSummary> {
  const { data: pendingOrders } = await supabase
    .from("mailorder_orders")
    .select("id, client_payout_amount, subtotal")
    .eq("workspace_id", workspaceId)
    .eq("org_id", orgId)
    .eq("client_payout_status", "pending")
    .gte("created_at", `${billingPeriod.start}T00:00:00.000Z`)
    .lte("created_at", `${billingPeriod.end}T23:59:59.999Z`);

  const orders = pendingOrders ?? [];

  // Use stored client_payout_amount; fall back to subtotal * 0.5 if somehow null
  // CRITICAL: do NOT multiply subtotal by total_price — shipping is excluded
  const total = orders.reduce((sum, o) => {
    const payout =
      o.client_payout_amount != null ? Number(o.client_payout_amount) : Number(o.subtotal) * 0.5;
    return sum + payout;
  }, 0);

  return {
    org_id: orgId,
    total_payout_amount: total,
    order_count: orders.length,
    order_ids: orders.map((o) => o.id),
  };
}
