/**
 * WooCommerce OAuth 1.0a authorization callback.
 *
 * After the store owner approves the connection, WooCommerce POSTs the
 * generated API keys here. WooCommerce sends different body formats
 * depending on version — this handler accepts both JSON and form-encoded.
 *
 * WooCommerce POST body fields:
 *   key_id           — the key's DB ID (ignored)
 *   user_id          — the WordPress user ID (ignored; we use org_id from query)
 *   consumer_key     — full key starting with ck_
 *   consumer_secret  — full secret starting with cs_
 *   key_permissions  — "read_write"
 *
 * org_id and store_url are passed as query params since WooCommerce
 * doesn't include them in the POST body.
 */

import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const storeUrl = searchParams.get("store_url");
  const orgId = searchParams.get("org_id");

  if (!storeUrl || !orgId) {
    return NextResponse.json({ error: "Missing store_url or org_id" }, { status: 400 });
  }

  // Parse body — WooCommerce sends form-encoded or JSON depending on version
  let consumerKey: string | undefined;
  let consumerSecret: string | undefined;

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const rawText = await request.text();

    if (contentType.includes("application/json")) {
      const json = JSON.parse(rawText) as Record<string, string>;
      consumerKey = json.consumer_key;
      consumerSecret = json.consumer_secret;
    } else {
      // application/x-www-form-urlencoded (most common)
      const params = new URLSearchParams(rawText);
      consumerKey = params.get("consumer_key") ?? undefined;
      consumerSecret = params.get("consumer_secret") ?? undefined;
    }
  } catch {
    return NextResponse.json({ error: "Failed to parse request body" }, { status: 400 });
  }

  if (!consumerKey || !consumerSecret) {
    return NextResponse.json({ error: "Missing consumer_key or consumer_secret" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("workspace_id")
    .eq("id", orgId)
    .single();

  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const baseUrl = storeUrl.replace(/\/$/, "");

  const { error: upsertError } = await supabase.from("client_store_connections").upsert(
    {
      workspace_id: org.workspace_id,
      org_id: orgId,
      platform: "woocommerce",
      store_url: baseUrl,
      api_key: consumerKey,
      api_secret: consumerSecret,
      connection_status: "active",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,platform,store_url" },
  );

  if (upsertError) {
    console.error("[woocommerce/callback] Upsert failed:", upsertError.message);
    return NextResponse.json(
      { error: `Failed to save connection: ${upsertError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
