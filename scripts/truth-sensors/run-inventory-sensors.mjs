#!/usr/bin/env node

/**
 * Inventory sensors — checks inventory integrity and drift.
 *
 * Sensors:
 *   inv.redis_postgres_drift — Redis vs Postgres mismatch count
 *   inv.echo_detection — >3 decrements in 5min without orders = CRITICAL (Rule #65)
 *   inv.propagation_lag — per store connection freshness (Rule #71)
 *   inv.negative_available — SKUs with negative available quantity
 */

import { Redis } from "@upstash/redis";
import { runSensorDomain } from "./_shared.mjs";

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  }
  return new Redis({ url, token });
}

async function collectReadings(supabase, workspaceId) {
  const readings = [];

  // 1. inv.redis_postgres_drift
  try {
    const redis = getRedis();
    const { data: sample } = await supabase
      .from("warehouse_inventory_levels")
      .select("sku, available")
      .eq("workspace_id", workspaceId)
      .limit(100);

    let mismatches = 0;
    for (const row of sample ?? []) {
      const data = await redis.hgetall(`inv:${row.sku}`);
      const redisAvailable = Number(data?.available ?? 0);
      if (redisAvailable !== row.available) mismatches++;
    }

    const sampleSize = sample?.length ?? 0;
    let status = "healthy";
    if (mismatches > 5) status = "critical";
    else if (mismatches > 0) status = "warning";

    readings.push({
      sensorName: "inv.redis_postgres_drift",
      status,
      value: { sample_size: sampleSize, mismatches },
      message:
        mismatches === 0
          ? "No drift detected"
          : `${mismatches} mismatches in ${sampleSize} sampled SKUs`,
    });
  } catch (err) {
    readings.push({
      sensorName: "inv.redis_postgres_drift",
      status: "warning",
      value: { error: err.message },
      message: "Drift check failed",
    });
  }

  // 2. inv.echo_detection (Rule #65)
  // >3 decrements in 5min without corresponding orders = likely echo loop
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Count recent negative deltas (decrements) from webhook sources
    const { data: recentDecrements } = await supabase
      .from("warehouse_inventory_activity")
      .select("sku, delta, source, correlation_id")
      .eq("workspace_id", workspaceId)
      .lt("delta", 0)
      .gt("created_at", fiveMinAgo)
      .in("source", ["shopify", "woocommerce", "squarespace", "bigcommerce"]);

    // Group by SKU to find echo patterns
    const skuDecrements = {};
    for (const row of recentDecrements ?? []) {
      if (!skuDecrements[row.sku]) skuDecrements[row.sku] = [];
      skuDecrements[row.sku].push(row);
    }

    // Check for recent orders that would justify the decrements
    const echoSuspects = [];
    for (const [sku, decrements] of Object.entries(skuDecrements)) {
      if (decrements.length <= 3) continue;

      // Check if there are matching orders in the same window
      const { count: orderCount } = await supabase
        .from("warehouse_order_line_items")
        .select("id", { count: "exact", head: true })
        .eq("sku", sku)
        .gt("created_at", fiveMinAgo);

      // If decrements vastly exceed order count, likely echo
      if (decrements.length > (orderCount ?? 0) + 3) {
        echoSuspects.push({
          sku,
          decrement_count: decrements.length,
          order_count: orderCount ?? 0,
          sources: [...new Set(decrements.map((d) => d.source))],
        });
      }
    }

    readings.push({
      sensorName: "inv.echo_detection",
      status: echoSuspects.length > 0 ? "critical" : "healthy",
      value: {
        suspects: echoSuspects,
        total_recent_decrements: recentDecrements?.length ?? 0,
      },
      message:
        echoSuspects.length > 0
          ? `Echo loop suspected on ${echoSuspects.length} SKU(s): ${echoSuspects.map((s) => s.sku).join(", ")}`
          : "No echo patterns detected",
    });
  } catch (err) {
    readings.push({
      sensorName: "inv.echo_detection",
      status: "warning",
      value: { error: err.message },
      message: "Echo detection check failed",
    });
  }

  // 3. inv.propagation_lag (Rule #71) — per store connection freshness
  try {
    const { data: connections } = await supabase
      .from("client_store_connections")
      .select("id, platform, store_url")
      .eq("workspace_id", workspaceId)
      .eq("connection_status", "active");

    const staleConnections = [];
    for (const conn of connections ?? []) {
      const { data: oldestMapping } = await supabase
        .from("client_store_sku_mappings")
        .select("last_pushed_at")
        .eq("connection_id", conn.id)
        .eq("is_active", true)
        .not("last_pushed_at", "is", null)
        .order("last_pushed_at", { ascending: true })
        .limit(1);

      const oldest = oldestMapping?.[0]?.last_pushed_at;
      if (!oldest) continue;

      const ageMinutes = (Date.now() - new Date(oldest).getTime()) / 60_000;
      let freshness = "fresh";
      if (ageMinutes > 30) freshness = "stale";
      else if (ageMinutes > 5) freshness = "delayed";

      if (freshness !== "fresh") {
        staleConnections.push({
          connection_id: conn.id,
          platform: conn.platform,
          store_url: conn.store_url,
          oldest_push_minutes: Math.round(ageMinutes),
          freshness,
        });
      }
    }

    let status = "healthy";
    if (staleConnections.some((c) => c.freshness === "stale")) status = "critical";
    else if (staleConnections.length > 0) status = "warning";

    readings.push({
      sensorName: "inv.propagation_lag",
      status,
      value: {
        total_active_connections: connections?.length ?? 0,
        stale_connections: staleConnections,
      },
      message:
        staleConnections.length === 0
          ? "All store pushes fresh"
          : `${staleConnections.length} connection(s) with propagation lag`,
    });
  } catch (err) {
    readings.push({
      sensorName: "inv.propagation_lag",
      status: "warning",
      value: { error: err.message },
      message: "Propagation lag check failed",
    });
  }

  // 4. inv.negative_available — SKUs with negative available (should never happen)
  try {
    const { data: negatives, count } = await supabase
      .from("warehouse_inventory_levels")
      .select("sku, available", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .lt("available", 0)
      .limit(10);

    const negCount = count ?? 0;
    readings.push({
      sensorName: "inv.negative_available",
      status: negCount === 0 ? "healthy" : "critical",
      value: {
        negative_count: negCount,
        samples: (negatives ?? []).map((n) => ({ sku: n.sku, available: n.available })),
      },
      message:
        negCount === 0
          ? "No negative inventory"
          : `${negCount} SKU(s) have negative available quantity`,
    });
  } catch (err) {
    readings.push({
      sensorName: "inv.negative_available",
      status: "warning",
      value: { error: err.message },
      message: "Negative inventory check failed",
    });
  }

  return readings;
}

export { collectReadings };

const isMain = process.argv[1]?.endsWith("run-inventory-sensors.mjs");
if (isMain) {
  runSensorDomain("inventory-sensors", collectReadings);
}
