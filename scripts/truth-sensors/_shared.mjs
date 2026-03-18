/**
 * Shared utilities for truth-layer sensor runners.
 *
 * These scripts run outside Next.js/Trigger.dev, so they create
 * their own Supabase client via env vars loaded from dotenv.
 */

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

export function getWorkspaceId() {
  return process.env.WORKSPACE_ID ?? WORKSPACE_ID;
}

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Ensure .env.local is present or env vars are set.",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Persist an array of sensor readings to the sensor_readings table.
 * Returns count of inserted rows.
 */
export async function persistReadings(supabase, readings, workspaceId) {
  if (readings.length === 0) return 0;

  const rows = readings.map((r) => ({
    workspace_id: workspaceId,
    sensor_name: r.sensorName,
    status: r.status,
    value: r.value,
    message: r.message,
  }));

  const { error } = await supabase.from("sensor_readings").insert(rows);
  if (error) {
    console.error("[truth-sensors] Failed to persist readings:", error.message);
    throw error;
  }
  return rows.length;
}

/**
 * For any critical readings, upsert into warehouse_review_queue.
 */
export async function escalateCriticals(supabase, readings, workspaceId) {
  const criticals = readings.filter((r) => r.status === "critical");
  for (const critical of criticals) {
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        category: "sensor",
        severity: "critical",
        title: `Sensor critical: ${critical.sensorName}`,
        description: critical.message,
        metadata: critical.value,
        group_key: `sensor_critical:${critical.sensorName}`,
        status: "open",
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: false },
    );
  }
  return criticals.length;
}

/**
 * Standard runner wrapper: runs sensor fn, persists, escalates, logs summary.
 */
export async function runSensorDomain(domainName, sensorFn) {
  const start = Date.now();
  console.log(`[${domainName}] Starting sensor checks...`);

  const supabase = createServiceClient();
  const workspaceId = getWorkspaceId();

  try {
    const readings = await sensorFn(supabase, workspaceId);
    const persisted = await persistReadings(supabase, readings, workspaceId);
    const escalated = await escalateCriticals(supabase, readings, workspaceId);

    const elapsed = Date.now() - start;
    console.log(
      `[${domainName}] Done in ${elapsed}ms — ${persisted} readings, ${escalated} critical escalations`,
    );

    return { readings, persisted, escalated };
  } catch (err) {
    console.error(`[${domainName}] Fatal error:`, err);
    process.exitCode = 1;
    throw err;
  }
}
