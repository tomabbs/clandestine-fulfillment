/**
 * Seed minimal dev data for Settings pages.
 *
 * Run: npx tsx scripts/seed-dev-data.ts
 *
 * Requires: .env.local with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Creates (if missing):
 *   - 1 workspace
 *   - 1 organization
 *   - 1 Bandcamp connection (pending)
 *   - 1 Store connection (pending)
 *   - 1 ShipStation store mapping (manual - no API call)
 *
 * Safe to re-run — uses upsert/ON CONFLICT where possible.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const ORG_ID = "00000000-0000-0000-0000-000000000002";

async function main() {
  console.log("Seeding dev data...\n");

  // 1. Workspace
  const { error: wsErr } = await supabase.from("workspaces").upsert(
    {
      id: WORKSPACE_ID,
      name: "Dev Workspace",
      slug: "dev",
    },
    { onConflict: "id" },
  );
  if (wsErr) {
    console.error("Workspace:", wsErr.message);
  } else {
    console.log("✓ Workspace");
  }

  // 2. Organization
  const { error: orgErr } = await supabase.from("organizations").upsert(
    {
      id: ORG_ID,
      workspace_id: WORKSPACE_ID,
      name: "Test Label",
      slug: "test-label",
    },
    { onConflict: "id" },
  );
  if (orgErr) {
    console.error("Organization:", orgErr.message);
  } else {
    console.log("✓ Organization");
  }

  // 3. Bandcamp connection
  const { error: bcErr } = await supabase.from("bandcamp_connections").upsert(
    {
      workspace_id: WORKSPACE_ID,
      org_id: ORG_ID,
      band_id: 1430196613,
      band_name: "Test Band",
      band_url: "https://testband.bandcamp.com",
      is_active: true,
    },
    { onConflict: "workspace_id,band_id" },
  );
  if (bcErr) {
    console.error("Bandcamp connection:", bcErr.message);
  } else {
    console.log("✓ Bandcamp connection");
  }

  // 4. Store connection (pending) — only if none exists for this org
  const { data: existingConn } = await supabase
    .from("client_store_connections")
    .select("id")
    .eq("org_id", ORG_ID)
    .limit(1)
    .maybeSingle();

  if (!existingConn) {
    const { error: scErr } = await supabase.from("client_store_connections").insert({
      workspace_id: WORKSPACE_ID,
      org_id: ORG_ID,
      platform: "shopify",
      store_url: "https://test-store.myshopify.com",
      connection_status: "pending",
      do_not_fanout: true,
    });

    if (scErr) {
      console.error("Store connection:", scErr.message);
    } else {
      console.log("✓ Store connection");
    }
  } else {
    console.log("✓ Store connection (already exists)");
  }

  // 5. ShipStation store (manual - no API)
  const { error: ssErr } = await supabase.from("warehouse_shipstation_stores").upsert(
    {
      workspace_id: WORKSPACE_ID,
      store_id: 12345,
      store_name: "Test Store (Shopify)",
      marketplace_name: "Shopify",
      org_id: ORG_ID,
    },
    { onConflict: "workspace_id,store_id" },
  );
  if (ssErr) {
    console.error("ShipStation store:", ssErr.message);
  } else {
    console.log("✓ ShipStation store mapping");
  }

  console.log("\nDone. Visit /admin/settings/* to see the data.");
  console.log("Note: Ensure your staff user has workspace_id =", WORKSPACE_ID);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
