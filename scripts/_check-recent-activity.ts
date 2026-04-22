import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Check webhook_events for shopify inventory webhooks
  console.log("\n=== webhook_events: shopify inventory_levels/update (last 14d) ===");
  const { data: whEvents, error: whErr } = await sb
    .from("webhook_events")
    .select("platform, topic, external_webhook_id, created_at, processed_at, status")
    .eq("platform", "shopify")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  if (whErr) console.log("  query error:", whErr.message);
  console.log(`  found ${whEvents?.length ?? 0} rows`);
  const byTopic = new Map<string, number>();
  for (const e of whEvents ?? []) byTopic.set(e.topic ?? "?", (byTopic.get(e.topic ?? "?") ?? 0) + 1);
  for (const [t, c] of [...byTopic.entries()].sort()) console.log(`    ${t}: ${c}`);
  console.log("\n  Most recent 10:");
  for (const e of (whEvents ?? []).slice(0, 10)) {
    console.log(`    ${e.created_at?.slice(0, 19)}  ${e.topic}  ${e.status}`);
  }

  console.log("\n=== webhook_events: ALL platforms (last 14d) ===");
  const { data: allWh } = await sb
    .from("webhook_events")
    .select("platform, topic, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  const byPlatTopic = new Map<string, number>();
  for (const e of allWh ?? []) {
    const k = `${e.platform}/${e.topic ?? "?"}`;
    byPlatTopic.set(k, (byPlatTopic.get(k) ?? 0) + 1);
  }
  console.log(`  found ${allWh?.length ?? 0} total rows`);
  for (const [k, c] of [...byPlatTopic.entries()].sort()) console.log(`    ${k}: ${c}`);

  // 2. Check warehouse_inventory_activity for any "shopify" or "client_store" sourced events recently
  console.log("\n=== warehouse_inventory_activity: shopify/client_store sources (last 14d) ===");
  const { data: act, error: actErr } = await sb
    .from("warehouse_inventory_activity")
    .select("sku, source, delta, correlation_id, created_at")
    .gte("created_at", since)
    .in("source", ["shopify", "client_store", "squarespace", "woocommerce", "shipstation", "reconcile", "bandcamp"])
    .order("created_at", { ascending: false })
    .limit(100);
  if (actErr) console.log("  query error:", actErr.message);
  console.log(`  found ${act?.length ?? 0} rows`);
  const bySrc = new Map<string, number>();
  for (const r of act ?? []) bySrc.set(r.source ?? "?", (bySrc.get(r.source ?? "?") ?? 0) + 1);
  for (const [s, c] of [...bySrc.entries()].sort()) console.log(`    ${s}: ${c}`);
  console.log("\n  Most recent 15:");
  for (const r of (act ?? []).slice(0, 15)) {
    console.log(`    ${r.created_at?.slice(0, 19)}  ${r.source.padEnd(12)}  ${r.sku.padEnd(20)}  delta=${r.delta}`);
  }

  // 3. Check external_sync_events (outbound pushes from us)
  console.log("\n=== external_sync_events: outbound pushes (last 14d) ===");
  const { data: ext } = await sb
    .from("external_sync_events")
    .select("system, action, status, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  const byBucket = new Map<string, number>();
  for (const e of ext ?? []) {
    const k = `${e.system}/${e.action}/${e.status}`;
    byBucket.set(k, (byBucket.get(k) ?? 0) + 1);
  }
  console.log(`  found ${ext?.length ?? 0} rows total`);
  for (const [k, c] of [...byBucket.entries()].sort()) console.log(`    ${k}: ${c}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
