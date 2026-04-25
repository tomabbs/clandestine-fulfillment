/**
 * Phase 3 Pass 2 soak — locate the Northern Spy Shopify connection and
 * print the per-connection state needed to decide whether `legacy → shadow`
 * is safe to flip.
 *
 * Read-only. No writes.
 *
 * Usage:
 *   pnpm tsx scripts/_phase3-locate-northern-spy.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface ConnRow {
  id: string;
  workspace_id: string;
  org_id: string | null;
  platform: string;
  store_url: string | null;
  connection_status: string | null;
  do_not_fanout: boolean | null;
  cutover_state: string | null;
  cutover_started_at: string | null;
  cutover_completed_at: string | null;
  shadow_window_tolerance_seconds: number | null;
  webhook_secret: string | null;
  default_location_id: string | null;
  created_at: string | null;
}

async function main() {
  const sb = createServiceRoleClient();

  console.log("=== Looking up organizations matching 'northern spy' ===");
  const { data: orgs } = await sb
    .from("organizations")
    .select("id, name, slug, workspace_id")
    .or("name.ilike.%northern%spy%,slug.ilike.%northern%spy%");
  console.log(JSON.stringify(orgs, null, 2));

  const orgIds = new Set((orgs ?? []).map((o: { id: string }) => o.id));
  if (orgIds.size === 0) {
    console.log("No org matched. Listing all orgs (workspace scope) so you can pick manually:");
    const { data: allOrgs } = await sb
      .from("organizations")
      .select("id, name, slug, workspace_id")
      .order("name");
    console.log(JSON.stringify(allOrgs, null, 2));
  }

  console.log("\n=== Connections for matched orgs ===");
  if (orgIds.size > 0) {
    const { data: conns } = await sb
      .from("client_store_connections")
      .select(
        "id, workspace_id, org_id, platform, store_url, connection_status, do_not_fanout, cutover_state, cutover_started_at, cutover_completed_at, shadow_window_tolerance_seconds, webhook_secret, default_location_id, created_at",
      )
      .in("org_id", Array.from(orgIds))
      .order("created_at", { ascending: false });
    const rows = (conns ?? []) as ConnRow[];
    console.log(JSON.stringify(rows, null, 2));

    console.log("\n=== Pre-flight gate per connection ===");
    for (const c of rows) {
      const reasons: string[] = [];
      if (c.platform !== "shopify") reasons.push(`platform=${c.platform} (need 'shopify')`);
      if (c.connection_status !== "active")
        reasons.push(`connection_status=${c.connection_status} (need 'active')`);
      if (c.do_not_fanout === true) reasons.push("do_not_fanout=true (must be false)");
      const cur = c.cutover_state ?? "legacy";
      if (cur !== "legacy") reasons.push(`cutover_state=${cur} (need 'legacy')`);
      if (!c.webhook_secret)
        reasons.push("webhook_secret is NULL (Phase 3 release gate C.2.6 hard-block)");
      const verdict = reasons.length === 0 ? "READY-FOR-SHADOW" : "BLOCKED";
      console.log(`  ${verdict}  ${c.platform.padEnd(10)} ${c.store_url ?? "(no url)"}  id=${c.id}`);
      if (reasons.length > 0) {
        for (const r of reasons) console.log(`            - ${r}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
