import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();

  console.log("=== client_store_connections matching northern spy / 2b65b8 ===");
  const { data: conns, error: connErr } = await sb
    .from("client_store_connections")
    .select(
      "id, org_id, workspace_id, platform, store_url, connection_status, do_not_fanout, default_location_id, created_at, metadata",
    )
    .or("store_url.ilike.%2b65b8%,store_url.ilike.%northern%");
  if (connErr) console.error("conn err:", connErr);
  console.log(JSON.stringify(conns, null, 2));

  console.log("\n=== ALL client_store_connections (workspace scope) ===");
  const { data: allConns } = await sb
    .from("client_store_connections")
    .select("id, org_id, workspace_id, platform, store_url, connection_status, created_at")
    .order("created_at", { ascending: false });
  console.log(JSON.stringify(allConns, null, 2));

  console.log("\n=== organizations table dump (workspace scope inferred from connections) ===");
  const wsIds = new Set((allConns ?? []).map((c) => c.workspace_id));
  for (const wsId of wsIds) {
    console.log(`\n  -- workspace_id=${wsId} --`);
    const { data: orgs } = await sb
      .from("organizations")
      .select("id, name, slug, parent_org_id, billing_email, created_at")
      .eq("workspace_id", wsId)
      .order("name");
    console.log(JSON.stringify(orgs, null, 2));
  }

  console.log("\n=== organization_aliases (matching northern / true panther) ===");
  const { data: aliases } = await sb
    .from("organization_aliases")
    .select("id, org_id, alias_name, source, workspace_id")
    .or("alias_name.ilike.%northern%,alias_name.ilike.%true panther%");
  console.log(JSON.stringify(aliases, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
