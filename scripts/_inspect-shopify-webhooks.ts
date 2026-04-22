import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  console.log("\n=== Recent shopify inventory_levels/update webhook metadata ===");
  const { data: rows } = await sb
    .from("webhook_events")
    .select("created_at, status, external_webhook_id, metadata, workspace_id")
    .eq("platform", "shopify")
    .eq("topic", "inventory_levels/update")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  for (const r of rows ?? []) {
    console.log(`\n  ${r.created_at}  status=${r.status}  workspace=${r.workspace_id ?? "—"}`);
    console.log(`  external_id: ${r.external_webhook_id}`);
    console.log(`  metadata: ${JSON.stringify(r.metadata ?? {}, null, 2).slice(0, 500)}`);
  }

  console.log("\n=== status breakdown for inventory_levels/update ===");
  const { data: all } = await sb
    .from("webhook_events")
    .select("status")
    .eq("platform", "shopify")
    .eq("topic", "inventory_levels/update")
    .gte("created_at", since);
  const byStatus = new Map<string, number>();
  for (const e of all ?? []) byStatus.set(e.status ?? "?", (byStatus.get(e.status ?? "?") ?? 0) + 1);
  for (const [s, c] of [...byStatus.entries()].sort()) console.log(`    ${s}: ${c}`);

  console.log("\n=== status breakdown for products/update ===");
  const { data: pu } = await sb
    .from("webhook_events")
    .select("status")
    .eq("platform", "shopify")
    .eq("topic", "products/update")
    .gte("created_at", since);
  const byStatus2 = new Map<string, number>();
  for (const e of pu ?? []) byStatus2.set(e.status ?? "?", (byStatus2.get(e.status ?? "?") ?? 0) + 1);
  for (const [s, c] of [...byStatus2.entries()].sort()) console.log(`    ${s}: ${c}`);

  console.log("\n=== Hourly distribution of inventory_levels/update webhooks (last 7d) ===");
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: hist } = await sb
    .from("webhook_events")
    .select("created_at")
    .eq("platform", "shopify")
    .eq("topic", "inventory_levels/update")
    .gte("created_at", since7)
    .order("created_at", { ascending: true });
  const byDay = new Map<string, number>();
  for (const e of hist ?? []) {
    const day = e.created_at?.slice(0, 10) ?? "?";
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  for (const [d, c] of [...byDay.entries()].sort()) console.log(`    ${d}: ${c}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
