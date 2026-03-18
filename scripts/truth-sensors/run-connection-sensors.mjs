#!/usr/bin/env node

/**
 * Connection sensors — checks health of client store connections.
 *
 * Sensors:
 *   webhook.silence — active connection with no webhooks >6hr while poller finds orders
 *   connection.auth_failures — connections in disabled_auth_failure state
 *   connection.error_rate — connections with recent errors
 */

import { runSensorDomain } from "./_shared.mjs";

async function collectReadings(supabase, workspaceId) {
  const readings = [];

  // 1. webhook.silence (Rule #17)
  try {
    const { data: conns } = await supabase
      .from("client_store_connections")
      .select("id, platform, store_url, last_webhook_at, last_poll_at, org_id")
      .eq("workspace_id", workspaceId)
      .eq("connection_status", "active");

    for (const conn of conns ?? []) {
      const silenceHours = conn.last_webhook_at
        ? (Date.now() - new Date(conn.last_webhook_at).getTime()) / (1000 * 60 * 60)
        : 0;
      const pollFoundOrders = conn.last_poll_at != null;

      if (silenceHours > 6 && pollFoundOrders) {
        readings.push({
          sensorName: "webhook.silence",
          status: "warning",
          value: {
            connection_id: conn.id,
            platform: conn.platform,
            store_url: conn.store_url,
            last_webhook_at: conn.last_webhook_at,
            silence_hours: Math.round(silenceHours),
          },
          message: `Webhook silence on ${conn.platform} (${conn.store_url}) — ${Math.round(silenceHours)}hr`,
        });
      }
    }

    // If no silence detected, emit a healthy reading
    if (!readings.some((r) => r.sensorName === "webhook.silence")) {
      readings.push({
        sensorName: "webhook.silence",
        status: "healthy",
        value: { active_connections: conns?.length ?? 0 },
        message: "All active connections receiving webhooks",
      });
    }
  } catch (err) {
    readings.push({
      sensorName: "webhook.silence",
      status: "warning",
      value: { error: err.message },
      message: "Could not check webhook silence",
    });
  }

  // 2. connection.auth_failures (Rule #53)
  try {
    const { data: failed, count } = await supabase
      .from("client_store_connections")
      .select("id, platform, store_url, last_error", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .eq("connection_status", "disabled_auth_failure");

    const failCount = count ?? 0;
    readings.push({
      sensorName: "connection.auth_failures",
      status: failCount === 0 ? "healthy" : failCount <= 2 ? "warning" : "critical",
      value: {
        disabled_count: failCount,
        connections: (failed ?? []).map((c) => ({
          id: c.id,
          platform: c.platform,
          store_url: c.store_url,
        })),
      },
      message:
        failCount === 0
          ? "No auth-disabled connections"
          : `${failCount} connection(s) disabled due to auth failure`,
    });
  } catch (err) {
    readings.push({
      sensorName: "connection.auth_failures",
      status: "warning",
      value: { error: err.message },
      message: "Could not check auth failures",
    });
  }

  // 3. connection.error_rate — connections with errors in last hour
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: errored, count } = await supabase
      .from("client_store_connections")
      .select("id, platform, store_url, last_error, last_error_at", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .eq("connection_status", "active")
      .gt("last_error_at", oneHourAgo);

    const errCount = count ?? 0;
    readings.push({
      sensorName: "connection.error_rate",
      status: errCount === 0 ? "healthy" : errCount <= 3 ? "warning" : "critical",
      value: {
        recent_errors: errCount,
        connections: (errored ?? []).map((c) => ({
          id: c.id,
          platform: c.platform,
          last_error: c.last_error,
        })),
      },
      message:
        errCount === 0
          ? "No connection errors in last hour"
          : `${errCount} connection(s) with errors in last hour`,
    });
  } catch (err) {
    readings.push({
      sensorName: "connection.error_rate",
      status: "warning",
      value: { error: err.message },
      message: "Could not check connection errors",
    });
  }

  return readings;
}

export { collectReadings };

// Self-execute when run directly
const isMain = process.argv[1]?.endsWith("run-connection-sensors.mjs");
if (isMain) {
  runSensorDomain("connection-sensors", collectReadings);
}
