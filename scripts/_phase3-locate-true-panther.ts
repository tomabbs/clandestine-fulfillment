/**
 * Phase 3 Pass 2 soak — locate True Panther connections.
 *
 * Read-only.
 *
 * Usage:
 *   pnpm tsx scripts/_phase3-locate-true-panther.ts
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
  shopify_verified_domain: string | null;
  connection_status: string | null;
  do_not_fanout: boolean | null;
  cutover_state: string | null;
  cutover_started_at: string | null;
  cutover_completed_at: string | null;
  shadow_window_tolerance_seconds: number | null;
  webhook_secret: string | null;
  default_location_id: string | null;
  api_key: string | null;
  shopify_app_client_id: string | null;
  shopify_app_client_secret_encrypted: string | null;
  created_at: string | null;
}

async function main() {
  const sb = createServiceRoleClient();

  console.log("=== Looking up organizations matching 'true panther' ===");
  const { data: orgs } = await sb
    .from("organizations")
    .select("id, name, slug, workspace_id")
    .or("name.ilike.%true%panther%,slug.ilike.%true%panther%,name.ilike.%panther%");
  console.log(JSON.stringify(orgs, null, 2));

  const orgIds = new Set((orgs ?? []).map((o: { id: string }) => o.id));

  if (orgIds.size === 0) {
    console.log("\nNo org matched. Falling back to org_aliases:");
    const { data: aliases } = await sb
      .from("organization_aliases")
      .select("id, org_id, alias_name, source, workspace_id")
      .or("alias_name.ilike.%true%panther%,alias_name.ilike.%panther%");
    console.log(JSON.stringify(aliases, null, 2));
    for (const a of aliases ?? []) orgIds.add((a as { org_id: string }).org_id);
  }

  if (orgIds.size === 0) {
    console.log("\nStill no match. Listing ALL orgs in the system for manual selection:");
    const { data: allOrgs } = await sb
      .from("organizations")
      .select("id, name, slug, workspace_id")
      .order("name");
    console.log(JSON.stringify(allOrgs, null, 2));
    return;
  }

  console.log("\n=== Connections for matched orgs ===");
  const { data: conns } = await sb
    .from("client_store_connections")
    .select(
      "id, workspace_id, org_id, platform, store_url, shopify_verified_domain, connection_status, do_not_fanout, cutover_state, cutover_started_at, cutover_completed_at, shadow_window_tolerance_seconds, webhook_secret, default_location_id, api_key, shopify_app_client_id, shopify_app_client_secret_encrypted, created_at",
    )
    .in("org_id", Array.from(orgIds))
    .order("created_at", { ascending: false });

  const rows = (conns ?? []) as ConnRow[];
  if (rows.length === 0) {
    console.log("(no connections on these orgs)");
    return;
  }

  // Redact secrets in console output.
  const redact = (v: string | null) =>
    !v ? "(null)" : `${v.slice(0, 4)}\u2026${v.slice(-4)} (len=${v.length})`;

  for (const c of rows) {
    console.log("─".repeat(72));
    console.log(`  id                              : ${c.id}`);
    console.log(`  org_id                          : ${c.org_id}`);
    console.log(`  workspace_id                    : ${c.workspace_id}`);
    console.log(`  platform                        : ${c.platform}`);
    console.log(`  store_url                       : ${c.store_url}`);
    console.log(`  shopify_verified_domain         : ${c.shopify_verified_domain ?? "(null)"}`);
    console.log(`  connection_status               : ${c.connection_status}`);
    console.log(`  do_not_fanout                   : ${c.do_not_fanout}`);
    console.log(`  cutover_state                   : ${c.cutover_state}`);
    console.log(`  cutover_started_at              : ${c.cutover_started_at ?? "(null)"}`);
    console.log(`  cutover_completed_at            : ${c.cutover_completed_at ?? "(null)"}`);
    console.log(`  shadow_window_tolerance_seconds : ${c.shadow_window_tolerance_seconds ?? "(null)"}`);
    console.log(`  default_location_id             : ${c.default_location_id ?? "(null)"}`);
    console.log(`  api_key (token)                 : ${redact(c.api_key)}`);
    console.log(`  shopify_app_client_id           : ${c.shopify_app_client_id ?? "(null)"}`);
    console.log(`  shopify_app_client_secret       : ${redact(c.shopify_app_client_secret_encrypted)}`);
    console.log(`  webhook_secret                  : ${redact(c.webhook_secret)}`);
    console.log(`  created_at                      : ${c.created_at}`);
  }

  console.log("─".repeat(72));
  console.log("\n=== Pre-flight gate per connection (Phase 3 cutover) ===");
  for (const c of rows) {
    const reasons: string[] = [];
    if (c.platform !== "shopify") reasons.push(`platform=${c.platform} (need 'shopify' for Phase 3)`);
    if (c.connection_status !== "active") reasons.push(`connection_status=${c.connection_status}`);
    if (c.do_not_fanout === true) reasons.push("do_not_fanout=true");
    const cur = c.cutover_state ?? "legacy";
    if (cur !== "legacy") reasons.push(`cutover_state=${cur} (need 'legacy' to start shadow)`);
    if (!c.webhook_secret) reasons.push("webhook_secret is NULL (release-gate C.2.6 hard-block)");
    if (!c.api_key) reasons.push("api_key is NULL (OAuth never completed)");
    const verdict = reasons.length === 0 ? "READY-FOR-SHADOW" : "BLOCKED";
    console.log(
      `  ${verdict}  ${c.platform.padEnd(12)} ${c.store_url ?? "(no url)"}  id=${c.id}`,
    );
    for (const r of reasons) console.log(`            - ${r}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
