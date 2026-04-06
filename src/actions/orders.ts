"use server";

import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

export async function getOrders(filters: {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  orgId?: string;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("warehouse_orders")
    .select("*, organizations(name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filters.status) query = query.eq("fulfillment_status", filters.status);
  if (filters.search) query = query.ilike("order_number", `%${filters.search}%`);
  if (filters.orgId) query = query.eq("org_id", filters.orgId);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.dateFrom) query = query.gte("created_at", filters.dateFrom);
  if (filters.dateTo) query = query.lte("created_at", filters.dateTo);

  const { data, count } = await query;
  return { orders: data ?? [], total: count ?? 0, page, pageSize };
}

export async function getOrderDetail(orderId: string) {
  const supabase = await createServerSupabaseClient();

  const { data: order } = await supabase
    .from("warehouse_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  const { data: items } = await supabase
    .from("warehouse_order_items")
    .select("*")
    .eq("order_id", orderId);

  const { data: shipments } = await supabase
    .from("warehouse_shipments")
    .select("id, tracking_number, carrier, status, ship_date")
    .eq("order_id", orderId);

  // Parse line_items JSONB from the order row as a fallback when warehouse_order_items
  // has no rows (e.g. Bandcamp orders which store line items inline as JSONB).
  const lineItemsJson =
    (order?.line_items as Array<{
      sku?: string;
      title?: string;
      quantity?: number;
      price?: number;
    }> | null) ?? [];

  // Merge: prefer normalised warehouse_order_items rows; fall back to JSONB
  const resolvedItems =
    (items ?? []).length > 0
      ? (items ?? [])
      : lineItemsJson.map((li, i) => ({
          id: `jsonb-${i}`,
          order_id: orderId,
          sku: li.sku ?? null,
          title: li.title ?? null,
          quantity: li.quantity ?? 1,
          price: li.price ?? null,
        }));

  return {
    order,
    items: resolvedItems,
    shipments: shipments ?? [],
  };
}

export async function getTrackingEvents(shipmentId: string) {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("warehouse_tracking_events")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("event_time", { ascending: false });
  return data ?? [];
}

export async function getClientShipments(filters: {
  page?: number;
  pageSize?: number;
  status?: string;
  carrier?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const serviceClient = createServiceRoleClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  // Resolve org_id from the authenticated user — explicit org scoping is
  // defense-in-depth on top of RLS; never return cross-org shipments.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { shipments: [], total: 0, page, pageSize };

  const { data: userRecord } = await serviceClient
    .from("users")
    .select("org_id")
    .eq("auth_user_id", user.id)
    .single();

  if (!userRecord?.org_id) return { shipments: [], total: 0, page, pageSize };

  let query = supabase
    .from("warehouse_shipments")
    .select("*, warehouse_orders(order_number)", { count: "exact" })
    .eq("org_id", userRecord.org_id)
    .order("ship_date", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.carrier) query = query.ilike("carrier", `%${filters.carrier}%`);

  const { data, count } = await query;
  return { shipments: data ?? [], total: count ?? 0, page, pageSize };
}

export async function getShipmentItems(shipmentId: string) {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("warehouse_shipment_items")
    .select("*")
    .eq("shipment_id", shipmentId);
  return data ?? [];
}
