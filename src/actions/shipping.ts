"use server";

// Rule #4: Server Actions for mutations, React Query for reads
// Rule #5: Zod for all boundaries

import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

const getShipmentsSchema = z.object({
  orgId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  status: z.string().optional(),
  carrier: z.string().optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

export type GetShipmentsFilters = z.infer<typeof getShipmentsSchema>;

export async function getShipments(filters: GetShipmentsFilters) {
  const parsed = getShipmentsSchema.parse(filters);
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_shipments")
    .select("*, organizations!inner(name)", { count: "exact" });

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

export async function getShipmentDetail(id: string) {
  z.string().uuid().parse(id);
  const supabase = await createServerSupabaseClient();

  const [shipmentResult, itemsResult, eventsResult] = await Promise.all([
    supabase.from("warehouse_shipments").select("*, organizations(name)").eq("id", id).single(),
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

  return {
    shipment: shipmentResult.data,
    items: itemsResult.data ?? [],
    trackingEvents: eventsResult.data ?? [],
  };
}
