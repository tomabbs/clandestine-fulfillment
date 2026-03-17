/**
 * Temporary diagnostic task — tests env loading, Supabase connection, and Redis.
 * DELETE after diagnosing production failures.
 */

import { logger, task } from "@trigger.dev/sdk";

export const debugEnvTask = task({
  id: "debug-env",
  run: async () => {
    const results: Record<string, string> = {};

    // Step 1: Check which env vars are present (not their values)
    const requiredVars = [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "DATABASE_URL",
      "DIRECT_URL",
      "TRIGGER_SECRET_KEY",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "NEXT_PUBLIC_SENTRY_DSN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "SENTRY_AUTH_TOKEN",
      "SHOPIFY_STORE_URL",
      "SHOPIFY_ADMIN_API_TOKEN",
      "SHOPIFY_API_VERSION",
      "SHIPSTATION_API_KEY",
      "SHIPSTATION_API_SECRET",
      "SHIPSTATION_WEBHOOK_SECRET",
      "AFTERSHIP_API_KEY",
      "AFTERSHIP_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "BANDCAMP_CLIENT_ID",
      "BANDCAMP_CLIENT_SECRET",
      "RESEND_API_KEY",
      "RESEND_INBOUND_WEBHOOK_SECRET",
      "NEXT_PUBLIC_APP_URL",
    ];

    const missing: string[] = [];
    const present: string[] = [];
    for (const key of requiredVars) {
      const val = process.env[key];
      if (val && val.length > 0) {
        present.push(key);
      } else {
        missing.push(key);
      }
    }
    results.envPresent = `${present.length}/${requiredVars.length}`;
    results.envMissing = missing.length > 0 ? missing.join(", ") : "none";
    logger.info("Env check", { present: present.length, missing });

    // Step 2: Test env() Zod validation
    try {
      const { env } = await import("@/lib/shared/env");
      const _parsed = env();
      results.envValidation = "PASS";
      logger.info("env() validation passed");
    } catch (error) {
      results.envValidation = `FAIL: ${String(error)}`;
      logger.error("env() validation failed", { error: String(error) });
    }

    // Step 3: Test Supabase connection
    try {
      const { createServiceRoleClient } = await import("@/lib/server/supabase-server");
      const supabase = createServiceRoleClient();
      const { data, error } = await supabase.from("workspaces").select("id").limit(1);
      if (error) {
        results.supabase = `QUERY_ERROR: ${error.message}`;
      } else {
        results.supabase = `PASS (${data?.length ?? 0} rows)`;
      }
      logger.info("Supabase check", { result: results.supabase });
    } catch (error) {
      results.supabase = `FAIL: ${String(error)}`;
      logger.error("Supabase failed", { error: String(error) });
    }

    // Step 4: Test Redis connection
    try {
      const { getInventory } = await import("@/lib/clients/redis-inventory");
      const inv = await getInventory("__debug_nonexistent_sku__");
      results.redis = `PASS (returned ${inv})`;
      logger.info("Redis check", { result: results.redis });
    } catch (error) {
      results.redis = `FAIL: ${String(error)}`;
      logger.error("Redis failed", { error: String(error) });
    }

    logger.info("Debug complete", results);
    return results;
  },
});
