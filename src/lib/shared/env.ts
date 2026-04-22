import { z } from "zod";

const serverEnvSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  // Trigger.dev
  TRIGGER_SECRET_KEY: z.string().min(1),

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

  // Sentry
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1),
  SENTRY_ORG: z.string().min(1),
  SENTRY_PROJECT: z.string().min(1),
  SENTRY_AUTH_TOKEN: z.string().min(1),

  // Shopify
  SHOPIFY_STORE_URL: z.string().url(),
  SHOPIFY_ADMIN_API_TOKEN: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().default(""),

  // ShipStation v1 (legacy API — Basic auth; used by SKU-rectify alias path and
  // SHIP_NOTIFY webhook. Kept active because v2 has no equivalent for product
  // aliases or webhook signature secret. See plan §3 / §7.1.10.)
  SHIPSTATION_API_KEY: z.string().default(""),
  SHIPSTATION_API_SECRET: z.string().default(""),
  SHIPSTATION_WEBHOOK_SECRET: z.string().default(""),

  // ShipStation v2 (api.shipstation.com — `api-key` header, NOT Basic auth).
  // Used by the v2 inventory client (§7.1.6), seeding (Phase 3), reconcile
  // (Phase 5), and the SHIP_NOTIFY → fanout path (Phase 4). Required from
  // Phase 2 onward; default("") so the schema still parses in environments
  // (local dev, CI) where the key has not yet been provisioned.
  SHIPSTATION_V2_API_KEY: z.string().default(""),

  // EasyPost
  EASYPOST_API_KEY: z.string().default(""),
  // Asendia (USA Export PBA) carrier account ID — required for international rate
  // shopping. EP doesn't include Asendia in default rate responses; we must
  // pass this carrier_account_id explicitly. Different ID per environment
  // (prod vs sandbox). Default keeps the legacy hardcoded prod value so existing
  // deploys without the env var set don't break (Phase 0.5.3).
  EASYPOST_ASENDIA_CARRIER_ACCOUNT_ID: z.string().default("ca_0f7e073887204bd491a6230936baf754"),
  // Phase 10.2 — EasyPost Webhook signing secret (for tracker.* events at
  // /api/webhooks/easypost). REQUIRED in production; the route returns 500
  // when unset, by design (mirrors the SHIPSTATION_WEBHOOK_SECRET pattern).
  // EP uses HMAC-SHA256 with the raw request body. We prefer the v2 header
  // (`x-hmac-signature-v2`) which adds timestamp validation; v1
  // (`x-hmac-signature`) remains supported as a fallback for older webhook
  // configs that haven't been migrated. Default empty so dev/test runs.
  EASYPOST_WEBHOOK_SECRET: z.string().default(""),
  // Phase 12 — Resend webhook signing secret. REQUIRED in production.
  // Get from Resend dashboard → Webhooks → your endpoint. Format is
  // `whsec_<base64>` (Svix-compatible). Default empty so dev/test runs.
  RESEND_WEBHOOK_SECRET: z.string().default(""),

  // Shopify OAuth (client store connections — NOT main Clandestine Shopify)
  SHOPIFY_CLIENT_ID: z.string().default(""),
  SHOPIFY_CLIENT_SECRET: z.string().default(""),

  // Squarespace OAuth
  SQUARESPACE_CLIENT_ID: z.string().default(""),
  SQUARESPACE_CLIENT_SECRET: z.string().default(""),

  // Discogs OAuth (client store connections + master catalog)
  DISCOGS_CONSUMER_KEY: z.string().default(""),
  DISCOGS_CONSUMER_SECRET: z.string().default(""),
  DISCOGS_MASTER_ACCESS_TOKEN: z.string().default(""),

  // AfterShip
  AFTERSHIP_API_KEY: z.string().min(1),
  AFTERSHIP_WEBHOOK_SECRET: z.string().min(1),

  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  // Bandcamp
  BANDCAMP_CLIENT_ID: z.string().min(1),
  BANDCAMP_CLIENT_SECRET: z.string().min(1),

  // Resend
  RESEND_API_KEY: z.string().min(1),
  RESEND_INBOUND_WEBHOOK_SECRET: z.string().min(1),

  // Tier 1 hardening #11 — daily reconciliation report destination.
  // Optional; if unset the daily-recon-summary task logs the report and skips
  // the email send so the cron never errors on a fresh environment.
  OPS_ALERT_EMAIL: z.string().email().optional(),

  // App
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let _cachedEnv: ServerEnv | null = null;

/**
 * Lazily validated server environment variables.
 * Only validates on first access — safe to import without all vars set.
 */
export function env(): ServerEnv {
  if (_cachedEnv) return _cachedEnv;
  _cachedEnv = serverEnvSchema.parse(process.env);
  return _cachedEnv;
}

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

let _cachedClientEnv: ClientEnv | null = null;

/**
 * Lazily validated client (public) environment variables.
 */
export function clientEnv(): ClientEnv {
  if (_cachedClientEnv) return _cachedClientEnv;
  _cachedClientEnv = clientEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
  return _cachedClientEnv;
}
