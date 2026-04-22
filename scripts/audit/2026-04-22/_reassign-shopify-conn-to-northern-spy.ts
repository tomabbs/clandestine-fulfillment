/**
 * One-off fix: the Shopify connection 93225922-357f-4607-a5a4-2c1ad3a9beac
 * (store_url=https://2b65b8-2.myshopify.com) was created during the
 * direct-Shopify OAuth pivot under the "True Panther" org by mistake.
 *
 * The shop is actually the operator-controlled "Northern Spy Label Group"
 * Partner dev-store, which belongs to the existing org "Northern Spy Records"
 * (id=4d778a4e-ff30-40ae-bec3-74f4042ce862).
 *
 * Per inspection (scripts/_inspect-northern-spy-org.ts):
 *  - 0 client_store_sku_mappings rows → safe to reassign with no data fanout.
 *  - No UNIQUE collision on idx_store_connections_org_platform_url
 *    (Northern Spy Records currently has only a WooCommerce conn).
 *
 * This script is idempotent: re-running it after success is a no-op.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const CONN_ID = "93225922-357f-4607-a5a4-2c1ad3a9beac";
const FROM_ORG_ID = "4350cb01-8c7e-48eb-9eba-cb8e818de46d"; // True Panther
const TO_ORG_ID = "4d778a4e-ff30-40ae-bec3-74f4042ce862"; // Northern Spy Records

async function main() {
  const sb = createServiceRoleClient();

  const { data: before, error: readErr } = await sb
    .from("client_store_connections")
    .select("id, org_id, platform, store_url, metadata")
    .eq("id", CONN_ID)
    .single();

  if (readErr || !before) {
    throw new Error(`Could not load connection ${CONN_ID}: ${readErr?.message ?? "not found"}`);
  }

  console.log("BEFORE:", JSON.stringify(before, null, 2));

  if (before.org_id === TO_ORG_ID) {
    console.log("\n✓ Connection already owned by Northern Spy Records — nothing to do.");
    return;
  }

  if (before.org_id !== FROM_ORG_ID) {
    throw new Error(
      `Refusing to reassign: expected current org_id=${FROM_ORG_ID}, got ${before.org_id}.`,
    );
  }

  const { count: collisionCount, error: collisionErr } = await sb
    .from("client_store_connections")
    .select("id", { count: "exact", head: true })
    .eq("org_id", TO_ORG_ID)
    .eq("platform", before.platform)
    .eq("store_url", before.store_url);

  if (collisionErr) {
    throw new Error(`Collision pre-check failed: ${collisionErr.message}`);
  }
  if ((collisionCount ?? 0) > 0) {
    throw new Error(
      `Refusing to reassign: target org ${TO_ORG_ID} already has a row for ` +
        `(${before.platform}, ${before.store_url}). Resolve manually first.`,
    );
  }

  const newMetadata = {
    ...(before.metadata ?? {}),
    org_reassignment_history: [
      ...((before.metadata as { org_reassignment_history?: unknown[] } | null)
        ?.org_reassignment_history ?? []),
      {
        from_org_id: FROM_ORG_ID,
        to_org_id: TO_ORG_ID,
        at: new Date().toISOString(),
        reason:
          "OAuth pivot: shop is Northern Spy Label Group Partner dev-store, not True Panther",
      },
    ],
  };

  const { data: after, error: updErr } = await sb
    .from("client_store_connections")
    .update({ org_id: TO_ORG_ID, metadata: newMetadata })
    .eq("id", CONN_ID)
    .select("id, org_id, platform, store_url, metadata")
    .single();

  if (updErr || !after) {
    throw new Error(`Update failed: ${updErr?.message ?? "no row returned"}`);
  }

  console.log("\nAFTER:", JSON.stringify(after, null, 2));

  const { data: verify } = await sb
    .from("client_store_connections")
    .select("id, org_id, platform, store_url")
    .eq("org_id", TO_ORG_ID)
    .order("platform");
  console.log("\nNorthern Spy Records connections now:");
  console.log(JSON.stringify(verify, null, 2));

  console.log("\n✓ Reassignment complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
