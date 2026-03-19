"use server";

import { tasks } from "@trigger.dev/sdk";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

export async function getGeneralSettings() {
  const supabase = await createServerSupabaseClient();

  const [workspaces, orgs, products, rules] = await Promise.all([
    supabase.from("workspaces").select("name, slug").limit(1).single(),
    supabase.from("organizations").select("id", { count: "exact", head: true }),
    supabase.from("warehouse_products").select("id", { count: "exact", head: true }),
    supabase
      .from("warehouse_billing_rules")
      .select("rule_name, rule_type, amount, is_active")
      .eq("is_active", true)
      .limit(10),
  ]);

  return {
    workspace: workspaces.data,
    orgCount: orgs.count ?? 0,
    productCount: products.count ?? 0,
    billingRules: rules.data ?? [],
  };
}

export async function getIntegrationStatus() {
  const supabase = await createServerSupabaseClient();

  const [shopifySync, bcCreds, ssStores, syncLogs] = await Promise.all([
    supabase.from("warehouse_sync_state").select("sync_type, last_sync_wall_clock").limit(10),
    supabase.from("bandcamp_credentials").select("id, token_expires_at").limit(1).single(),
    supabase.from("warehouse_shipstation_stores").select("id", { count: "exact", head: true }),
    supabase
      .from("channel_sync_log")
      .select("channel, status, completed_at")
      .order("completed_at", { ascending: false })
      .limit(20),
  ]);

  const lastByChannel = new Map<string, { status: string; completed_at: string }>();
  for (const log of syncLogs.data ?? []) {
    if (!lastByChannel.has(log.channel)) {
      lastByChannel.set(log.channel, { status: log.status, completed_at: log.completed_at ?? "" });
    }
  }

  return {
    syncStates: shopifySync.data ?? [],
    bandcampTokenExpiry: bcCreds?.data?.token_expires_at ?? null,
    shipstationStoreCount: ssStores.count ?? 0,
    lastActivity: Object.fromEntries(lastByChannel),
  };
}

export async function getHealthData() {
  const supabase = await createServerSupabaseClient();

  const { data: allReadings } = await supabase
    .from("sensor_readings")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  type Reading = NonNullable<typeof allReadings>[number];
  const latestBySensor = new Map<string, Reading>();
  const historyBySensor = new Map<string, Reading[]>();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  for (const r of allReadings ?? []) {
    if (!latestBySensor.has(r.sensor_name)) latestBySensor.set(r.sensor_name, r);
    if (r.created_at >= oneDayAgo) {
      const h = historyBySensor.get(r.sensor_name) ?? [];
      h.push(r);
      historyBySensor.set(r.sensor_name, h);
    }
  }

  return {
    latest: Array.from(latestBySensor.entries()).map(([name, r]) => ({
      name,
      status: r.status,
      message: r.message,
      timestamp: r.created_at,
    })),
    history: Object.fromEntries(
      Array.from(historyBySensor.entries()).map(([name, readings]) => [
        name,
        readings.map((r) => ({ status: r.status, timestamp: r.created_at })),
      ]),
    ),
  };
}

export async function triggerSensorCheck() {
  const handle = await tasks.trigger("sensor-check", {});
  return { runId: handle.id };
}

export async function triggerTagCleanup() {
  const supabase = await createServerSupabaseClient();
  const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!ws) throw new Error("No workspace found");

  const handle = await tasks.trigger("tag-cleanup-backfill", { workspace_id: ws.id });
  return { runId: handle.id };
}
