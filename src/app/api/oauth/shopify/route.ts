/**
 * Shopify OAuth route for client store connections.
 *
 * GET /api/oauth/shopify?shop=<domain>&org_id=<uuid>   → redirect to Shopify auth
 * GET /api/oauth/shopify?code=<code>&shop=<domain>&...  → callback, store token
 *
 * Security: HMAC verified with crypto.timingSafeEqual (M1 fix — timing-safe comparison).
 */

import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const SHOPIFY_SCOPES =
  "read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_fulfillments,write_fulfillments";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const shop = searchParams.get("shop");
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const hmac = searchParams.get("hmac");

  // ── Step 1: Initiate OAuth → redirect to Shopify ──────────────────────────
  if (shop && !code) {
    const orgId = searchParams.get("org_id");
    if (!orgId) {
      return NextResponse.json({ error: "org_id required" }, { status: 400 });
    }

    const stateToken = Buffer.from(JSON.stringify({ orgId, nonce: crypto.randomUUID() })).toString(
      "base64",
    );

    const authUrl =
      `https://${shop}/admin/oauth/authorize?` +
      new URLSearchParams({
        client_id: env().SHOPIFY_CLIENT_ID,
        scope: SHOPIFY_SCOPES,
        redirect_uri: `${env().NEXT_PUBLIC_APP_URL}/api/oauth/shopify`,
        state: stateToken,
      });

    return NextResponse.redirect(authUrl);
  }

  // ── Step 2: Callback with code ────────────────────────────────────────────
  if (code && shop && state && hmac) {
    // Verify HMAC with timing-safe comparison (M1 fix)
    const params = new URLSearchParams(searchParams);
    params.delete("hmac");
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const hash = crypto
      .createHmac("sha256", env().SHOPIFY_CLIENT_SECRET)
      .update(sortedParams)
      .digest("hex");

    const hashBuffer = Buffer.from(hash, "hex");
    const hmacBuffer = Buffer.from(hmac, "hex");

    if (
      hashBuffer.length !== hmacBuffer.length ||
      !crypto.timingSafeEqual(hashBuffer, hmacBuffer)
    ) {
      return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
    }

    // Exchange code for access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env().SHOPIFY_CLIENT_ID,
        client_secret: env().SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return NextResponse.json({ error: `Token exchange failed: ${body}` }, { status: 500 });
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const stateData = JSON.parse(Buffer.from(state, "base64").toString()) as { orgId: string };

    const supabase = createServiceRoleClient();
    const { data: org } = await supabase
      .from("organizations")
      .select("workspace_id")
      .eq("id", stateData.orgId)
      .single();

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    await supabase.from("client_store_connections").upsert(
      {
        workspace_id: org.workspace_id,
        org_id: stateData.orgId,
        platform: "shopify",
        store_url: `https://${shop}`,
        api_key: access_token,
        connection_status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,platform,store_url" },
    );

    return NextResponse.redirect(`${env().NEXT_PUBLIC_APP_URL}/portal/stores?connected=shopify`);
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
