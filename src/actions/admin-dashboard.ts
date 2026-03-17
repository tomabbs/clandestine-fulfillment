"use server";

import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export async function getDashboardStats() {
  const supabase = await createServerSupabaseClient();
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const [products, monthOrders, monthShipments, criticalReview, pendingInbound] = await Promise.all(
    [
      supabase.from("warehouse_products").select("id", { count: "exact", head: true }),
      supabase
        .from("warehouse_orders")
        .select("id", { count: "exact", head: true })
        .gte("created_at", monthStart),
      supabase
        .from("warehouse_shipments")
        .select("id", { count: "exact", head: true })
        .gte("created_at", monthStart),
      supabase
        .from("warehouse_review_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "open")
        .eq("severity", "critical"),
      supabase
        .from("warehouse_inbound_shipments")
        .select("id", { count: "exact", head: true })
        .in("status", ["expected", "arrived"]),
    ],
  );

  // Recent activity: inventory changes + sync logs combined
  const [activityResult, syncLogResult] = await Promise.all([
    supabase
      .from("warehouse_inventory_activity")
      .select("id, sku, delta, source, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("channel_sync_log")
      .select("id, channel, sync_type, status, items_processed, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const recentActivity = [
    ...(activityResult.data ?? []).map((a) => ({
      id: a.id,
      type: "inventory" as const,
      message: `${a.source}: ${a.sku} ${a.delta > 0 ? `+${a.delta}` : a.delta}`,
      created_at: a.created_at,
    })),
    ...(syncLogResult.data ?? []).map((s) => ({
      id: s.id,
      type: "sync" as const,
      message: `${s.channel} ${s.sync_type ?? ""}: ${s.status} (${s.items_processed} items)`,
      created_at: s.created_at,
    })),
  ]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20);

  // Sensor health
  const { data: sensorReadings } = await supabase
    .from("sensor_readings")
    .select("sensor_name, status, message, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const latestSensors = new Map<string, { status: string; message: string }>();
  for (const r of sensorReadings ?? []) {
    if (!latestSensors.has(r.sensor_name)) {
      latestSensors.set(r.sensor_name, { status: r.status, message: r.message ?? "" });
    }
  }

  return {
    stats: {
      totalProducts: products.count ?? 0,
      monthOrders: monthOrders.count ?? 0,
      monthShipments: monthShipments.count ?? 0,
      criticalReviewItems: criticalReview.count ?? 0,
      pendingInbound: pendingInbound.count ?? 0,
    },
    recentActivity,
    sensorHealth: Object.fromEntries(latestSensors),
  };
}
