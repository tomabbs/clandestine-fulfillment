"use server";

import { z } from "zod/v4";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

const filtersSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(250).default(50),
  search: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  orgId: z.string().optional(),
  payoutStatus: z.string().optional(),
});

export type MailOrderFilters = z.infer<typeof filtersSchema>;

/** Admin: list all mail orders with client name and order detail */
export async function getMailOrders(rawFilters?: Partial<MailOrderFilters>) {
  const filters = filtersSchema.parse(rawFilters ?? {});
  const supabase = await createServerSupabaseClient();

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("mailorder_orders")
    .select(
      "id, source, external_order_id, order_number, customer_name, customer_email, fulfillment_status, platform_fulfillment_status, financial_status, subtotal, shipping_amount, total_price, currency, client_payout_amount, client_payout_status, line_items, shipping_address, created_at, synced_at, organizations(name)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.search) query = query.ilike("order_number", `%${filters.search}%`);
  if (filters.status) query = query.eq("fulfillment_status", filters.status);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.orgId) query = query.eq("org_id", filters.orgId);
  if (filters.payoutStatus) query = query.eq("client_payout_status", filters.payoutStatus);

  const { data, count, error } = await query;
  if (error) throw new Error(`Failed to fetch mail orders: ${error.message}`);

  return {
    orders: data ?? [],
    total: count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/** Portal: list mail orders for the current client's org */
export async function getClientMailOrders(rawFilters?: Partial<MailOrderFilters>) {
  const filters = filtersSchema.parse(rawFilters ?? {});
  const supabase = await createServerSupabaseClient();

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from("mailorder_orders")
    .select(
      "id, source, external_order_id, order_number, customer_name, customer_email, fulfillment_status, platform_fulfillment_status, subtotal, shipping_amount, total_price, currency, client_payout_amount, client_payout_status, line_items, shipping_address, created_at, synced_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.status) query = query.eq("fulfillment_status", filters.status);
  if (filters.payoutStatus) query = query.eq("client_payout_status", filters.payoutStatus);

  const { data, count, error } = await query;
  if (error) throw new Error(`Failed to fetch mail orders: ${error.message}`);

  return {
    orders: data ?? [],
    total: count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/** Admin: get payout summary for the current month */
export async function getMailOrderPayoutSummary(orgId?: string) {
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("mailorder_orders")
    .select("client_payout_amount, client_payout_status");

  if (orgId) query = query.eq("org_id", orgId);

  const { data } = await query;
  const orders = data ?? [];

  const pending = orders.filter((o) => o.client_payout_status === "pending");
  const included = orders.filter((o) => o.client_payout_status === "included_in_snapshot");

  return {
    totalPendingPayout: pending.reduce((s, o) => s + (o.client_payout_amount ?? 0), 0),
    totalIncludedPayout: included.reduce((s, o) => s + (o.client_payout_amount ?? 0), 0),
    pendingOrderCount: pending.length,
  };
}
