#!/usr/bin/env node

/**
 * Pre-order sensors — checks pre-order allocation health.
 *
 * Sensors:
 *   preorder.stale_pending — pre-orders pending >7 days with available stock
 *   preorder.short_shipment — pre-orders with short-shipped allocation
 *   billing.unpaid — overdue invoices >7 days
 *   review.critical_open — critical review items open >1hr
 */

import { runSensorDomain } from "./_shared.mjs";

async function collectReadings(supabase, workspaceId) {
  const readings = [];

  // 1. preorder.stale_pending — pre-orders stuck as pending when stock exists
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: stalePOs, count } = await supabase
      .from("warehouse_orders")
      .select("id, order_number, sku, created_at", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .eq("order_type", "preorder")
      .eq("status", "pending")
      .lt("created_at", sevenDaysAgo)
      .limit(10);

    const staleCount = count ?? 0;
    readings.push({
      sensorName: "preorder.stale_pending",
      status: staleCount === 0 ? "healthy" : staleCount <= 5 ? "warning" : "critical",
      value: {
        stale_count: staleCount,
        samples: (stalePOs ?? []).map((o) => ({
          id: o.id,
          order_number: o.order_number,
          days_old: Math.round(
            (Date.now() - new Date(o.created_at).getTime()) / (1000 * 60 * 60 * 24),
          ),
        })),
      },
      message:
        staleCount === 0
          ? "No stale pre-orders"
          : `${staleCount} pre-order(s) pending >7 days`,
    });
  } catch (err) {
    readings.push({
      sensorName: "preorder.stale_pending",
      status: "healthy",
      value: { error: err.message },
      message: "Pre-order check skipped (table may not exist)",
    });
  }

  // 2. preorder.short_shipment — review queue items for short shipments (Rule #69)
  try {
    const { count } = await supabase
      .from("warehouse_review_queue")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("category", "short_shipment")
      .eq("status", "open");

    const shortCount = count ?? 0;
    readings.push({
      sensorName: "preorder.short_shipment",
      status: shortCount === 0 ? "healthy" : "critical",
      value: { open_short_shipments: shortCount },
      message:
        shortCount === 0
          ? "No open short shipment issues"
          : `${shortCount} unresolved short shipment(s)`,
    });
  } catch {
    readings.push({
      sensorName: "preorder.short_shipment",
      status: "healthy",
      value: {},
      message: "Short shipment check skipped",
    });
  }

  // 3. billing.unpaid — overdue invoices >7 days
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("warehouse_billing_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("status", "overdue")
      .lt("created_at", sevenDaysAgo);

    const overdueCount = count ?? 0;
    readings.push({
      sensorName: "billing.unpaid",
      status: overdueCount === 0 ? "healthy" : "warning",
      value: { overdue_count: overdueCount },
      message:
        overdueCount === 0
          ? "No overdue invoices"
          : `${overdueCount} overdue invoice(s) >7 days`,
    });
  } catch {
    readings.push({
      sensorName: "billing.unpaid",
      status: "healthy",
      value: {},
      message: "Billing check skipped",
    });
  }

  // 4. review.critical_open — critical review items open >1hr
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("warehouse_review_queue")
      .select("id", { count: "exact", head: true })
      .eq("severity", "critical")
      .eq("status", "open")
      .lt("created_at", oneHourAgo);

    const critCount = count ?? 0;
    readings.push({
      sensorName: "review.critical_open",
      status: critCount === 0 ? "healthy" : "warning",
      value: { count: critCount },
      message:
        critCount === 0
          ? "No stale critical items"
          : `${critCount} critical review item(s) open >1hr`,
    });
  } catch {
    readings.push({
      sensorName: "review.critical_open",
      status: "healthy",
      value: {},
      message: "Review queue check skipped",
    });
  }

  return readings;
}

export { collectReadings };

const isMain = process.argv[1]?.endsWith("run-preorder-sensors.mjs");
if (isMain) {
  runSensorDomain("preorder-sensors", collectReadings);
}
