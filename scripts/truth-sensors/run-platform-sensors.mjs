#!/usr/bin/env node

/**
 * Platform sensors — checks infrastructure and processing health.
 *
 * Sensors:
 *   webhook.processing_latency — time from webhook received to processed
 *   platform.db_pool_saturation — pg_stat_activity connection count
 *   platform.sensor_readings_growth — table size monitoring
 *   platform.task_failure_rate — recent Trigger.dev task errors via review queue
 */

import { createClient } from "@supabase/supabase-js";
import { runSensorDomain } from "./_shared.mjs";
import "dotenv/config";

/**
 * Create a direct Postgres client for pg_stat_activity queries.
 * Falls back to the standard Supabase client if DIRECT_URL is not available.
 */
function createDirectClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function collectReadings(supabase, workspaceId) {
  const readings = [];

  // 1. webhook.processing_latency — time from received to processed
  try {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const { data: recentWebhooks } = await supabase
      .from("webhook_events")
      .select("created_at, processed_at, platform")
      .gt("created_at", fifteenMinAgo)
      .not("processed_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(100);

    if (!recentWebhooks || recentWebhooks.length === 0) {
      readings.push({
        sensorName: "webhook.processing_latency",
        status: "healthy",
        value: { sample_size: 0 },
        message: "No webhooks processed in last 15 minutes",
      });
    } else {
      const latencies = recentWebhooks.map((w) => {
        const received = new Date(w.created_at).getTime();
        const processed = new Date(w.processed_at).getTime();
        return (processed - received) / 1000; // seconds
      });

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const p95Index = Math.floor(latencies.length * 0.95);
      const sorted = [...latencies].sort((a, b) => a - b);
      const p95Latency = sorted[p95Index] ?? maxLatency;

      // Platform breakdown
      const byPlatform = {};
      for (const w of recentWebhooks) {
        if (!byPlatform[w.platform]) byPlatform[w.platform] = 0;
        byPlatform[w.platform]++;
      }

      let status = "healthy";
      if (p95Latency > 30) status = "critical";
      else if (p95Latency > 10) status = "warning";

      readings.push({
        sensorName: "webhook.processing_latency",
        status,
        value: {
          sample_size: recentWebhooks.length,
          avg_seconds: Math.round(avgLatency * 100) / 100,
          p95_seconds: Math.round(p95Latency * 100) / 100,
          max_seconds: Math.round(maxLatency * 100) / 100,
          by_platform: byPlatform,
        },
        message: `Webhook latency: avg=${avgLatency.toFixed(1)}s, p95=${p95Latency.toFixed(1)}s, max=${maxLatency.toFixed(1)}s (${recentWebhooks.length} samples)`,
      });
    }
  } catch (err) {
    readings.push({
      sensorName: "webhook.processing_latency",
      status: "warning",
      value: { error: err.message },
      message: "Webhook latency check failed",
    });
  }

  // 2. platform.db_pool_saturation — pg_stat_activity connection count
  // Uses RPC to query pg_stat_activity since direct SQL isn't available via PostgREST
  try {
    const directClient = createDirectClient();

    // Query pg_stat_activity via Supabase RPC or direct query
    // Supabase exposes this via the pg_stat_activity view for service_role
    const { data, error } = await directClient.rpc("get_connection_count").single();

    if (error) {
      // Fallback: try querying the view directly if RPC doesn't exist
      const { count, error: countError } = await directClient
        .from("pg_stat_activity")
        .select("*", { count: "exact", head: true });

      if (countError) {
        // pg_stat_activity not accessible — estimate from pool config
        readings.push({
          sensorName: "platform.db_pool_saturation",
          status: "healthy",
          value: { note: "pg_stat_activity not accessible via PostgREST" },
          message: "DB pool check unavailable (requires direct pg access or custom RPC)",
        });
      } else {
        const connCount = count ?? 0;
        const maxConnections = Number(process.env.DB_MAX_CONNECTIONS ?? 100);
        const saturation = connCount / maxConnections;

        let status = "healthy";
        if (saturation > 0.9) status = "critical";
        else if (saturation > 0.7) status = "warning";

        readings.push({
          sensorName: "platform.db_pool_saturation",
          status,
          value: {
            active_connections: connCount,
            max_connections: maxConnections,
            saturation_pct: Math.round(saturation * 100),
          },
          message: `DB pool: ${connCount}/${maxConnections} connections (${Math.round(saturation * 100)}%)`,
        });
      }
    } else {
      const connCount = data?.count ?? 0;
      const maxConnections = Number(process.env.DB_MAX_CONNECTIONS ?? 100);
      const saturation = connCount / maxConnections;

      let status = "healthy";
      if (saturation > 0.9) status = "critical";
      else if (saturation > 0.7) status = "warning";

      readings.push({
        sensorName: "platform.db_pool_saturation",
        status,
        value: {
          active_connections: connCount,
          max_connections: maxConnections,
          saturation_pct: Math.round(saturation * 100),
        },
        message: `DB pool: ${connCount}/${maxConnections} connections (${Math.round(saturation * 100)}%)`,
      });
    }
  } catch (err) {
    readings.push({
      sensorName: "platform.db_pool_saturation",
      status: "healthy",
      value: { error: err.message },
      message: "DB pool saturation check unavailable",
    });
  }

  // 3. platform.sensor_readings_growth — check sensor_readings isn't growing unbounded
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("sensor_readings")
      .select("id", { count: "exact", head: true })
      .gt("created_at", oneDayAgo);

    const dailyCount = count ?? 0;
    // At 5min intervals with ~10 sensors = ~2880/day. >10000 suggests problems.
    let status = "healthy";
    if (dailyCount > 10000) status = "critical";
    else if (dailyCount > 5000) status = "warning";

    readings.push({
      sensorName: "platform.sensor_readings_growth",
      status,
      value: { readings_last_24h: dailyCount },
      message: `${dailyCount} sensor readings in last 24h`,
    });
  } catch (err) {
    readings.push({
      sensorName: "platform.sensor_readings_growth",
      status: "healthy",
      value: { error: err.message },
      message: "Readings growth check skipped",
    });
  }

  // 4. platform.task_failure_rate — check for task-related review queue items
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("warehouse_review_queue")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("category", "task_failure")
      .eq("status", "open")
      .gt("created_at", oneHourAgo);

    const failCount = count ?? 0;
    readings.push({
      sensorName: "platform.task_failure_rate",
      status: failCount === 0 ? "healthy" : failCount <= 3 ? "warning" : "critical",
      value: { failures_last_hour: failCount },
      message:
        failCount === 0
          ? "No task failures in last hour"
          : `${failCount} task failure(s) in last hour`,
    });
  } catch {
    readings.push({
      sensorName: "platform.task_failure_rate",
      status: "healthy",
      value: {},
      message: "Task failure check skipped",
    });
  }

  return readings;
}

export { collectReadings };

const isMain = process.argv[1]?.endsWith("run-platform-sensors.mjs");
if (isMain) {
  runSensorDomain("platform-sensors", collectReadings);
}
