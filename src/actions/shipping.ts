"use server";

// Rule #4: Server Actions for mutations, React Query for reads
// Rule #5: Zod for all boundaries

import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// === Schemas ===

const getShipmentsSchema = z.object({
  search: z.string().optional(),
  orgId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  status: z.string().optional(),
  carrier: z.string().optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
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

function extractRecipient(labelData: Record<string, unknown> | null): LabelDataAddress | null {
  if (!labelData) return null;
  const shipTo = labelData.shipTo as LabelDataAddress | undefined;
  return shipTo ?? null;
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
      "id, org_id, shipstation_shipment_id, order_id, tracking_number, carrier, service, ship_date, delivery_date, status, shipping_cost, weight, label_data, voided, billed, created_at, bandcamp_payment_id, bandcamp_synced_at, organizations!inner(name), warehouse_orders(order_number), warehouse_shipment_items(id)",
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

  const from = (parsed.page - 1) * parsed.pageSize;
  const to = from + parsed.pageSize - 1;

  const { data, error, count } = await query
    .order("ship_date", { ascending: false })
    .range(from, to);

  if (error) throw new Error(`Failed to fetch shipments: ${error.message}`);

  return {
    shipments: data ?? [],
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

  let query = supabase.from("warehouse_shipments").select("id, shipping_cost", { count: "exact" });

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
  const supabase = await createServerSupabaseClient();

  const [shipmentResult, itemsResult, eventsResult] = await Promise.all([
    supabase
      .from("warehouse_shipments")
      .select("*, organizations(name), warehouse_orders(order_number)")
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

  const shipment = shipmentResult.data;
  const items = itemsResult.data ?? [];

  // Compute cost breakdown by looking up format costs for each item's SKU
  const skus = Array.from(new Set(items.map((i) => i.sku)));
  const formatCostMap: Record<string, { pick_pack_cost: number; material_cost: number }> = {};

  if (skus.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("sku, format_name")
      .in("sku", skus);

    const formatNames = [
      ...Array.from(new Set((variants ?? []).map((v) => v.format_name).filter(Boolean))),
    ] as string[];

    if (formatNames.length > 0) {
      const { data: formatCosts } = await supabase
        .from("warehouse_format_costs")
        .select("format_name, pick_pack_cost, material_cost")
        .in("format_name", formatNames);

      const formatLookup: Record<string, { pick_pack_cost: number; material_cost: number }> = {};
      for (const fc of formatCosts ?? []) {
        formatLookup[fc.format_name] = {
          pick_pack_cost: fc.pick_pack_cost,
          material_cost: fc.material_cost,
        };
      }

      const variantFormatMap: Record<string, string | null> = {};
      for (const v of variants ?? []) {
        variantFormatMap[v.sku] = v.format_name;
      }

      for (const sku of skus) {
        const fn = variantFormatMap[sku];
        if (fn && formatLookup[fn]) {
          formatCostMap[sku] = formatLookup[fn];
        }
      }
    }
  }

  // Build enriched items with format info
  const enrichedItems = items.map((item) => ({
    ...item,
    format_name: null as string | null,
    pick_pack_cost: 0,
    material_cost: 0,
  }));

  // Populate format data from the lookup
  for (const item of enrichedItems) {
    const costs = formatCostMap[item.sku];
    if (costs) {
      item.pick_pack_cost = costs.pick_pack_cost * item.quantity;
      item.material_cost = costs.material_cost * item.quantity;
    }
  }

  // Set format_name from variants
  if (skus.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("sku, format_name")
      .in("sku", skus);
    const variantMap: Record<string, string | null> = {};
    for (const v of variants ?? []) {
      variantMap[v.sku] = v.format_name;
    }
    for (const item of enrichedItems) {
      item.format_name = variantMap[item.sku] ?? null;
    }
  }

  const totalPickPack = enrichedItems.reduce((sum, i) => sum + i.pick_pack_cost, 0);
  const totalMaterials = enrichedItems.reduce((sum, i) => sum + i.material_cost, 0);
  const postage = shipment.shipping_cost ?? 0;
  const totalCost = postage + totalPickPack + totalMaterials;

  const recipient = extractRecipient(shipment.label_data as Record<string, unknown> | null);
  const trackingUrl = getCarrierTrackingUrl(shipment.carrier, shipment.tracking_number);

  return {
    shipment,
    recipient,
    trackingUrl,
    items: enrichedItems,
    trackingEvents: eventsResult.data ?? [],
    costBreakdown: {
      postage,
      materials: totalMaterials,
      pickPack: totalPickPack,
      dropShip: 0,
      insurance: 0,
      total: totalCost,
    },
  };
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
      "id, tracking_number, carrier, service, ship_date, shipping_cost, label_data, warehouse_orders(order_number), warehouse_shipment_items(sku, quantity)",
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

  // Collect all SKUs for format cost lookup
  const allSkus = new Set<string>();
  for (const s of shipments ?? []) {
    for (const item of (s.warehouse_shipment_items as Array<{ sku: string }>) ?? []) {
      allSkus.add(item.sku);
    }
  }

  // Batch lookup format costs
  const formatCostMap: Record<string, { pick_pack_cost: number; material_cost: number }> = {};
  const skuArr = Array.from(allSkus);
  if (skuArr.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("sku, format_name")
      .in("sku", skuArr);

    const formatNames = [
      ...Array.from(new Set((variants ?? []).map((v) => v.format_name).filter(Boolean))),
    ] as string[];

    if (formatNames.length > 0) {
      const { data: formatCosts } = await supabase
        .from("warehouse_format_costs")
        .select("format_name, pick_pack_cost, material_cost")
        .in("format_name", formatNames);

      const formatLookup: Record<string, { pick_pack_cost: number; material_cost: number }> = {};
      for (const fc of formatCosts ?? []) {
        formatLookup[fc.format_name] = {
          pick_pack_cost: fc.pick_pack_cost,
          material_cost: fc.material_cost,
        };
      }

      for (const v of variants ?? []) {
        if (v.format_name && formatLookup[v.format_name]) {
          formatCostMap[v.sku] = formatLookup[v.format_name];
        }
      }
    }
  }

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
    "total",
  ];

  const rows = (shipments ?? []).map((s) => {
    const recipient = extractRecipient(s.label_data as Record<string, unknown> | null);
    const items = (s.warehouse_shipment_items ?? []) as Array<{
      sku: string;
      quantity: number;
    }>;
    const itemStr = items.map((i) => `${i.sku}x${i.quantity}`).join("; ");

    let materials = 0;
    let pickPack = 0;
    for (const item of items) {
      const costs = formatCostMap[item.sku];
      if (costs) {
        materials += costs.material_cost * item.quantity;
        pickPack += costs.pick_pack_cost * item.quantity;
      }
    }

    const postage = s.shipping_cost ?? 0;
    const total = postage + materials + pickPack;
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
      postage.toFixed(2),
      materials.toFixed(2),
      pickPack.toFixed(2),
      total.toFixed(2),
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
