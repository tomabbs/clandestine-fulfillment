/**
 * Phase 3 Pass 2 soak — inspect Northern Spy Shopify auth state before
 * deciding which webhook_secret value to persist.
 *
 * Read-only. No writes.
 *
 * Usage:
 *   pnpm tsx scripts/_phase3-inspect-northern-spy-secrets.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

const NORTHERN_SPY_SHOPIFY_CONN_ID = "93225922-357f-4607-a5a4-2c1ad3a9beac";

async function main() {
  const sb = createServiceRoleClient();

  const { data: conn, error } = await sb
    .from("client_store_connections")
    .select(
      "id, store_url, shopify_verified_domain, platform, connection_status, do_not_fanout, cutover_state, api_key, shopify_app_client_id, shopify_app_client_secret_encrypted, webhook_secret, default_location_id, last_webhook_at, metadata",
    )
    .eq("id", NORTHERN_SPY_SHOPIFY_CONN_ID)
    .single();
  if (error || !conn) {
    console.error("lookup failed:", error);
    process.exit(1);
  }

  // Redact long secret fields for safety in console output.
  const redact = (v: string | null) =>
    !v ? "(null)" : `${v.slice(0, 4)}…${v.slice(-4)} (len=${v.length})`;

  console.log("Northern Spy Shopify connection — auth state");
  console.log("──────────────────────────────────────────────");
  console.log(`  id                              : ${conn.id}`);
  console.log(`  store_url                       : ${conn.store_url}`);
  console.log(`  shopify_verified_domain         : ${conn.shopify_verified_domain ?? "(null)"}`);
  console.log(`  platform                        : ${conn.platform}`);
  console.log(`  connection_status               : ${conn.connection_status}`);
  console.log(`  do_not_fanout                   : ${conn.do_not_fanout}`);
  console.log(`  cutover_state                   : ${conn.cutover_state}`);
  console.log(`  default_location_id             : ${conn.default_location_id ?? "(null)"}`);
  console.log(`  last_webhook_at                 : ${conn.last_webhook_at ?? "(null)"}`);
  console.log(`  api_key (Shopify token)         : ${redact(conn.api_key as string | null)}`);
  console.log(
    `  shopify_app_client_id           : ${conn.shopify_app_client_id ?? "(null)"}`,
  );
  console.log(
    `  shopify_app_client_secret       : ${redact(
      conn.shopify_app_client_secret_encrypted as string | null,
    )}`,
  );
  console.log(`  webhook_secret                  : ${redact(conn.webhook_secret as string | null)}`);

  const envSecret = process.env.SHOPIFY_CLIENT_SECRET ?? null;
  console.log(`  env.SHOPIFY_CLIENT_SECRET       : ${redact(envSecret)}`);

  console.log(
    `  metadata.webhook_subscriptions  : ${
      Array.isArray((conn.metadata as { webhook_subscriptions?: unknown[] } | null)?.webhook_subscriptions)
        ? `${((conn.metadata as { webhook_subscriptions: unknown[] }).webhook_subscriptions).length} entries`
        : "(none)"
    }`,
  );
  console.log(
    `  metadata.webhook_register_failures: ${
      ((conn.metadata as { webhook_register_failures?: unknown[] } | null)?.webhook_register_failures
        ? "present"
        : "(none)")
    }`,
  );

  console.log();
  console.log("Decision matrix for webhook_secret population:");
  if (conn.shopify_app_client_secret_encrypted) {
    console.log("  → CHOICE: per-connection app secret (HRD-35 path).");
    console.log("    webhook_secret = shopify_app_client_secret_encrypted");
  } else if (envSecret) {
    console.log("  → CHOICE: env.SHOPIFY_CLIENT_SECRET fallback (legacy single-app path).");
    console.log("    webhook_secret = env.SHOPIFY_CLIENT_SECRET");
  } else {
    console.log("  → BLOCKED: no per-connection secret AND no env fallback.");
    console.log("    Cannot resolve a Shopify HMAC secret \u2014 staff must run setShopifyAppCredentials first.");
  }

  if (!conn.api_key) {
    console.log();
    console.log(
      "BLOCKED on registerWebhookSubscriptions: api_key (Shopify access token) is NULL \u2014 OAuth install never completed.",
    );
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
