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

  // ShipStation (legacy — kept for historical inventory data, not actively used)
  SHIPSTATION_API_KEY: z.string().default(""),
  SHIPSTATION_API_SECRET: z.string().default(""),
  SHIPSTATION_WEBHOOK_SECRET: z.string().default(""),

  // EasyPost
  EASYPOST_API_KEY: z.string().default(""),

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
