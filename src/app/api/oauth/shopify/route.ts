/**
 * Shopify OAuth route for client store connections.
 *
 * GET /api/oauth/shopify?shop=<domain>&org_id=<uuid>[&connection_id=<uuid>]   → redirect to Shopify auth
 * GET /api/oauth/shopify?code=<code>&shop=<domain>&state=<token>&hmac=<hex>    → callback, store token
 *
 * Direct-Shopify cutover (HRD-35):
 *   - When `connection_id` is in state, the per-connection Custom-distribution
 *     app credentials on `client_store_connections.shopify_app_client_id` /
 *     `_secret_encrypted` are used. Otherwise the env vars `SHOPIFY_CLIENT_ID`
 *     / `SHOPIFY_CLIENT_SECRET` are used (legacy single-app fallback).
 *   - Newly-installed connections land with `do_not_fanout = true` (Phase 0.8
 *     dormancy default). Staff explicitly call `reactivateClientStoreConnection`
 *     after they've paired SKUs and selected a default location.
 *   - State nonce is stored in `oauth_states` (Section F of migration
 *     20260422000001) and verified on callback (HRD-35.1 — closes the CSRF gap).
 *
 * Security: HMAC verified with crypto.timingSafeEqual (M1 fix — timing-safe comparison).
 */

import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

export const runtime = "nodejs";

/**
 * HRD-25: final canonical scope set for direct-Shopify operation.
 *
 * `read_locations` enables `GET /admin/api/.../locations.json` so we can list
 * locations for the staff-side default-location picker.
 *
 * `read_all_orders` is required to read order history older than the default
 * 60-day window — necessary for cockpit backfill on long-tail clients.
 *
 * `write_webhooks` is required by the (deferred) `shopify-webhook-health-check`
 * task to recreate webhook subscriptions Shopify auto-deletes (HRD-09 / HRD-32).
 *
 * `write_merchant_managed_fulfillment_orders` is the GraphQL fulfillmentCreate
 * scope (HRD-28); the legacy `write_fulfillments` REST scope is also kept for
 * the existing REST fulfillment path until the GraphQL migration ships.
 *
 * Note: changing this list invalidates the consent for any existing connection
 * — Shopify forces a re-install when scopes diverge from the granted set.
 */
const SHOPIFY_SCOPES =
  "read_products,write_products,read_inventory,write_inventory," +
  "read_orders,write_orders,read_all_orders," +
  "read_locations," +
  "read_fulfillments,write_fulfillments,write_merchant_managed_fulfillment_orders," +
  "write_webhooks,write_publications";

const STATE_NONCE_TTL_MINUTES = 15;

/**
 * Decode a base64-encoded JSON state token. Tolerant of either the legacy
 * shape `{ orgId, nonce }` and the new HRD-35 shape `{ orgId, nonce, connectionId? }`.
 */
function decodeState(stateB64: string): { orgId: string; nonce: string; connectionId?: string } {
  const json = JSON.parse(Buffer.from(stateB64, "base64").toString());
  if (
    !json ||
    typeof json !== "object" ||
    typeof json.orgId !== "string" ||
    typeof json.nonce !== "string"
  ) {
    throw new Error("Invalid state shape");
  }
  return {
    orgId: json.orgId,
    nonce: json.nonce,
    connectionId: typeof json.connectionId === "string" ? json.connectionId : undefined,
  };
}

/**
 * Resolve the Client ID / Client Secret to use for a given connection. Returns
 * the per-connection Custom-distribution app credentials when both are set on
 * the connection row; falls back to env vars for the legacy single-app flow.
 */
async function resolveAppCredentials(
  connectionId: string | undefined,
): Promise<{ clientId: string; clientSecret: string; source: "per_connection" | "env_fallback" }> {
  if (connectionId) {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from("client_store_connections")
      .select("shopify_app_client_id, shopify_app_client_secret_encrypted")
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load connection app credentials: ${error.message}`);
    if (data?.shopify_app_client_id && data?.shopify_app_client_secret_encrypted) {
      return {
        clientId: data.shopify_app_client_id,
        clientSecret: data.shopify_app_client_secret_encrypted,
        source: "per_connection",
      };
    }
  }
  return {
    clientId: env().SHOPIFY_CLIENT_ID,
    clientSecret: env().SHOPIFY_CLIENT_SECRET,
    source: "env_fallback",
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const shop = searchParams.get("shop");
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const hmac = searchParams.get("hmac");

  // ── Step 1: Initiate OAuth → redirect to Shopify ──────────────────────────
  if (shop && !code) {
    const orgId = searchParams.get("org_id");
    const connectionId = searchParams.get("connection_id") ?? undefined;
    if (!orgId) {
      return NextResponse.json({ error: "org_id required" }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    // Resolve app credentials (per-connection or env fallback). We only need the
    // client_id at the redirect-construction stage — the secret is used in step 2.
    let appCreds: Awaited<ReturnType<typeof resolveAppCredentials>>;
    try {
      appCreds = await resolveAppCredentials(connectionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const nonce = crypto.randomUUID();
    const stateToken = Buffer.from(
      JSON.stringify({ orgId, nonce, ...(connectionId ? { connectionId } : {}) }),
    ).toString("base64");

    // HRD-35.1: store the nonce server-side so the callback can prove the
    // state didn't come from an attacker. The `oauth_states` row is partitioned
    // by `nonce_purpose='shopify_install'` so it never collides with the OAuth
    // 1.0a Discogs flow that shares this table.
    const { error: stateInsertErr } = await supabase.from("oauth_states").insert({
      oauth_token: nonce,
      org_id: orgId,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: connectionId ?? null,
      expires_at: new Date(Date.now() + STATE_NONCE_TTL_MINUTES * 60 * 1000).toISOString(),
    });
    if (stateInsertErr) {
      // This is a hard failure — without server-side state we cannot defend
      // against a forged callback in step 2.
      return NextResponse.json(
        { error: `Failed to persist OAuth state: ${stateInsertErr.message}` },
        { status: 500 },
      );
    }

    const authUrl =
      `https://${shop}/admin/oauth/authorize?` +
      new URLSearchParams({
        client_id: appCreds.clientId,
        scope: SHOPIFY_SCOPES,
        redirect_uri: `${env().NEXT_PUBLIC_APP_URL}/api/oauth/shopify`,
        state: stateToken,
      });

    return NextResponse.redirect(authUrl);
  }

  // ── Step 2: Callback with code ────────────────────────────────────────────
  if (code && shop && state && hmac) {
    let stateData: { orgId: string; nonce: string; connectionId?: string };
    try {
      stateData = decodeState(state);
    } catch {
      return NextResponse.json({ error: "Invalid state encoding" }, { status: 400 });
    }

    // Resolve credentials FIRST so HMAC verification uses the same secret that
    // signed the redirect (per-connection or env). Mismatch here = silent 401.
    let appCreds: Awaited<ReturnType<typeof resolveAppCredentials>>;
    try {
      appCreds = await resolveAppCredentials(stateData.connectionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const supabase = createServiceRoleClient();

    // HRD-35.1: state-nonce store-and-verify. The DELETE-after-SELECT pattern
    // makes the nonce single-use (replay-safe). expires_at filters out stale
    // rows — we don't bother with a sweeper task because the table stays small.
    const { data: stateRow, error: stateLookupErr } = await supabase
      .from("oauth_states")
      .select("id, expires_at, connection_id, org_id, nonce_purpose")
      .eq("oauth_token", stateData.nonce)
      .eq("nonce_purpose", "shopify_install")
      .maybeSingle();
    if (stateLookupErr) {
      return NextResponse.json(
        { error: `OAuth state lookup failed: ${stateLookupErr.message}` },
        { status: 500 },
      );
    }
    if (!stateRow) {
      return NextResponse.json({ error: "Unknown or expired state nonce" }, { status: 401 });
    }
    if (new Date(stateRow.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: "OAuth state nonce expired" }, { status: 401 });
    }
    if (stateRow.org_id !== stateData.orgId) {
      return NextResponse.json({ error: "OAuth state org mismatch" }, { status: 401 });
    }
    // Burn the nonce immediately — replay attempts after this point fail at the
    // lookup step above.
    await supabase.from("oauth_states").delete().eq("id", stateRow.id);

    // Verify HMAC with timing-safe comparison (M1 fix)
    const params = new URLSearchParams(searchParams);
    params.delete("hmac");
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const hash = crypto
      .createHmac("sha256", appCreds.clientSecret)
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

    // Exchange code for access token using the same app credentials.
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: appCreds.clientId,
        client_secret: appCreds.clientSecret,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return NextResponse.json({ error: `Token exchange failed: ${body}` }, { status: 500 });
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const { data: org } = await supabase
      .from("organizations")
      .select("workspace_id")
      .eq("id", stateData.orgId)
      .single();

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // Phase 0.8 dormancy default — every freshly-installed Shopify connection
    // lands with do_not_fanout=true so an accidental install can never push
    // inventory before staff verify SKU mappings + select a default location
    // + opt back into fanout via reactivateClientStoreConnection.
    await supabase.from("client_store_connections").upsert(
      {
        workspace_id: org.workspace_id,
        org_id: stateData.orgId,
        platform: "shopify",
        store_url: `https://${shop}`,
        api_key: access_token,
        connection_status: "active",
        do_not_fanout: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,platform,store_url" },
    );

    return NextResponse.redirect(
      `${env().NEXT_PUBLIC_APP_URL}/admin/settings/store-connections?connected=shopify`,
    );
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
