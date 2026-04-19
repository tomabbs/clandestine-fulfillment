// Phase 3.4 — Shared packing-slip data shape.
//
// One source of truth for what the packing slip needs from the database. The
// per-order route in Phase 3.4 reads via fetchPackingSlipData(); Phase 9 bulk
// print will reuse the same shape over an array of order ids.
//
// Phase 11.1 will extend this with Bandcamp enrichment fields (artist, album
// thumbnail, buyer_note, ship_notes, additional_fan_contribution) by joining
// shipstation_orders.shipstation_order_id → bandcamp matching.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PackingSlipAddress {
  name: string | null;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface PackingSlipLineItem {
  sku: string | null;
  name: string | null;
  quantity: number;
  unit_price: number | null;
  /** Per-line customs override (Phase 0.5.4 column on warehouse_shipment_items).
   *  Available on shipments that already exist; not on orders pre-purchase. */
  customs_description?: string | null;
}

export interface PackingSlipData {
  /** shipstation_orders.id (uuid). */
  shipstation_order_id_internal: string;
  /** ShipStation's bigint orderId (for SS deep links). */
  shipstation_order_id: number;
  order_number: string;
  order_date: string | null;
  customer_name: string | null;
  customer_email: string | null;
  ship_to: PackingSlipAddress;
  org_name: string | null;
  org_id: string | null;
  items: PackingSlipLineItem[];
  /** Storefront context — Phase 11.1 will fill these from BC enrichment. */
  buyer_note?: string | null;
  ship_notes?: string | null;
  artist?: string | null;
  additional_fan_contribution?: number | null;
}

function pickAddress(raw: Record<string, unknown> | null): PackingSlipAddress {
  if (!raw) {
    return {
      name: null,
      company: null,
      street1: null,
      street2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    };
  }
  const s = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    name: s("name"),
    company: s("company"),
    street1: s("street1"),
    street2: s("street2"),
    city: s("city"),
    state: s("state"),
    postalCode: s("postalCode"),
    country: s("country"),
  };
}

/**
 * Phase 3.4 — load the packing slip payload for ONE shipstation_orders row.
 *
 * Exposed on the supabase client (service-role context) so the route handler
 * stays a thin wrapper. Phase 9 bulk print will call a sibling helper that
 * batches the same query over an array of ids.
 */
export async function fetchPackingSlipData(
  supabase: SupabaseClient,
  shipstationOrderUuid: string,
): Promise<PackingSlipData | null> {
  const { data: order, error } = await supabase
    .from("shipstation_orders")
    .select(
      `id, shipstation_order_id, order_number, order_date, customer_name,
       customer_email, ship_to, org_id,
       organizations ( name )`,
    )
    .eq("id", shipstationOrderUuid)
    .maybeSingle();
  if (error || !order) return null;

  const { data: items } = await supabase
    .from("shipstation_order_items")
    .select("sku, name, quantity, unit_price, item_index")
    .eq("shipstation_order_id", order.id)
    .order("item_index", { ascending: true });

  const org = order.organizations as unknown as { name?: string } | null;
  return {
    shipstation_order_id_internal: order.id,
    shipstation_order_id: order.shipstation_order_id as unknown as number,
    order_number: order.order_number,
    order_date: order.order_date,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    ship_to: pickAddress(order.ship_to as Record<string, unknown> | null),
    org_name: org?.name ?? null,
    org_id: order.org_id,
    items: (items ?? []).map((it) => ({
      sku: it.sku,
      name: it.name,
      quantity: it.quantity,
      unit_price: it.unit_price,
    })),
  };
}
