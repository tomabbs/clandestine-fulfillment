/**
 * Phase 3 Pass 2 soak — register Shopify webhook subscriptions for the
 * Northern Spy connection AND populate `webhook_secret` so the Phase 3
 * release-gate C.2.6 hard-block clears.
 *
 * Why both in one pass: `registerWebhookSubscriptions` only mutates
 * Shopify-side subscription rows + persists subscription IDs into
 * `metadata.webhook_subscriptions`. It does NOT set `webhook_secret`.
 * For Shopify, the inbound `X-Shopify-Hmac-SHA256` header is signed by
 * the **app's Client Secret** (HRD-35 per-connection
 * `shopify_app_client_secret_encrypted` in our case, env fallback
 * `SHOPIFY_CLIENT_SECRET` for the legacy umbrella app), so
 * `webhook_secret` must be set to that same value for the
 * `/api/webhooks/client-store` Route Handler to validate signatures.
 *
 * Side effects when `--apply`:
 *   - HTTP POST to Shopify `webhookSubscriptionCreate` for the four
 *     required topics (idempotent — pre-existing tuples are reused).
 *   - UPDATE on `client_store_connections.metadata.webhook_subscriptions`
 *     and `webhook_secret`.
 *
 * Does NOT touch `do_not_fanout` (operator approval pending).
 *
 * Usage:
 *   pnpm tsx scripts/_phase3-register-northern-spy-webhooks.ts            # dry-run
 *   pnpm tsx scripts/_phase3-register-northern-spy-webhooks.ts --apply    # live
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  persistWebhookRegistrationMetadata,
  registerWebhookSubscriptions,
} from "@/lib/server/shopify-webhook-subscriptions";
import { env } from "@/lib/shared/env";

const NORTHERN_SPY_SHOPIFY_CONN_ID = "93225922-357f-4607-a5a4-2c1ad3a9beac";

function parseArgs(argv: string[]): { apply: boolean } {
  const out = { apply: false };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createServiceRoleClient();

  const { data: conn, error } = await sb
    .from("client_store_connections")
    .select(
      "id, store_url, shopify_verified_domain, platform, connection_status, do_not_fanout, cutover_state, api_key, shopify_app_client_id, shopify_app_client_secret_encrypted, webhook_secret",
    )
    .eq("id", NORTHERN_SPY_SHOPIFY_CONN_ID)
    .single();
  if (error || !conn) {
    console.error("connection lookup failed:", error);
    process.exit(1);
  }
  if (conn.platform !== "shopify") {
    console.error(`connection.platform=${conn.platform} (expected 'shopify')`);
    process.exit(1);
  }
  if (!conn.api_key) {
    console.error("connection.api_key is NULL — OAuth install never completed");
    process.exit(2);
  }

  // Resolve the HMAC secret (same algorithm as
  // resolveShopifyGdprWebhookSecrets, but for storefront topics).
  const perConnectionSecret = conn.shopify_app_client_secret_encrypted as string | null;
  const envSecret = env().SHOPIFY_CLIENT_SECRET as string | null;
  const resolvedSecret = perConnectionSecret ?? envSecret ?? null;
  const resolvedSource = perConnectionSecret
    ? "per_connection (HRD-35)"
    : envSecret
      ? "env.SHOPIFY_CLIENT_SECRET (legacy umbrella app)"
      : null;

  if (!resolvedSecret) {
    console.error(
      "BLOCKED: no per-connection Shopify app secret AND no env.SHOPIFY_CLIENT_SECRET — cannot resolve webhook_secret.",
    );
    process.exit(3);
  }

  // Use shopify_verified_domain when present (HRD-35 F-5 canonical form);
  // fall back to store_url for legacy rows where verified_domain is null.
  const storeUrl = conn.shopify_verified_domain
    ? `https://${conn.shopify_verified_domain}`
    : (conn.store_url as string);

  const callbackUrl = `${env().NEXT_PUBLIC_APP_URL}/api/webhooks/client-store?connection_id=${conn.id}&platform=shopify`;

  console.log("Phase 3 Pass 2 soak — Northern Spy webhook registration");
  console.log("──────────────────────────────────────────────────────");
  console.log(`  mode                : ${args.apply ? "APPLY (live writes)" : "DRY-RUN"}`);
  console.log(`  connection.id       : ${conn.id}`);
  console.log(`  store_url (effective): ${storeUrl}`);
  console.log(`  callbackUrl         : ${callbackUrl}`);
  console.log(`  webhook_secret src  : ${resolvedSource}`);
  console.log(
    `  webhook_secret      : ${resolvedSecret.slice(0, 4)}\u2026${resolvedSecret.slice(-4)} (len=${resolvedSecret.length})`,
  );
  console.log(
    `  current webhook_secret: ${conn.webhook_secret ? `${(conn.webhook_secret as string).slice(0, 4)}\u2026 (will overwrite if different)` : "(null)"}`,
  );
  console.log();

  if (!args.apply) {
    console.log("Re-run with --apply to register webhooks and persist webhook_secret.");
    return;
  }

  // 1. Register the four required webhook topics on Shopify.
  console.log("[1/3] Registering webhook subscriptions on Shopify\u2026");
  const result = await registerWebhookSubscriptions(
    { storeUrl, accessToken: conn.api_key as string },
    callbackUrl,
  );
  console.log(`      registered: ${result.registered.length}, failed: ${result.failed.length}`);
  for (const r of result.registered) {
    console.log(
      `        \u2713 ${r.topic.padEnd(28)} apiVersion=${r.apiVersion}  reused=${r.reused}  id=${r.id}`,
    );
  }
  for (const f of result.failed) {
    console.log(`        \u2717 ${f.topic.padEnd(28)} error=${f.error}`);
  }

  // 2. Persist subscription metadata (mirrors OAuth callback path).
  console.log("[2/3] Persisting subscription metadata\u2026");
  const persisted = await persistWebhookRegistrationMetadata(sb, conn.id, result, callbackUrl);
  console.log(
    `      apiVersionPinned=${persisted.apiVersionPinned}  apiVersionDrift=${persisted.apiVersionDrift}  registeredAt=${persisted.registeredAt}`,
  );

  // 3. Set webhook_secret so the inbound HMAC verification engages.
  // PHASE 3 release-gate C.2.6 requires this non-NULL before shadow.
  console.log("[3/3] Setting client_store_connections.webhook_secret\u2026");
  const { error: updErr } = await sb
    .from("client_store_connections")
    .update({
      webhook_secret: resolvedSecret,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conn.id);
  if (updErr) {
    console.error("      UPDATE failed:", updErr);
    process.exit(4);
  }
  console.log("      \u2713 webhook_secret persisted.");

  // Final post-state echo.
  const { data: post } = await sb
    .from("client_store_connections")
    .select("webhook_secret, do_not_fanout, cutover_state, metadata")
    .eq("id", conn.id)
    .single();
  console.log();
  console.log("Post-state:");
  console.log(`  webhook_secret           : ${post?.webhook_secret ? "SET" : "NULL"}`);
  console.log(`  do_not_fanout            : ${post?.do_not_fanout} (unchanged \u2014 separate runbook step)`);
  console.log(`  cutover_state            : ${post?.cutover_state} (unchanged)`);
  console.log(
    `  metadata.webhook_subscriptions: ${
      Array.isArray((post?.metadata as { webhook_subscriptions?: unknown[] } | null)?.webhook_subscriptions)
        ? `${((post?.metadata as { webhook_subscriptions: unknown[] }).webhook_subscriptions).length} entries`
        : "(none)"
    }`,
  );
  console.log();
  console.log(
    "Next step: confirm Shopify is delivering webhooks (last_webhook_at populates), THEN ask before clearing do_not_fanout=false and flipping cutover_state=shadow.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
