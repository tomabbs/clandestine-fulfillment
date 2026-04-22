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
import { verifyShopDomain } from "@/lib/server/shopify-shop-verify";
import {
  persistWebhookRegistrationMetadata,
  registerWebhookSubscriptions,
} from "@/lib/server/shopify-webhook-subscriptions";
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
 * `write_merchant_managed_fulfillment_orders` is the GraphQL fulfillmentCreate
 * scope (HRD-28); the legacy `write_fulfillments` REST scope is also kept for
 * the existing REST fulfillment path until the GraphQL migration ships.
 *
 * NOTE on webhooks: there is NO `write_webhooks` scope in Shopify. Webhook
 * subscriptions (REST and GraphQL `webhookSubscriptionCreate`) are gated by
 * the underlying RESOURCE scope:
 *   - `inventory_levels/update`         → read_inventory
 *   - `orders/create` / `orders/cancelled` → read_orders
 *   - `refunds/create`                  → read_orders
 * All four topics required by HRD-09.2 are covered by scopes already in this
 * list, so the (deferred) `shopify-webhook-health-check` task does not need
 * any extra scope to call `webhookSubscriptionCreate`.
 *
 * Note: changing this list invalidates the consent for any existing connection
 * — Shopify forces a re-install when scopes diverge from the granted set.
 *
 * For Custom-distribution apps (HRD-35), the Shopify Partner Dashboard's
 * "Configuration → Access scopes" config must ALSO declare the same set; the
 * URL `scope=` param alone is silently trimmed to whatever the dashboard
 * config allows.
 */
const SHOPIFY_SCOPES =
  "read_products,write_products,read_inventory,write_inventory," +
  "read_orders,write_orders,read_all_orders," +
  "read_locations," +
  "read_fulfillments,write_fulfillments,write_merchant_managed_fulfillment_orders," +
  "write_publications";

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

    // Shopify token-exchange response per
    // https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/access-token-types#online-access-tokens
    // (`scope` is comma-separated and reflects the ACTUALLY granted scopes —
    // may be narrower than what we requested if the merchant declined some).
    const tokenJson = (await tokenRes.json()) as {
      access_token: string;
      scope?: string;
    };
    const accessToken = tokenJson.access_token;
    const grantedScopes = (tokenJson.scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const { data: org } = await supabase
      .from("organizations")
      .select("workspace_id")
      .eq("id", stateData.orgId)
      .single();

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // F-5 / HRD-10 — shop-domain verification. Issue a one-shot
    // `shop { myshopifyDomain }` GraphQL probe with the freshly-issued
    // access token; abort the install if the canonical domain Shopify
    // returns disagrees with the callback `?shop=` param.
    //
    // We run this BEFORE upserting the access token so a failed
    // verification leaves the existing row (if any) untouched. Mismatches
    // create a `warehouse_review_queue` row so repeat occurrences surface
    // as a clear attack signal — group_key is per-org+per-shop so the
    // dedup pattern groups attempts against the same victim.
    const verification = await verifyShopDomain({
      shopParam: shop,
      accessToken,
      apiVersion: env().SHOPIFY_API_VERSION,
    });
    if (verification.kind !== "ok") {
      // Persist a security review queue item — even benign mismatches
      // (operator pasted wrong creds) deserve operator visibility, and
      // repeat occurrences indicate an attacker probing the install flow.
      try {
        await supabase.from("warehouse_review_queue").insert({
          workspace_id: org.workspace_id,
          org_id: stateData.orgId,
          category: "security",
          severity: "high",
          group_key: `shop_token_mismatch:${stateData.orgId}:${shop}`,
          summary: `Shopify install rejected: shop-domain verification failed (${verification.kind})`,
          details: {
            kind: verification.kind,
            shop_param: shop,
            connection_id: stateData.connectionId ?? null,
            ...("expected" in verification && "actual" in verification
              ? { expected: verification.expected, actual: verification.actual }
              : {}),
            ...("status" in verification ? { graphql_status: verification.status } : {}),
          },
        });
      } catch {
        // Review-queue insert failure is non-fatal — the rejection itself
        // is the primary security action. Operators can still find the
        // attempt in Vercel logs.
      }
      return NextResponse.json(
        {
          error: "shop_verification_failed",
          reason: verification.kind,
        },
        { status: 401 },
      );
    }

    // Phase 0.8 dormancy default — every freshly-installed Shopify connection
    // lands with do_not_fanout=true so an accidental install can never push
    // inventory before staff verify SKU mappings + select a default location
    // + opt back into fanout via reactivateClientStoreConnection.
    //
    // F-5: persist `shopify_verified_domain` from the verification response
    // (canonical Shopify-issued form, not whatever shape arrived on the
    // callback URL) so future deliveries can be cross-checked.
    //
    // `.select("id").single()` is required so we can pass the connection id
    // into the webhook callback URL below (HRD-35 gap #3 auto-register).
    const { data: connRow, error: upsertErr } = await supabase
      .from("client_store_connections")
      .upsert(
        {
          workspace_id: org.workspace_id,
          org_id: stateData.orgId,
          platform: "shopify",
          store_url: `https://${verification.canonicalDomain}`,
          shopify_verified_domain: verification.canonicalDomain,
          api_key: accessToken,
          connection_status: "active",
          do_not_fanout: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "org_id,platform,store_url" },
      )
      .select("id")
      .single();

    if (upsertErr || !connRow) {
      return NextResponse.json(
        { error: `Failed to persist connection: ${upsertErr?.message ?? "no row returned"}` },
        { status: 500 },
      );
    }

    const connectionId = connRow.id as string;

    // ── HRD-35 gap #3 + HRD-09.2 — auto-register the four required webhook
    // topics RIGHT NOW so the connection is fully wired before the staff
    // operator hits the admin UI. Failures here do NOT abort the install (the
    // token is captured + persisted; staff can re-run via the manual button)
    // — they land on metadata.webhook_register_failures + the success-redirect
    // query string surfaces the partial state.
    let registerFailureCount = 0;
    try {
      const callbackUrl = `${env().NEXT_PUBLIC_APP_URL}/api/webhooks/client-store?connection_id=${connectionId}&platform=shopify`;
      // F-5: use the verified canonical domain everywhere downstream so a
      // case-mismatch or trailing-slash in the original install URL doesn't
      // poison the webhook subscription's myshopifyDomain reference.
      const result = await registerWebhookSubscriptions(
        { storeUrl: `https://${verification.canonicalDomain}`, accessToken },
        callbackUrl,
      );
      registerFailureCount = result.failed.length;

      // Persist scopes + app distribution + installed_at alongside the webhook
      // subscription IDs. Uses the same shared helper the staff-manual button
      // (`registerShopifyWebhookSubscriptions`) calls, so the metadata shape
      // stays in lockstep across the two entry points.
      await persistWebhookRegistrationMetadata(supabase, connectionId, result, callbackUrl, {
        shopifyScopes: grantedScopes,
        // Per-connection app credentials present → HRD-35 Custom-distribution.
        // Otherwise the env-fallback path (Clandestine-internal app or the
        // legacy single public app) is in play.
        appDistribution: stateData.connectionId ? "custom" : "public",
        installedAt: null,
      });
    } catch (err) {
      // Swallow but capture the error on metadata so staff can see it on the
      // connections page (the failed-button path will retry idempotently).
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("client_store_connections")
        .update({
          metadata: {
            webhook_register_failed_at: new Date().toISOString(),
            webhook_register_error: msg.slice(0, 500),
            shopify_scopes: grantedScopes,
            app_distribution: stateData.connectionId ? "custom" : "public",
            installed_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", connectionId);
      registerFailureCount = -1;
    }

    const successUrl = new URL(`${env().NEXT_PUBLIC_APP_URL}/admin/settings/store-connections`);
    successUrl.searchParams.set("connected", "shopify");
    successUrl.searchParams.set("connection_id", connectionId);
    if (registerFailureCount !== 0) {
      successUrl.searchParams.set(
        "webhook_register",
        registerFailureCount === -1 ? "error" : "partial",
      );
    }
    return NextResponse.redirect(successUrl.toString());
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
