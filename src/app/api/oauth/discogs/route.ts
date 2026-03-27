/**
 * Discogs OAuth 1.0a route for client store connections.
 *
 * GET /api/oauth/discogs?org_id=<uuid>                        → get request token, redirect
 * GET /api/oauth/discogs?oauth_token=<t>&oauth_verifier=<v>   → callback, exchange for access token
 *
 * CRITICAL: Stores OAuth state in `oauth_states` DB table.
 * OAuth 1.0a strips custom URL params on the Discogs callback, so state CANNOT
 * be passed via query string — it must be persisted in the database. (C2 fix)
 */

import { type NextRequest, NextResponse } from "next/server";
import OAuth from "oauth-1.0a";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

function buildOAuthClient(): OAuth {
  return new OAuth({
    consumer: {
      key: env().DISCOGS_CONSUMER_KEY,
      secret: env().DISCOGS_CONSUMER_SECRET,
    },
    signature_method: "PLAINTEXT",
    hash_function(_baseString, key) {
      return key;
    },
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const oauthToken = searchParams.get("oauth_token");
  const oauthVerifier = searchParams.get("oauth_verifier");
  const supabase = createServiceRoleClient();

  // ── Step 1: Get request token + redirect to Discogs ───────────────────────
  if (!oauthToken) {
    const orgId = searchParams.get("org_id");
    if (!orgId) {
      return NextResponse.json({ error: "org_id required" }, { status: 400 });
    }

    const oauth = buildOAuthClient();
    const callbackUrl = `${env().NEXT_PUBLIC_APP_URL}/api/oauth/discogs`;
    const requestTokenUrl = "https://api.discogs.com/oauth/request_token";

    const authHeader = oauth.toHeader(
      oauth.authorize({
        url: requestTokenUrl,
        method: "GET",
        data: { oauth_callback: callbackUrl },
      }),
    );

    const res = await fetch(requestTokenUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader.Authorization,
        "User-Agent": "ClandestineFulfillment/1.0",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `Request token failed: ${text}` }, { status: 500 });
    }

    const responseText = await res.text();
    const params = new URLSearchParams(responseText);
    const requestToken = params.get("oauth_token");
    const requestTokenSecret = params.get("oauth_token_secret");

    if (!requestToken || !requestTokenSecret) {
      return NextResponse.json({ error: "Invalid request token response" }, { status: 500 });
    }

    // Store state in DB — OAuth 1.0a strips query params so URL state is unreliable (C2 fix)
    await supabase.from("oauth_states").insert({
      oauth_token: requestToken,
      org_id: orgId,
      request_token_secret: requestTokenSecret,
      platform: "discogs",
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    return NextResponse.redirect(`https://discogs.com/oauth/authorize?oauth_token=${requestToken}`);
  }

  // ── Step 2: Callback with oauth_token + oauth_verifier ────────────────────
  if (oauthToken && oauthVerifier) {
    // Look up stored state from DB
    const { data: storedState, error: stateError } = await supabase
      .from("oauth_states")
      .select("*")
      .eq("oauth_token", oauthToken)
      .single();

    if (stateError || !storedState) {
      return NextResponse.json({ error: "OAuth state not found or expired" }, { status: 400 });
    }

    // Delete used state immediately
    await supabase.from("oauth_states").delete().eq("id", storedState.id);

    if (new Date(storedState.expires_at) < new Date()) {
      return NextResponse.json({ error: "OAuth state expired" }, { status: 400 });
    }

    // Exchange for access token
    const oauth = buildOAuthClient();
    const accessTokenUrl = "https://api.discogs.com/oauth/access_token";
    const requestToken = { key: oauthToken, secret: storedState.request_token_secret };

    const accessAuthHeader = oauth.toHeader(
      oauth.authorize(
        { url: accessTokenUrl, method: "POST", data: { oauth_verifier: oauthVerifier } },
        requestToken,
      ),
    );

    const accessRes = await fetch(accessTokenUrl, {
      method: "POST",
      headers: {
        Authorization: accessAuthHeader.Authorization,
        "User-Agent": "ClandestineFulfillment/1.0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `oauth_verifier=${oauthVerifier}`,
    });

    if (!accessRes.ok) {
      const text = await accessRes.text();
      return NextResponse.json({ error: `Access token failed: ${text}` }, { status: 500 });
    }

    const accessText = await accessRes.text();
    const accessParams = new URLSearchParams(accessText);
    const accessToken = accessParams.get("oauth_token");
    const accessTokenSecret = accessParams.get("oauth_token_secret");

    if (!accessToken || !accessTokenSecret) {
      return NextResponse.json({ error: "Invalid access token response" }, { status: 500 });
    }

    // Get Discogs user identity
    const identityToken = { key: accessToken, secret: accessTokenSecret };
    const identityUrl = "https://api.discogs.com/oauth/identity";
    const identityHeader = oauth.toHeader(
      oauth.authorize({ url: identityUrl, method: "GET" }, identityToken),
    );

    const identityRes = await fetch(identityUrl, {
      headers: {
        Authorization: identityHeader.Authorization,
        "User-Agent": "ClandestineFulfillment/1.0",
      },
    });

    const identity = (await identityRes.json()) as { username: string; id: number };

    const { data: org } = await supabase
      .from("organizations")
      .select("workspace_id")
      .eq("id", storedState.org_id)
      .single();

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // Upsert — one Discogs connection per org (unique index on org_id, platform WHERE platform='discogs')
    await supabase.from("client_store_connections").upsert(
      {
        workspace_id: org.workspace_id,
        org_id: storedState.org_id,
        platform: "discogs",
        store_url: `https://www.discogs.com/seller/${identity.username}`,
        api_key: accessToken,
        api_secret: accessTokenSecret,
        metadata: {
          discogs_username: identity.username,
          discogs_user_id: identity.id,
        },
        connection_status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,platform" },
    );

    return NextResponse.redirect(`${env().NEXT_PUBLIC_APP_URL}/portal/stores?connected=discogs`);
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
