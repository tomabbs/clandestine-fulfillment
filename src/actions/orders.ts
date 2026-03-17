"use server";

import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export async function getOrders(filters: {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("warehouse_orders")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filters.status) query = query.eq("fulfillment_status", filters.status);
  if (filters.search) query = query.ilike("order_number", `%${filters.search}%`);

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

  return { order, items: items ?? [], shipments: shipments ?? [] };
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
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("warehouse_shipments")
    .select("*", { count: "exact" })
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
