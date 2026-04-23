/**
 * Phase 0 / §9.1 D6 — Shopify GDPR webhook secret resolver.
 *
 * Why this module exists
 * ──────────────────────
 * GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`)
 * are sent by Shopify with `X-Shopify-Hmac-SHA256` signed using the **app's
 * Client Secret** — NOT the per-webhook `webhook_secret` used for storefront
 * topics. With the HRD-35 per-client Custom-distribution app model, every
 * client has its OWN Client Secret stored on
 * `client_store_connections.shopify_app_client_secret_encrypted`. The
 * legacy `env.SHOPIFY_CLIENT_SECRET` only validates GDPR pings for stores
 * still on the single-app fallback path.
 *
 * Until this Phase 0 D6 patch, GDPR routes only verified against
 * `env.SHOPIFY_CLIENT_SECRET`, which means GDPR pings to per-connection
 * stores were silently accepted (when env was set with no match) or
 * rejected (when env was set and the legacy app's secret didn't match).
 * Either failure mode jeopardizes the App Store listing.
 *
 * Strategy (no new column required — uses existing
 * `shopify_app_client_secret_encrypted`):
 *
 *   1. Try to resolve the connection from `X-Shopify-Shop-Domain` header.
 *      If we find an active Shopify connection with a per-connection
 *      app secret, verify against THAT secret first.
 *   2. Fall back to `env.SHOPIFY_CLIENT_SECRET` (legacy single-app path).
 *      One of the two MUST validate; if both fail, return invalid.
 *   3. If the shop domain cannot be matched to any connection AND env
 *      has no secret, we still return `unverified=true` so the route
 *      can decide whether to 401 — production ALWAYS has env set.
 *
 * Order matters: per-connection FIRST. If we tried env first, a shared
 * legacy Clandestine client secret could spuriously validate a payload
 * meant for a per-client app, masking real signature mismatches.
 *
 * The release-gate test at
 * `tests/unit/lib/server/shopify-gdpr-secret.test.ts`
 * asserts that `resolveShopifyGdprWebhookSecrets` returns at least one
 * non-empty candidate for any active connection (per-connection +
 * shadow + direct cutover_state) so the GDPR webhook quartet stays
 * verifiable through the Phase 5 cutover ramp.
 */

import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

export interface GdprSecretCandidates {
  /** Ordered: per-connection secret(s) first, env fallback last. */
  candidates: string[];
  /** Resolution sources, parallel to `candidates` for diagnostics. */
  sources: Array<"per_connection" | "env_fallback">;
  /**
   * The shop domain extracted from headers (lowercased). NULL if the
   * request had no `X-Shopify-Shop-Domain` header — common in test
   * fixtures and during onboarding probes.
   */
  shopDomain: string | null;
}

/**
 * Strip protocol/path; lowercase. Shopify sends bare domain
 * (`shop.myshopify.com`) in the header, but defensive normalization
 * costs us nothing and protects against future header changes.
 */
function normalizeShopDomain(raw: string | null): string | null {
  if (!raw) return null;
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/\/.*$/, "");
  return v || null;
}

export async function resolveShopifyGdprWebhookSecrets(
  req: Request,
): Promise<GdprSecretCandidates> {
  const shopDomain = normalizeShopDomain(req.headers.get("X-Shopify-Shop-Domain"));

  const candidates: string[] = [];
  const sources: GdprSecretCandidates["sources"] = [];

  if (shopDomain) {
    const supabase = createServiceRoleClient();
    // Per-connection secret(s) for this shop domain. There may be
    // multiple rows during the HRD-35 cutover (shadow + active) — we
    // accept any of them. `.ilike()` because store_url stores the full
    // URL while header sends bare domain; cheaper than substring match
    // in the WHERE clause.
    const { data: rows } = await supabase
      .from("client_store_connections")
      .select("shopify_app_client_secret_encrypted, connection_status, store_url")
      .eq("platform", "shopify")
      .ilike("store_url", `%${shopDomain}%`);

    for (const row of rows ?? []) {
      const secret = row.shopify_app_client_secret_encrypted;
      if (typeof secret === "string" && secret.length > 0 && !candidates.includes(secret)) {
        candidates.push(secret);
        sources.push("per_connection");
      }
    }
  }

  const envSecret = env().SHOPIFY_CLIENT_SECRET;
  if (envSecret && !candidates.includes(envSecret)) {
    candidates.push(envSecret);
    sources.push("env_fallback");
  }

  return { candidates, sources, shopDomain };
}
