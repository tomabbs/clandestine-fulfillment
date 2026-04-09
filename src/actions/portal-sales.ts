"use server";

import { requireClient } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export async function getSalesData() {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const { data: orders, count } = await supabase
    .from("warehouse_orders")
    .select("id, order_number, source, total_price, created_at, line_items", { count: "exact" })
    .eq("org_id", orgId)
    .gte("created_at", monthStart)
    .order("created_at", { ascending: false })
    .limit(50);

  const orderIds = (orders ?? []).map((o) => o.id);
  const { data: items } =
    orderIds.length > 0
      ? await supabase
          .from("warehouse_order_items")
          .select("sku, quantity")
          .in("order_id", orderIds)
      : { data: [] as { sku: string; quantity: number }[] };

  const skuCounts = new Map<string, number>();
  let totalUnits = 0;
  for (const item of items ?? []) {
    skuCounts.set(item.sku, (skuCounts.get(item.sku) ?? 0) + item.quantity);
    totalUnits += item.quantity;
  }

  const topSkus = Array.from(skuCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sku, qty]) => ({ sku, quantity: qty }));

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const { data: dailyOrders } = await supabase
    .from("warehouse_orders")
    .select("created_at")
    .eq("org_id", orgId)
    .gte("created_at", thirtyDaysAgo);

  const dailyCounts = new Map<string, number>();
  for (const o of dailyOrders ?? []) {
    const day = o.created_at.split("T")[0];
    dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
  }

  const chartData: Array<{ date: string; count: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().split("T")[0];
    chartData.push({ date: key, count: dailyCounts.get(key) ?? 0 });
  }

  return { totalOrders: count ?? 0, totalUnits, topSkus, orders: orders ?? [], chartData };
}
