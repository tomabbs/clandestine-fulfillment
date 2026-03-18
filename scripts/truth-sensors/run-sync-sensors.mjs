#!/usr/bin/env node

/**
 * Sync sensors — checks staleness of platform sync jobs.
 *
 * Sensors:
 *   sync.shopify_stale — Shopify delta sync freshness
 *   sync.bandcamp_stale — Bandcamp connection sync freshness
 *   sync.shipstation_stale — ShipStation poll freshness
 */

import { runSensorDomain } from "./_shared.mjs";

function syncStalenessStatus(minutesSinceSync, warnThreshold = 30, criticalThreshold = 120) {
  if (minutesSinceSync === null) return "critical";
  if (minutesSinceSync < warnThreshold) return "healthy";
  if (minutesSinceSync < criticalThreshold) return "warning";
  return "critical";
}

async function collectReadings(supabase, workspaceId) {
  const readings = [];

  // 1. sync.shopify_stale
  try {
    const { data: syncState } = await supabase
      .from("warehouse_sync_state")
      .select("last_sync_wall_clock")
      .eq("workspace_id", workspaceId)
      .eq("sync_type", "shopify_delta")
      .single();

    const minutesSince = syncState?.last_sync_wall_clock
      ? (Date.now() - new Date(syncState.last_sync_wall_clock).getTime()) / 60_000
      : null;

    readings.push({
      sensorName: "sync.shopify_stale",
      status: syncStalenessStatus(minutesSince),
      value: {
        last_sync: syncState?.last_sync_wall_clock ?? null,
        minutes_since: minutesSince !== null ? Math.round(minutesSince) : null,
      },
      message:
        minutesSince === null
          ? "Shopify never synced"
          : `Shopify last sync ${Math.round(minutesSince)} minutes ago`,
    });
  } catch {
    readings.push({
      sensorName: "sync.shopify_stale",
      status: "critical",
      value: {},
      message: "Could not check Shopify sync state",
    });
  }

  // 2. sync.bandcamp_stale
  try {
    const { data: bcState } = await supabase
      .from("bandcamp_connections")
      .select("last_synced_at")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .order("last_synced_at", { ascending: true })
      .limit(1);

    const lastSync = bcState?.[0]?.last_synced_at;
    const minutesSince = lastSync
      ? (Date.now() - new Date(lastSync).getTime()) / 60_000
      : null;

    readings.push({
      sensorName: "sync.bandcamp_stale",
      status: syncStalenessStatus(minutesSince),
      value: {
        last_sync: lastSync ?? null,
        minutes_since: minutesSince !== null ? Math.round(minutesSince) : null,
      },
      message:
        minutesSince === null
          ? "Bandcamp never synced"
          : `Bandcamp last sync ${Math.round(minutesSince)} minutes ago`,
    });
  } catch {
    readings.push({
      sensorName: "sync.bandcamp_stale",
      status: "healthy",
      value: {},
      message: "No Bandcamp connections",
    });
  }

  // 3. sync.shipstation_stale
  try {
    const { data: ssState } = await supabase
      .from("warehouse_sync_state")
      .select("last_sync_wall_clock")
      .eq("workspace_id", workspaceId)
      .eq("sync_type", "shipstation_poll")
      .single();

    const minutesSince = ssState?.last_sync_wall_clock
      ? (Date.now() - new Date(ssState.last_sync_wall_clock).getTime()) / 60_000
      : null;

    readings.push({
      sensorName: "sync.shipstation_stale",
      status: syncStalenessStatus(minutesSince, 60, 240),
      value: {
        last_sync: ssState?.last_sync_wall_clock ?? null,
        minutes_since: minutesSince !== null ? Math.round(minutesSince) : null,
      },
      message:
        minutesSince === null
          ? "ShipStation never polled"
          : `ShipStation last poll ${Math.round(minutesSince)} minutes ago`,
    });
  } catch {
    readings.push({
      sensorName: "sync.shipstation_stale",
      status: "healthy",
      value: {},
      message: "No ShipStation sync state",
    });
  }

  return readings;
}

export { collectReadings };

const isMain = process.argv[1]?.endsWith("run-sync-sensors.mjs");
if (isMain) {
  runSensorDomain("sync-sensors", collectReadings);
}
