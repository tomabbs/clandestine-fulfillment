import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE env vars"); process.exit(1); }
const sb = createClient(url, key);

const report = { timestamp: new Date().toISOString(), sections: {} };

async function rpcQuery(sql) {
  const { data, error } = await sb.rpc("exec_sql", { q: sql });
  if (error) return null;
  return data;
}

// 2a. Migration parity
async function checkMigrations() {
  const localDir = resolve(process.cwd(), "supabase/migrations");
  const localFiles = readdirSync(localDir).filter(f => f.endsWith(".sql")).sort();
  const localVersions = localFiles.map(f => f.split("_")[0]);

  const { data: remote, error } = await sb
    .from("schema_migrations")
    .select("version")
    .order("version");

  const remoteVersions = (remote ?? []).map(r => r.version);
  const localOnly = localVersions.filter(v => !remoteVersions.includes(v));
  const remoteOnly = remoteVersions.filter(v => !localVersions.includes(v));

  return {
    localCount: localFiles.length,
    remoteCount: remoteVersions.length,
    localOnly,
    remoteOnly,
    inSync: localOnly.length === 0 && remoteOnly.length === 0,
    error: error?.message,
  };
}

// 2b. Critical table checks
async function checkCriticalTables() {
  const tables = [
    "users", "workspaces", "organizations",
    "warehouse_products", "warehouse_product_variants", "warehouse_inventory_levels",
    "warehouse_orders", "warehouse_order_items", "warehouse_shipments", "warehouse_shipment_items",
    "warehouse_inbound_shipments", "warehouse_inbound_items",
    "support_conversations", "support_messages", "support_email_mappings",
    "webhook_events", "channel_sync_log", "sensor_readings", "warehouse_review_queue",
    "bandcamp_connections", "bandcamp_product_mappings", "bandcamp_sales", "bandcamp_sales_backfill_state",
    "client_store_connections", "bundle_components",
    "warehouse_inventory_activity", "billing_snapshots",
  ];

  const results = {};
  for (const t of tables) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    results[t] = { rowCount: count ?? 0, error: error?.message ?? null };
  }
  return results;
}

// 2c. Bandcamp data integrity
async function checkBandcampData() {
  const { count: totalMappings } = await sb.from("bandcamp_product_mappings").select("*", { count: "exact", head: true });

  const { count: withUrl } = await sb.from("bandcamp_product_mappings").select("*", { count: "exact", head: true }).not("bandcamp_url", "is", null);
  const { count: withRawApi } = await sb.from("bandcamp_product_mappings").select("*", { count: "exact", head: true }).not("raw_api_data", "is", null);
  const { count: withSubdomain } = await sb.from("bandcamp_product_mappings").select("*", { count: "exact", head: true }).not("bandcamp_subdomain", "is", null);
  const { count: withAlbumTitle } = await sb.from("bandcamp_product_mappings").select("*", { count: "exact", head: true }).not("bandcamp_album_title", "is", null);

  const { data: authCounts } = await sb.from("bandcamp_product_mappings").select("authority_status");
  const authMap = {};
  for (const r of authCounts ?? []) {
    const s = r.authority_status ?? "null";
    authMap[s] = (authMap[s] ?? 0) + 1;
  }

  const { count: totalSales } = await sb.from("bandcamp_sales").select("*", { count: "exact", head: true });

  const { data: connections } = await sb.from("bandcamp_connections").select("id, band_name, is_active");
  const salesByConnection = [];
  for (const c of connections ?? []) {
    const { count } = await sb.from("bandcamp_sales").select("*", { count: "exact", head: true }).eq("connection_id", c.id);
    const { data: minD } = await sb.from("bandcamp_sales").select("sale_date").eq("connection_id", c.id).order("sale_date", { ascending: true }).limit(1);
    const { data: maxD } = await sb.from("bandcamp_sales").select("sale_date").eq("connection_id", c.id).order("sale_date", { ascending: false }).limit(1);
    salesByConnection.push({
      band: c.band_name, connectionId: c.id, isActive: c.is_active,
      salesCount: count ?? 0, minDate: minD?.[0]?.sale_date ?? null, maxDate: maxD?.[0]?.sale_date ?? null,
    });
  }

  const { data: backfillStates } = await sb.from("bandcamp_sales_backfill_state").select("*");
  const backfillMismatches = [];
  for (const s of backfillStates ?? []) {
    const actual = salesByConnection.find(c => c.connectionId === s.connection_id);
    if (actual && s.total_transactions !== actual.salesCount) {
      backfillMismatches.push({
        connectionId: s.connection_id,
        band: actual.band,
        stateTotal: s.total_transactions,
        actualRows: actual.salesCount,
        status: s.status,
        lastProcessedDate: s.last_processed_date,
        lastError: s.last_error,
      });
    }
  }

  return {
    mappings: {
      total: totalMappings, withUrl, withRawApi, withSubdomain, withAlbumTitle,
      authorityStatus: authMap,
    },
    sales: { total: totalSales, byConnection: salesByConnection },
    backfillState: backfillStates,
    backfillMismatches,
  };
}

// 2c continued: inventory, shipments, webhooks, sensors, review queue
async function checkOperationalData() {
  const { count: negativeInv } = await sb.from("warehouse_inventory_levels").select("*", { count: "exact", head: true }).lt("available", 0);
  const { count: zeroInv } = await sb.from("warehouse_inventory_levels").select("*", { count: "exact", head: true }).eq("available", 0);
  const { count: totalInv } = await sb.from("warehouse_inventory_levels").select("*", { count: "exact", head: true });

  const { data: shipmentsBySource } = await sb.from("warehouse_shipments").select("label_source");
  const sourceMap = {};
  for (const r of shipmentsBySource ?? []) {
    const s = r.label_source ?? "null";
    sourceMap[s] = (sourceMap[s] ?? 0) + 1;
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: webhookStats } = await sb.from("webhook_events").select("platform, status").gte("created_at", sevenDaysAgo);
  const whMap = {};
  for (const w of webhookStats ?? []) {
    const k = `${w.platform}:${w.status}`;
    whMap[k] = (whMap[k] ?? 0) + 1;
  }

  const { data: latestSyncLogs } = await sb.from("channel_sync_log")
    .select("sync_type, status, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  const latestByType = {};
  for (const l of latestSyncLogs ?? []) {
    if (!latestByType[l.sync_type]) latestByType[l.sync_type] = l;
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: stuckRunning } = await sb.from("channel_sync_log")
    .select("*", { count: "exact", head: true })
    .eq("status", "running")
    .lt("created_at", oneHourAgo);

  const { data: sensors } = await sb.from("sensor_readings")
    .select("sensor_name, status, value, checked_at")
    .order("checked_at", { ascending: false })
    .limit(100);
  const latestSensors = {};
  for (const s of sensors ?? []) {
    if (!latestSensors[s.sensor_name]) latestSensors[s.sensor_name] = s;
  }

  const { data: reviewQueueStats } = await sb.from("warehouse_review_queue").select("status");
  const rqMap = {};
  for (const r of reviewQueueStats ?? []) {
    rqMap[r.status] = (rqMap[r.status] ?? 0) + 1;
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: oldOpen } = await sb.from("warehouse_review_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "open")
    .lt("created_at", oneDayAgo);

  return {
    inventory: { total: totalInv, negative: negativeInv, zero: zeroInv },
    shipments: { byLabelSource: sourceMap },
    webhooks7d: whMap,
    syncLog: { latestByType, stuckRunning },
    sensors: latestSensors,
    reviewQueue: { byStatus: rqMap, openOlderThan24h: oldOpen },
  };
}

// 2d. Webhook health snapshot
async function checkWebhookHealth() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const expectedPlatforms = ["shopify", "shipstation", "aftership", "stripe", "resend"];
  const results = {};

  for (const p of expectedPlatforms) {
    const { count } = await sb.from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("platform", p)
      .gte("created_at", sevenDaysAgo);
    const { data: latest } = await sb.from("webhook_events")
      .select("created_at")
      .eq("platform", p)
      .order("created_at", { ascending: false })
      .limit(1);
    results[p] = {
      last7dCount: count ?? 0,
      latestEvent: latest?.[0]?.created_at ?? null,
      status: (count ?? 0) > 0 ? "OK" : "STALE_OR_UNREGISTERED",
    };
  }

  const { data: storeConns } = await sb.from("client_store_connections")
    .select("id, platform, store_url, connection_status, last_webhook_at, last_poll_at, consecutive_errors")
    .order("updated_at", { ascending: false });

  return { platforms: results, storeConnections: storeConns };
}

async function main() {
  console.log("Starting Supabase audit...\n");

  console.log("2a. Checking migration parity...");
  report.sections.migrations = await checkMigrations();
  console.log(`  Local: ${report.sections.migrations.localCount}, Remote: ${report.sections.migrations.remoteCount}`);
  console.log(`  In sync: ${report.sections.migrations.inSync}`);
  if (report.sections.migrations.localOnly.length) console.log(`  LOCAL ONLY: ${report.sections.migrations.localOnly.join(", ")}`);
  if (report.sections.migrations.remoteOnly.length) console.log(`  REMOTE ONLY: ${report.sections.migrations.remoteOnly.join(", ")}`);

  console.log("\n2b. Checking critical tables...");
  report.sections.tables = await checkCriticalTables();
  for (const [t, r] of Object.entries(report.sections.tables)) {
    const flag = r.error ? " [ERROR]" : r.rowCount === 0 ? " [EMPTY]" : "";
    console.log(`  ${t}: ${r.rowCount} rows${flag}`);
  }

  console.log("\n2c. Checking Bandcamp data integrity...");
  report.sections.bandcamp = await checkBandcampData();
  const bc = report.sections.bandcamp;
  console.log(`  Mappings: ${bc.mappings.total} total, ${bc.mappings.withUrl} with URL, ${bc.mappings.withRawApi} with raw API data`);
  console.log(`  Authority status: ${JSON.stringify(bc.mappings.authorityStatus)}`);
  console.log(`  Sales: ${bc.sales.total} total rows`);
  for (const c of bc.sales.byConnection) {
    console.log(`    ${c.band}: ${c.salesCount} rows (${c.minDate ?? "n/a"} to ${c.maxDate ?? "n/a"})`);
  }
  if (bc.backfillMismatches.length) {
    console.log(`  BACKFILL MISMATCHES:`);
    for (const m of bc.backfillMismatches) {
      console.log(`    ${m.band}: state=${m.stateTotal} actual=${m.actualRows} status=${m.status}`);
    }
  }

  console.log("\n2c. Checking operational data...");
  report.sections.operational = await checkOperationalData();
  const op = report.sections.operational;
  console.log(`  Inventory: ${op.inventory.total} total, ${op.inventory.negative} negative, ${op.inventory.zero} zero`);
  console.log(`  Shipments by source: ${JSON.stringify(op.shipments.byLabelSource)}`);
  console.log(`  Webhooks (7d): ${JSON.stringify(op.webhooks7d)}`);
  console.log(`  Stuck sync logs (>1h): ${op.syncLog.stuckRunning}`);
  console.log(`  Sensors:`);
  for (const [name, s] of Object.entries(op.sensors)) {
    const flag = s.status === "critical" ? " [CRITICAL]" : s.status === "warning" ? " [WARNING]" : "";
    console.log(`    ${name}: ${s.status} (${s.value})${flag}`);
  }
  console.log(`  Review queue: ${JSON.stringify(op.reviewQueue.byStatus)}, open>24h: ${op.reviewQueue.openOlderThan24h}`);

  console.log("\n2d. Webhook health snapshot...");
  report.sections.webhookHealth = await checkWebhookHealth();
  for (const [p, r] of Object.entries(report.sections.webhookHealth.platforms)) {
    console.log(`  ${p}: ${r.status} (${r.last7dCount} events, latest: ${r.latestEvent ?? "never"})`);
  }
  console.log(`  Store connections: ${report.sections.webhookHealth.storeConnections?.length ?? 0}`);

  console.log("\n=== AUDIT COMPLETE ===");
  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
