"use server";

// Rule #4: Server Actions for mutations, React Query for reads
// Rule #5: Zod for all boundaries

import { runs, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  ASENDIA_CARRIER_ACCOUNT_ID,
  createShipment,
  isDomesticShipment,
  selectBestRate,
  WAREHOUSE_ADDRESS,
} from "@/lib/clients/easypost-client";
import { getServiceDetails, normalizeService } from "@/lib/clients/easypost-service-map";
import { requireStaff } from "@/lib/server/auth-context";
import { fetchBandcampShippingPaidForPayment } from "@/lib/server/bandcamp-shipping-paid";
import {
  batchBuildFormatCostMaps,
  computeCostsFromMaps,
  computeFulfillmentCostBreakdown,
} from "@/lib/server/shipment-fulfillment-cost";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { normalizeAddress } from "@/lib/shared/address-normalize";
import { maxShippingFromOrderLineItems } from "@/lib/utils";

// === Schemas ===

const getShipmentsSchema = z.object({
  search: z.string().optional(),
  orgId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  status: z.string().optional(),
  carrier: z.string().optional(),
  labelSource: z.enum(["shipstation", "pirate_ship", "easypost", "manual"]).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(250).default(50),
});

export type GetShipmentsFilters = z.infer<typeof getShipmentsSchema>;

// === Helpers ===

interface LabelDataAddress {
  name?: string | null;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
}

function firstNonEmpty(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/** Normalize shipTo / recipient objects (Pirate Ship uses address1 + zip; UI expects street1 + postalCode). */
function normalizeLabelRecipient(raw: Record<string, unknown>): LabelDataAddress {
  return {
    name: firstNonEmpty(raw, ["name", "first_name", "firstName"]) ?? null,
    company: firstNonEmpty(raw, ["company"]) ?? null,
    street1:
      firstNonEmpty(raw, ["street1", "address1", "address_1", "line1", "address_line1"]) ?? null,
    street2:
      firstNonEmpty(raw, ["street2", "address2", "address_2", "line2", "address_line2"]) ?? null,
    city: firstNonEmpty(raw, ["city"]) ?? null,
    state: firstNonEmpty(raw, ["state", "province", "region"]) ?? null,
    postalCode:
      firstNonEmpty(raw, ["postalCode", "zip", "postal_code", "postcode", "zipcode"]) ?? null,
    country: firstNonEmpty(raw, ["country", "country_code", "countryCode"]) ?? null,
    phone: firstNonEmpty(raw, ["phone"]) ?? null,
  };
}

function recipientFromOrderShippingAddress(addr: Record<string, unknown>): LabelDataAddress {
  return normalizeLabelRecipient(addr);
}

function mergeRecipients(
  fromLabel: LabelDataAddress | null,
  fromOrder: LabelDataAddress | null,
): LabelDataAddress | null {
  if (!fromLabel && !fromOrder) return null;
  if (!fromLabel) return fromOrder;
  if (!fromOrder) return fromLabel;
  return {
    name: fromLabel.name ?? fromOrder.name ?? null,
    company: fromLabel.company ?? fromOrder.company ?? null,
    street1: fromLabel.street1 ?? fromOrder.street1 ?? null,
    street2: fromLabel.street2 ?? fromOrder.street2 ?? null,
    city: fromLabel.city ?? fromOrder.city ?? null,
    state: fromLabel.state ?? fromOrder.state ?? null,
    postalCode: fromLabel.postalCode ?? fromOrder.postalCode ?? null,
    country: fromLabel.country ?? fromOrder.country ?? null,
    phone: fromLabel.phone ?? fromOrder.phone ?? null,
  };
}

function extractRecipient(labelData: Record<string, unknown> | null): LabelDataAddress | null {
  if (!labelData) return null;
  if (labelData.shipTo && typeof labelData.shipTo === "object") {
    return normalizeLabelRecipient(labelData.shipTo as Record<string, unknown>);
  }
  if (labelData.recipient && typeof labelData.recipient === "object") {
    return normalizeLabelRecipient(labelData.recipient as Record<string, unknown>);
  }
  return null;
}

function getCarrierTrackingUrl(
  carrier: string | null,
  trackingNumber: string | null,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const c = carrier.toLowerCase();
  if (c.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingNumber}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes("dhl"))
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
  return null;
}

// === Actions ===

export async function getShipments(filters: GetShipmentsFilters) {
  const parsed = getShipmentsSchema.parse(filters);
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_shipments")
    .select(
      "id, workspace_id, org_id, shipstation_shipment_id, ss_order_number, order_id, tracking_number, carrier, service, ship_date, delivery_date, status, shipping_cost, customer_shipping_charged, weight, label_data, voided, billed, created_at, total_units, label_source, bandcamp_payment_id, bandcamp_synced_at, public_track_token, organizations!inner(name), warehouse_orders(order_number, shipping_cost, line_items), warehouse_shipment_items(id, sku, quantity, product_title, variant_title, format_name_override)",
      { count: "exact" },
    );

  if (parsed.search) {
    const term = `%${parsed.search}%`;
    query = query.or(`tracking_number.ilike.${term},carrier.ilike.${term}`);
  }
  if (parsed.orgId) {
    query = query.eq("org_id", parsed.orgId);
  }
  if (parsed.dateFrom) {
    query = query.gte("ship_date", parsed.dateFrom);
  }
  if (parsed.dateTo) {
    query = query.lte("ship_date", parsed.dateTo);
  }
  if (parsed.status) {
    query = query.eq("status", parsed.status);
  }
  if (parsed.carrier) {
    query = query.eq("carrier", parsed.carrier);
  }
  if (parsed.labelSource) {
    query = query.eq("label_source", parsed.labelSource);
  }

  const from = (parsed.page - 1) * parsed.pageSize;
  const to = from + parsed.pageSize - 1;

  const { data, error, count } = await query
    .order("ship_date", { ascending: false })
    .range(from, to);

  if (error) throw new Error(`Failed to fetch shipments: ${error.message}`);

  const rows = data ?? [];

  // Batch-enrich with fulfillment costs grouped by workspace_id.
  // Doing one variant + format_cost lookup per workspace avoids N+1 queries.
  const workspaceIds = Array.from(
    new Set(rows.map((s) => s.workspace_id).filter((id): id is string => !!id)),
  );

  type ShipmentItem = {
    sku?: string | null;
    quantity?: number | null;
    product_title?: string | null;
    variant_title?: string | null;
    format_name_override?: string | null;
  };
  type EnrichedRow = (typeof rows)[number] & {
    fulfillment_total: number | null;
    fulfillment_partial: boolean;
  };

  const byId = new Map<string, EnrichedRow>();
  for (const s of rows) {
    byId.set(s.id, {
      ...s,
      fulfillment_total: s.shipping_cost ?? null,
      fulfillment_partial: false,
    });
  }

  if (workspaceIds.length > 0) {
    await Promise.all(
      workspaceIds.map(async (wsId) => {
        const wsRows = rows.filter((s) => s.workspace_id === wsId);
        // Collect all SKUs and build a sku→title map for title-based format fallback plus
        // a sku→override map for staff-assigned formats (highest priority).
        const allSkus: string[] = [];
        const itemTitleMap: Record<string, string | null> = {};
        const overrideMap: Record<string, string> = {};
        for (const s of wsRows) {
          for (const item of (s.warehouse_shipment_items ?? []) as ShipmentItem[]) {
            if (!item.sku || item.sku.trim() === "") continue;
            if (!allSkus.includes(item.sku)) allSkus.push(item.sku);
            if (!(item.sku in itemTitleMap)) {
              const parts = [item.product_title, item.variant_title].filter(
                (p): p is string => !!p && p.trim() !== "",
              );
              itemTitleMap[item.sku] = parts.length > 0 ? parts.join(" ") : null;
            }
            if (item.format_name_override && !(item.sku in overrideMap)) {
              overrideMap[item.sku] = item.format_name_override;
            }
          }
        }

        const { variantFormatMap, formatCostLookup } = await batchBuildFormatCostMaps(
          wsId,
          allSkus,
          supabase,
          itemTitleMap,
          overrideMap,
        );

        for (const s of wsRows) {
          const items = ((s.warehouse_shipment_items ?? []) as ShipmentItem[]).map((i) => ({
            sku: i.sku ?? null,
            quantity: Number(i.quantity) || 0,
          }));
          const costs = computeCostsFromMaps(
            s.shipping_cost ?? 0,
            items,
            variantFormatMap,
            formatCostLookup,
          );
          const enriched = byId.get(s.id);
          if (enriched) {
            enriched.fulfillment_total = costs.total;
            enriched.fulfillment_partial = costs.partial;
          }
        }
      }),
    );
  }

  const shipments = rows.map(
    (s) => byId.get(s.id) ?? { ...s, fulfillment_total: null, fulfillment_partial: false },
  );

  return {
    shipments,
    total: count ?? 0,
    page: parsed.page,
    pageSize: parsed.pageSize,
  };
}

export async function getShipmentsSummary(filters?: {
  orgId?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_shipments")
    .select("id, shipping_cost", { count: "exact" })
    .eq("voided", false);

  if (filters?.orgId) {
    query = query.eq("org_id", filters.orgId);
  }
  if (filters?.dateFrom) {
    query = query.gte("ship_date", filters.dateFrom);
  }
  if (filters?.dateTo) {
    query = query.lte("ship_date", filters.dateTo);
  }

  const { data, error, count } = await query;

  if (error) throw new Error(`Failed to fetch summary: ${error.message}`);

  const rows = data ?? [];
  const totalCount = count ?? 0;
  const totalPostage = rows.reduce((sum, r) => sum + (r.shipping_cost ?? 0), 0);
  const avgCost = totalCount > 0 ? totalPostage / totalCount : 0;

  return {
    totalCount,
    totalPostage,
    avgCost,
  };
}

export async function getShipmentDetail(id: string) {
  z.string().uuid().parse(id);
  await requireStaff();
  const supabase = await createServerSupabaseClient();

  const [shipmentResult, itemsResult, eventsResult] = await Promise.all([
    supabase
      .from("warehouse_shipments")
      .select(
        "*, organizations(name), warehouse_orders(id, order_number, shipping_address, shipping_cost, line_items, created_at)",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("warehouse_shipment_items")
      .select("*")
      .eq("shipment_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("warehouse_tracking_events")
      .select("*")
      .eq("shipment_id", id)
      .order("event_time", { ascending: true }),
  ]);

  if (shipmentResult.error) {
    throw new Error(`Shipment not found: ${shipmentResult.error.message}`);
  }

  let shipment = shipmentResult.data;
  const items = itemsResult.data ?? [];

  const orderJoin = shipment.warehouse_orders as {
    id: string | null;
    order_number: string | null;
    shipping_address: Record<string, unknown> | null;
    shipping_cost: number | string | null;
    line_items: unknown;
    created_at: string | null;
  } | null;

  let recipient = extractRecipient(shipment.label_data as Record<string, unknown> | null);
  const orderAddr = orderJoin?.shipping_address;
  if (orderAddr && typeof orderAddr === "object" && !Array.isArray(orderAddr)) {
    recipient = mergeRecipients(recipient, recipientFromOrderShippingAddress(orderAddr));
  }

  const rawOrderShipping = orderJoin?.shipping_cost;
  const fromColumn =
    rawOrderShipping != null && rawOrderShipping !== "" ? Number(rawOrderShipping) : Number.NaN;
  const fromLineItems = maxShippingFromOrderLineItems(orderJoin?.line_items);
  let resolvedOrderShipping: number | null = null;
  if (!Number.isNaN(fromColumn)) {
    resolvedOrderShipping = fromColumn;
  } else if (fromLineItems != null) {
    resolvedOrderShipping = fromLineItems;
  }

  if (shipment.customer_shipping_charged == null && resolvedOrderShipping != null) {
    shipment = { ...shipment, customer_shipping_charged: resolvedOrderShipping };
  }

  if (
    shipment.customer_shipping_charged == null &&
    shipment.bandcamp_payment_id != null &&
    shipment.workspace_id &&
    shipment.org_id
  ) {
    const anchorIso =
      shipment.ship_date != null
        ? `${String(shipment.ship_date)}T12:00:00.000Z`
        : (orderJoin?.created_at ?? null);
    try {
      const fetched = await fetchBandcampShippingPaidForPayment({
        workspaceId: shipment.workspace_id,
        orgId: shipment.org_id,
        paymentId: Number(shipment.bandcamp_payment_id),
        anchorDateIso: anchorIso,
      });
      if (fetched) {
        const admin = createServiceRoleClient();
        const orderId = shipment.order_id ?? orderJoin?.id;
        if (orderId) {
          await admin
            .from("warehouse_orders")
            .update({
              shipping_cost: fetched.shippingPaid,
              updated_at: new Date().toISOString(),
            })
            .eq("id", orderId);
        }
        await admin
          .from("warehouse_shipments")
          .update({ customer_shipping_charged: fetched.shippingPaid })
          .eq("id", shipment.id);
        shipment = { ...shipment, customer_shipping_charged: fetched.shippingPaid };
      }
    } catch {
      // Bandcamp unavailable or no rows — leave customer_shipping_charged null
    }
  }

  // Compute cost breakdown using shared helper (workspace-scoped, chunked .in() queries).
  // The helper also returns skuFormatMap so we can populate item.format_name without a second query.
  const workspaceId = shipment.workspace_id ?? "";
  const postage = shipment.shipping_cost ?? 0;
  const itemInputs = items.map((i) => ({
    sku: i.sku ?? null,
    quantity: i.quantity,
    product_title: (i as { product_title?: string | null }).product_title ?? null,
    variant_title: (i as { variant_title?: string | null }).variant_title ?? null,
    format_override:
      ((i as { format_name_override?: string | null }).format_name_override ?? null) || null,
  }));

  const [costBreakdown, formatCostsResult] = await Promise.all([
    computeFulfillmentCostBreakdown(workspaceId, postage, itemInputs, supabase),
    // Fetch available format names so the UI dropdown shows exactly what has cost rows,
    // preventing the "T-Shirt vs Shirt (S/M)" mismatch where the wrong format name
    // is selected and costs stay $0 due to missingFormatCosts.
    supabase
      .from("warehouse_format_costs")
      .select("format_name")
      .eq("workspace_id", workspaceId)
      .order("format_name"),
  ]);

  // Enrich items with per-item format name (using map from shared helper — no second DB query)
  const enrichedItems = items.map((item) => ({
    ...item,
    format_name: (costBreakdown.skuFormatMap[item.sku] ?? null) as string | null,
    pick_pack_cost: 0,
    material_cost: 0,
  }));

  const trackingUrl = getCarrierTrackingUrl(shipment.carrier, shipment.tracking_number);

  const availableFormats = (formatCostsResult.data ?? [])
    .map((r: { format_name: string }) => r.format_name)
    .filter(Boolean);

  return {
    shipment,
    recipient,
    trackingUrl,
    items: enrichedItems,
    trackingEvents: eventsResult.data ?? [],
    availableFormats,
    costBreakdown: {
      postage: costBreakdown.postage,
      materials: costBreakdown.materials,
      pickPack: costBreakdown.pickPack,
      dropShip: costBreakdown.dropShip,
      insurance: costBreakdown.insurance,
      total: costBreakdown.total,
      partial: costBreakdown.partial,
      unknownSkus: costBreakdown.unknownSkus,
      missingFormatCosts: costBreakdown.missingFormatCosts,
    },
  };
}

// === Label Creation (Phase 5B + Phase 3.1) ===

// Phase 3.1: extended union — "shipstation" sources rows from the
// shipstation_orders mirror table (Phase 1.1) instead of warehouse_orders.
export type OrderType = "fulfillment" | "mailorder" | "shipstation";

interface OrderForRates {
  /** Database row id (uuid for fulfillment/mailorder, uuid for shipstation_orders.id). */
  id: string;
  shipping_address: Record<string, unknown> | null;
  customer_name: string | null;
  /** Per-line item set used for media-mail eligibility + (in the task) customs. */
  line_items: Array<{ sku?: string | null }>;
  /** Optional default weight in oz from the order itself. Falls back to 16oz when unset. */
  weight_oz?: number | null;
}

/**
 * Phase 3.1 — fetch the minimum order shape needed to quote rates / buy a label,
 * regardless of source. The task in Phase 3.2 follows the same dispatch pattern.
 *
 * Exposed for unit testing.
 */
export async function fetchOrderForRates(
  supabase: ReturnType<typeof createServiceRoleClient>,
  orderId: string,
  orderType: OrderType,
): Promise<OrderForRates | null> {
  if (orderType === "shipstation") {
    const { data: order } = await supabase
      .from("shipstation_orders")
      .select("id, ship_to, customer_name, weight")
      .eq("id", orderId)
      .single();
    if (!order) return null;
    const { data: items } = await supabase
      .from("shipstation_order_items")
      .select("sku")
      .eq("shipstation_order_id", order.id);
    const weight = order.weight as { value?: number; units?: string } | null;
    return {
      id: order.id,
      shipping_address: order.ship_to as Record<string, unknown> | null,
      customer_name: order.customer_name ?? null,
      line_items: (items ?? []).map((i) => ({ sku: i.sku })),
      weight_oz: typeof weight?.value === "number" ? weight.value : null,
    };
  }

  const table = orderType === "fulfillment" ? "warehouse_orders" : "mailorder_orders";
  const { data: order } = await supabase
    .from(table)
    .select("id, shipping_address, customer_name, line_items")
    .eq("id", orderId)
    .single();
  if (!order) return null;
  return {
    id: order.id,
    shipping_address: order.shipping_address as Record<string, unknown> | null,
    customer_name: order.customer_name ?? null,
    line_items: (order.line_items ?? []) as Array<{ sku?: string }>,
  };
}

export interface RateOption {
  id: string;
  carrier: string;
  service: string;
  displayName: string;
  rate: number;
  deliveryDays: number | null;
  isMediaMail: boolean;
  recommended: boolean;
}

export interface LabelResult {
  success: boolean;
  trackingNumber?: string;
  labelUrl?: string;
  labelPdfUrl?: string | null;
  carrier?: string;
  service?: string;
  rate?: number;
  shipmentId?: string;
  error?: string;
  needsManualShipping?: boolean;
}

/**
 * Fetch shipping rate options from EasyPost without purchasing.
 * Staff calls this to show the rate selector before buying.
 */
export async function getShippingRates(
  orderId: string,
  orderType: OrderType,
): Promise<{ rates: RateOption[]; error?: string }> {
  await requireStaff();
  const supabase = createServiceRoleClient();

  // Phase 3.1 — source-agnostic fetch.
  const order = await fetchOrderForRates(supabase, orderId, orderType);
  if (!order) {
    return { rates: [], error: "Order not found" };
  }
  if (!order.shipping_address) {
    return { rates: [], error: "Order has no shipping address" };
  }

  // Determine media mail eligibility
  const skus = order.line_items
    .map((li) => li.sku)
    .filter((s): s is string => !!s && s !== "UNKNOWN");

  let mediaMailEligible = false;
  if (skus.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("sku, media_mail_eligible")
      .in("sku", skus);

    const variantMap = new Map((variants ?? []).map((v) => [v.sku, v.media_mail_eligible ?? true]));
    const found = skus.filter((s) => variantMap.has(s));
    mediaMailEligible = found.length > 0 && found.every((s) => variantMap.get(s) === true);
  }

  const toAddr = normalizeAddress(order.shipping_address);
  const toAddressParams = {
    name: toAddr.name || (order.customer_name ?? ""),
    street1: toAddr.street1,
    street2: toAddr.street2,
    city: toAddr.city,
    state: toAddr.state,
    zip: toAddr.zip,
    country: toAddr.country,
  };
  const isInternational = !isDomesticShipment(toAddr.country ?? "US");
  // Phase 3.1 — use the SS order's recorded weight when present, else 16oz.
  const previewWeight = order.weight_oz && order.weight_oz > 0 ? order.weight_oz : 16;

  const bestRateResult = await (async () => {
    try {
      const shipment = await createShipment({
        fromAddress: WAREHOUSE_ADDRESS,
        toAddress: toAddressParams,
        parcel: { weight: previewWeight }, // dimensions defaulted in createShipment
        mediaMailEligible,
      });
      return { shipment, error: null };
    } catch (err) {
      return { shipment: null, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  // For international shipments, fetch Asendia rates separately.
  // EasyPost does not include the USAExportPBA carrier in default rate shopping.
  // Asendia rates are significantly cheaper: ~$13-16 vs $30+ for UK via USPS.
  let asendiaRates: import("@/lib/clients/easypost-client").EasyPostRate[] = [];
  if (isInternational) {
    try {
      const asendiaShipment = await createShipment(
        {
          fromAddress: WAREHOUSE_ADDRESS,
          toAddress: toAddressParams,
          parcel: { weight: previewWeight },
        },
        [ASENDIA_CARRIER_ACCOUNT_ID],
      );
      asendiaRates = asendiaShipment.rates;
    } catch {
      // Asendia unavailable for this destination — not an error, just skip
    }
  }

  if (bestRateResult.error || !bestRateResult.shipment) {
    return { rates: [], error: bestRateResult.error ?? "Failed to get rates" };
  }

  // Deduplicate by carrier+service — adding dimensions to the main shipment now
  // causes EasyPost to return Asendia rates there too, so the explicit Asendia
  // request would double them. Keep cheapest price when same carrier+service appears.
  const rateMap = new Map<string, (typeof bestRateResult.shipment.rates)[number]>();
  for (const r of [...bestRateResult.shipment.rates, ...asendiaRates]) {
    const key = `${r.carrier}:${r.service}`;
    const existing = rateMap.get(key);
    if (!existing || parseFloat(r.rate) < parseFloat(existing.rate)) {
      rateMap.set(key, r);
    }
  }
  const allRates = Array.from(rateMap.values());

  console.log(
    "[shipping] Raw EasyPost rates:",
    allRates.map((r) => `${r.carrier}:${r.service}=$${r.rate}`).join(", "),
  );

  const recommended = selectBestRate(allRates, mediaMailEligible);

  const rates: RateOption[] = allRates.map((r) => {
    const serviceId = normalizeService(r.carrier, r.service);
    const details = getServiceDetails(serviceId);
    return {
      id: r.id,
      carrier: r.carrier,
      service: r.service,
      displayName: details?.displayName ?? `${r.carrier} ${r.service}`,
      rate: parseFloat(r.rate),
      deliveryDays: r.delivery_days ?? null,
      isMediaMail: details?.isMediaMail ?? false,
      recommended: r.id === recommended?.id,
    };
  });

  // Sort: recommended first, then by price
  rates.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return a.rate - b.rate;
  });

  return { rates };
}

/**
 * Create a shipping label for an order, storing all records and triggering
 * downstream tasks (AfterShip, platform fulfillment marking).
 *
 * Uses requireStaff() for auth.
 */
export async function createOrderLabel(
  orderId: string,
  params: {
    orderType: OrderType;
    /** Legacy. Use `selectedRate` instead. Kept for callers not yet upgraded. */
    selectedRateId?: string;
    /**
     * Phase 0.2 — stable key carried from the preview rate the staff clicked.
     * Survives EP rate-ID churn between Shipment.create calls.
     */
    selectedRate?: {
      carrier: string;
      service: string;
      rate: number;
      deliveryDays?: number | null;
    };
    weight?: number;
  },
): Promise<LabelResult> {
  await requireStaff();

  if (!params.selectedRateId && !params.selectedRate) {
    return { success: false, error: "Must provide selectedRateId or selectedRate" };
  }

  try {
    const run = await tasks.trigger("create-shipping-label", {
      orderId,
      orderType: params.orderType,
      selectedRateId: params.selectedRateId,
      selectedRate: params.selectedRate,
      weight: params.weight ?? 16,
    });
    return { success: true, shipmentId: run.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to trigger label task: ${msg}` };
  }
}

/**
 * Poll task run status to get label creation result.
 * Returns the label info once the task completes.
 */
export async function getLabelTaskStatus(runId: string): Promise<{
  status: "pending" | "running" | "completed" | "failed";
  result?: LabelResult;
}> {
  await requireStaff();

  try {
    const run = await runs.retrieve(runId);
    const triggerStatus = run.status as string;

    if (triggerStatus === "COMPLETED" || triggerStatus === "SUCCEEDED") {
      return { status: "completed", result: run.output as LabelResult };
    }
    if (triggerStatus === "FAILED" || triggerStatus === "CANCELED") {
      return { status: "failed", result: { success: false, error: "Task failed" } };
    }
    if (triggerStatus === "EXECUTING") {
      return { status: "running" };
    }
    return { status: "pending" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "failed", result: { success: false, error: msg } };
  }
}

// === CSV Export ===

const exportSchema = z.object({
  orgId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export async function exportShipmentsCsv(filters?: {
  orgId?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<string> {
  const parsed = exportSchema.parse(filters ?? {});
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_shipments")
    .select(
      "id, workspace_id, tracking_number, carrier, service, ship_date, shipping_cost, label_data, warehouse_orders(order_number), warehouse_shipment_items(sku, quantity, product_title, variant_title, format_name_override)",
    )
    .order("ship_date", { ascending: false })
    .limit(10000);

  if (parsed.orgId) {
    query = query.eq("org_id", parsed.orgId);
  }
  if (parsed.dateFrom) {
    query = query.gte("ship_date", parsed.dateFrom);
  }
  if (parsed.dateTo) {
    query = query.lte("ship_date", parsed.dateTo);
  }

  const { data: shipments, error } = await query;
  if (error) throw new Error(`Export failed: ${error.message}`);

  const allRows = shipments ?? [];

  // Build per-workspace format cost maps using shared helper (workspace-scoped + chunked)
  type CsvItem = {
    sku?: string | null;
    quantity?: number | null;
    product_title?: string | null;
    variant_title?: string | null;
    format_name_override?: string | null;
  };
  const workspaceIds = Array.from(
    new Set(allRows.map((s) => s.workspace_id).filter((id): id is string => !!id)),
  );

  // workspaceId -> { variantFormatMap, formatCostLookup }
  const wsMaps = new Map<
    string,
    {
      variantFormatMap: Record<string, string | null>;
      formatCostLookup: Record<string, { pick_pack_cost: number; material_cost: number }>;
    }
  >();

  await Promise.all(
    workspaceIds.map(async (wsId) => {
      const wsRows = allRows.filter((s) => s.workspace_id === wsId);
      const skus: string[] = [];
      const itemTitleMap: Record<string, string | null> = {};
      const overrideMap: Record<string, string> = {};
      for (const s of wsRows) {
        for (const item of (s.warehouse_shipment_items ?? []) as CsvItem[]) {
          if (!item.sku || item.sku.trim() === "") continue;
          if (!skus.includes(item.sku)) skus.push(item.sku);
          if (!(item.sku in itemTitleMap)) {
            const parts = [item.product_title, item.variant_title].filter(
              (p): p is string => !!p && p.trim() !== "",
            );
            itemTitleMap[item.sku] = parts.length > 0 ? parts.join(" ") : null;
          }
          if (item.format_name_override && !(item.sku in overrideMap)) {
            overrideMap[item.sku] = item.format_name_override;
          }
        }
      }
      const maps = await batchBuildFormatCostMaps(wsId, skus, supabase, itemTitleMap, overrideMap);
      wsMaps.set(wsId, maps);
    }),
  );

  // Build CSV
  const headers = [
    "order_number",
    "ship_date",
    "carrier",
    "service",
    "tracking_number",
    "recipient",
    "city",
    "state",
    "zip",
    "country",
    "items",
    "postage",
    "materials",
    "pick_pack",
    "fulfillment_total",
  ];

  const rows = allRows.map((s) => {
    const recipient = extractRecipient(s.label_data as Record<string, unknown> | null);
    const items = ((s.warehouse_shipment_items ?? []) as CsvItem[]).map((i) => ({
      sku: i.sku ?? null,
      quantity: Number(i.quantity) || 0,
    }));
    const itemStr = items.map((i) => `${i.sku ?? "?"}x${i.quantity}`).join("; ");

    const wsId = (s as typeof s & { workspace_id?: string | null }).workspace_id ?? "";
    const maps = wsMaps.get(wsId) ?? { variantFormatMap: {}, formatCostLookup: {} };
    const costs = computeCostsFromMaps(
      s.shipping_cost ?? 0,
      items,
      maps.variantFormatMap,
      maps.formatCostLookup,
    );

    const orderNumber =
      (s.warehouse_orders as unknown as { order_number: string | null } | null)?.order_number ?? "";

    return [
      orderNumber,
      s.ship_date ?? "",
      s.carrier ?? "",
      s.service ?? "",
      s.tracking_number ?? "",
      recipient?.name ?? "",
      recipient?.city ?? "",
      recipient?.state ?? "",
      recipient?.postalCode ?? "",
      recipient?.country ?? "",
      itemStr,
      (s.shipping_cost ?? 0).toFixed(2),
      costs.materials.toFixed(2),
      costs.pickPack.toFixed(2),
      costs.total.toFixed(2),
    ];
  });

  const csvEscape = (val: string) => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const csvLines = [headers.join(","), ...rows.map((row) => row.map(csvEscape).join(","))];

  return csvLines.join("\n");
}

// === Format Override ===

const setFormatOverrideSchema = z.object({
  itemId: z.string().uuid(),
  formatName: z.string().min(1).max(64).nullable(),
});

/**
 * Set (or clear) a staff-assigned format override on a single warehouse_shipment_items row.
 * The override is the highest-priority format source in the cost engine — it bypasses all
 * automatic resolution (variant format_name → product_type → title keywords → fuzzy match).
 * Pass null to clear the override and revert to automatic resolution.
 */
export async function setShipmentItemFormatOverride(input: {
  itemId: string;
  formatName: string | null;
}): Promise<void> {
  await requireStaff();
  const { itemId, formatName } = setFormatOverrideSchema.parse(input);
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase
    .from("warehouse_shipment_items")
    .update({ format_name_override: formatName })
    .eq("id", itemId);

  if (error) throw new Error(`Failed to set format override: ${error.message}`);
}
