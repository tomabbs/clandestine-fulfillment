/**
 * Squarespace OAuth route for client store connections.
 *
 * GET /api/oauth/squarespace?org_id=<uuid>          → redirect to Squarespace auth
 * GET /api/oauth/squarespace?code=<code>&state=...  → callback, store tokens
 *
 * Stores:
 *   api_key      = access_token
 *   api_secret   = refresh_token
 *   metadata.token_expires_at = ISO string for refresh scheduling
 */

import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const SQUARESPACE_SCOPES =
  "website.orders,website.orders.read,website.inventory,website.inventory.read";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // ── Step 1: Initiate OAuth → redirect to Squarespace ─────────────────────
  if (!code) {
    const orgId = searchParams.get("org_id");
    if (!orgId) {
      return NextResponse.json({ error: "org_id required" }, { status: 400 });
    }

    const stateToken = Buffer.from(JSON.stringify({ orgId, nonce: crypto.randomUUID() })).toString(
      "base64",
    );

    const authUrl =
      `https://login.squarespace.com/api/1/login/oauth/provider/authorize?` +
      new URLSearchParams({
        client_id: env().SQUARESPACE_CLIENT_ID,
        redirect_uri: `${env().NEXT_PUBLIC_APP_URL}/api/oauth/squarespace`,
        scope: SQUARESPACE_SCOPES,
        state: stateToken,
        access_type: "offline",
      });

    return NextResponse.redirect(authUrl);
  }

  // ── Step 2: Callback with code ────────────────────────────────────────────
  if (code && state) {
    const tokenRes = await fetch(
      "https://login.squarespace.com/api/1/login/oauth/provider/tokens",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${env().NEXT_PUBLIC_APP_URL}/api/oauth/squarespace`,
          client_id: env().SQUARESPACE_CLIENT_ID,
          client_secret: env().SQUARESPACE_CLIENT_SECRET,
        }),
      },
    );

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return NextResponse.json({ error: `Token exchange failed: ${body}` }, { status: 500 });
    }

    const { access_token, refresh_token, expires_in } = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

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

    // Get website URL from Squarespace
    let storeUrl = "";
    try {
      const siteRes = await fetch("https://api.squarespace.com/1.0/authorization/website", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const siteData = (await siteRes.json()) as { website?: { url?: string } };
      storeUrl = siteData.website?.url ?? "";
    } catch {
      // Non-fatal — store URL can be set manually later
    }

    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    await supabase.from("client_store_connections").upsert(
      {
        workspace_id: org.workspace_id,
        org_id: stateData.orgId,
        platform: "squarespace",
        store_url: storeUrl,
        api_key: access_token,
        api_secret: refresh_token,
        metadata: { token_expires_at: tokenExpiresAt },
        connection_status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,platform,store_url" },
    );

    return NextResponse.redirect(
      `${env().NEXT_PUBLIC_APP_URL}/portal/stores?connected=squarespace`,
    );
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
