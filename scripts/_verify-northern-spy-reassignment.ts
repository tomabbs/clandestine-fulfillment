import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const TRUE_PANTHER_ORG = "4350cb01-8c7e-48eb-9eba-cb8e818de46d";
const TRUE_PANTHER_RECORDS_ORG = "147804c0-3fd2-405a-a888-a1f5223a1673";
const NORTHERN_SPY_ORG = "4d778a4e-ff30-40ae-bec3-74f4042ce862";
const CONN_ID = "93225922-357f-4607-a5a4-2c1ad3a9beac";

async function main() {
  const sb = createServiceRoleClient();

  console.log("=== oauth_states for shop=2b65b8-2.myshopify.com OR org=true-panther ===");
  const { data: oauthStates } = await sb
    .from("oauth_states")
    .select("*")
    .or(
      `shop.eq.2b65b8-2.myshopify.com,org_id.eq.${TRUE_PANTHER_ORG},org_id.eq.${TRUE_PANTHER_RECORDS_ORG}`,
    );
  console.log(JSON.stringify(oauthStates, null, 2));

  console.log("\n=== webhook_events for connection_id=93225922 ===");
  const { count: weCount } = await sb
    .from("webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", CONN_ID);
  console.log("count:", weCount);

  console.log("\n=== client_store_connections owned by True Panther orgs (should be empty) ===");
  const { data: tpConns } = await sb
    .from("client_store_connections")
    .select("id, org_id, platform, store_url, connection_status")
    .in("org_id", [TRUE_PANTHER_ORG, TRUE_PANTHER_RECORDS_ORG]);
  console.log(JSON.stringify(tpConns, null, 2));

  console.log("\n=== client_store_connections owned by Northern Spy Records ===");
  const { data: nsConns } = await sb
    .from("client_store_connections")
    .select("id, org_id, platform, store_url, connection_status, default_location_id")
    .eq("org_id", NORTHERN_SPY_ORG);
  console.log(JSON.stringify(nsConns, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
