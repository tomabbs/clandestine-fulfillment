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

/**
 * Trigger the shopify-image-backfill task (manual, admin-only).
 *
 * Fixes two historical data gaps:
 * 1. Products synced from Shopify before warehouse_product_images rows were
 *    properly hydrated — backfills the table from images JSONB.
 * 2. Products created via bandcamp-sync that got no Shopify image due to the
 *    `media` vs `files` ProductSetInput field bug — pushes bandcamp_art_url
 *    via productCreateMedia.
 */
export async function triggerShopifyImageBackfill(): Promise<{ runId: string }> {
  const handle = await tasks.trigger("shopify-image-backfill", {});
  return { runId: handle.id };
}

// === Pipeline Health ===

export async function getShippingBillingHealth() {
  const supabase = await createServerSupabaseClient();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const [
    shipmentsBySource,
    psImports,
    orphanedShipments,
    reviewQueue,
    recentSnapshots,
    taskSensors,
  ] = await Promise.all([
    supabase
      .from("warehouse_shipments")
      .select("label_source")
      .gte("created_at", `${thirtyDaysAgo}T00:00:00Z`),

    supabase
      .from("warehouse_pirate_ship_imports")
      .select("id, status, processed_count, error_count, errors, created_at")
      .order("created_at", { ascending: false })
      .limit(10),

    supabase
      .from("warehouse_shipments")
      .select("id", { count: "exact", head: true })
      .is("org_id", null)
      .eq("voided", false),

    supabase
      .from("warehouse_review_queue")
      .select("id, category", { count: "exact" })
      .eq("status", "open"),

    supabase
      .from("warehouse_billing_snapshots")
      .select("id, billing_period, status, snapshot_data, created_at")
      .order("created_at", { ascending: false })
      .limit(5),

    supabase
      .from("sensor_readings")
      .select("sensor_name, status, message, created_at")
      .in("sensor_name", [
        "trigger:storage-calc",
        "trigger:monthly-billing",
        "trigger:pirate-ship-import",
        "trigger:shipstation-poll",
      ])
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // Aggregate shipments by source
  const sourceCounts: Record<string, number> = {};
  for (const s of shipmentsBySource.data ?? []) {
    const src = s.label_source ?? "unknown";
    sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
  }

  // Recent PS imports with metrics
  const psImportSummary = (psImports.data ?? []).map((imp) => ({
    id: imp.id,
    status: imp.status,
    processedCount: imp.processed_count,
    errorCount: imp.error_count,
    metrics: (imp.errors as Record<string, unknown>)?.metrics ?? null,
    createdAt: imp.created_at,
  }));

  // Snapshots with warnings
  const snapshotWarnings = (recentSnapshots.data ?? [])
    .filter((s) => {
      const sd = s.snapshot_data as Record<string, unknown> | null;
      return sd?.warnings && (sd.warnings as string[]).length > 0;
    })
    .map((s) => ({
      id: s.id,
      billingPeriod: s.billing_period,
      warnings: ((s.snapshot_data as Record<string, unknown>)?.warnings as string[]) ?? [],
    }));

  // Review queue by category
  const reviewByCategory: Record<string, number> = {};
  for (const r of reviewQueue.data ?? []) {
    reviewByCategory[r.category] = (reviewByCategory[r.category] ?? 0) + 1;
  }

  // Latest task sensor readings
  const latestByTask = new Map<string, { status: string; message: string | null; at: string }>();
  for (const r of taskSensors.data ?? []) {
    if (!latestByTask.has(r.sensor_name)) {
      latestByTask.set(r.sensor_name, {
        status: r.status,
        message: r.message,
        at: r.created_at,
      });
    }
  }

  return {
    shipmentsBySource: sourceCounts,
    totalShipments30d: shipmentsBySource.data?.length ?? 0,
    psImports: psImportSummary,
    orphanedShipmentCount: orphanedShipments.count ?? 0,
    reviewQueueTotal: reviewQueue.count ?? 0,
    reviewByCategory,
    snapshotWarnings,
    taskHealth: Object.fromEntries(latestByTask),
  };
}
