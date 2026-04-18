# Shopify Hardening — Code Reference 05: New Code Skeletons

Part 5 of 6. Detailed skeletons for all NEW files the plan creates. Skeletons include function signatures, return types, pseudo-code, and implementation notes — enough to guide implementation without pre-committing to every line.

Related: [01 OAuth & Webhooks](01-oauth-webhooks.md) · [02 Trigger Tasks](02-trigger-tasks-existing.md) · [03 Actions & UI](03-actions-and-ui.md) · [04 Bandcamp Chain](04-bandcamp-shopify-chain.md) · [06 Migrations & Config](06-migrations-config-tests.md)

---

## Table of Contents

1. [`src/trigger/tasks/shopify-app-install.ts`](#1-shopify-app-install-task) — NEW, event task
2. [`src/trigger/tasks/auto-discover-skus.ts`](#2-auto-discover-skus-task) — NEW, event task
3. [`src/trigger/tasks/store-inventory-reconcile.ts`](#3-store-inventory-reconcile-task) — NEW, cron */30
4. [`src/trigger/tasks/retry-failed-webhooks.ts`](#4-retry-failed-webhooks-task) — NEW, cron */5
5. [`src/lib/clients/shopify-rate-limiter.ts`](#5-shopify-rate-limiter) — NEW
6. [`src/lib/shared/title-similarity.ts`](#6-title-similarity-shared-module) — NEW (extracted from shipment-fulfillment-cost)
7. [`src/lib/server/shopify-webhook-registration.ts`](#7-shopify-webhook-registration-helper) — NEW
8. [`src/app/admin/settings/webhooks/page.tsx`](#8-webhook-events-admin-dashboard) — NEW page
9. [`src/components/admin/mapping-review.tsx`](#9-mapping-review-component) — NEW
10. [`src/app/api/portal/stores/connection-progress/route.ts`](#10-connection-progress-api) — NEW portal endpoint

---

## 1. Shopify App Install Task

### File: `src/trigger/tasks/shopify-app-install.ts`

**Role**: Event task fired from OAuth callback immediately after token exchange. Does all post-install setup async so the OAuth redirect returns fast.

```typescript
/**
 * Shopify app install event task.
 * Fired from OAuth callback. Does all post-install setup.
 *
 * Steps (in order):
 *   1. Fetch connection row (access token, shop URL)
 *   2. Register webhooks on the merchant's Shopify store
 *   3. Enqueue auto-discover-skus
 *   4. Log to channel_sync_log
 *
 * On failure: retries up to 3x (default Trigger retry policy).
 * On final failure: creates high-severity review queue item.
 */

import { task, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { registerShopifyWebhooks } from "@/lib/server/shopify-webhook-registration";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const payloadSchema = z.object({
  connectionId: z.string().uuid(),
});

// Webhooks we register on every client Shopify store
const REQUIRED_WEBHOOKS = [
  { topic: "orders/create", path: "/api/webhooks/shopify" },
  { topic: "orders/updated", path: "/api/webhooks/shopify" },
  { topic: "inventory_levels/update", path: "/api/webhooks/shopify" },
  { topic: "products/update", path: "/api/webhooks/shopify" },
  { topic: "products/create", path: "/api/webhooks/shopify" },
  { topic: "app/uninstalled", path: "/api/webhooks/shopify" },
];

export const shopifyAppInstallTask = task({
  id: "shopify-app-install",
  maxDuration: 120,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: z.infer<typeof payloadSchema>) => {
    const { connectionId } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();

    // Step 1: Fetch connection
    const { data: connection, error: connErr } = await supabase
      .from("client_store_connections")
      .select("id, workspace_id, org_id, store_url, api_key, metadata")
      .eq("id", connectionId)
      .single();

    if (connErr || !connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    if (!connection.api_key) {
      throw new Error(`Connection ${connectionId} missing api_key`);
    }

    const startedAt = new Date().toISOString();
    const appUrl = env().NEXT_PUBLIC_APP_URL;

    // Step 2: Register webhooks (idempotent — skip existing)
    const webhookResults = await registerShopifyWebhooks({
      storeUrl: connection.store_url,
      accessToken: connection.api_key,
      webhooks: REQUIRED_WEBHOOKS.map((wh) => ({
        topic: wh.topic,
        address: `${appUrl}${wh.path}`,
      })),
    });

    // Step 3: Enqueue SKU discovery (don't block on it)
    await tasks.trigger("auto-discover-skus", { connectionId });

    // Step 4: Log success to channel_sync_log
    await supabase.from("channel_sync_log").insert({
      workspace_id: connection.workspace_id,
      channel: "shopify_client",
      sync_type: "app_install",
      status: webhookResults.failed > 0 ? "partial" : "completed",
      items_processed: webhookResults.registered,
      items_failed: webhookResults.failed,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      metadata: {
        connection_id: connectionId,
        webhooks: webhookResults.details,
      },
    });

    return {
      connectionId,
      webhooksRegistered: webhookResults.registered,
      webhooksFailed: webhookResults.failed,
    };
  },
  onFailure: async ({ payload, error }) => {
    const { connectionId } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();

    const { data: connection } = await supabase
      .from("client_store_connections")
      .select("workspace_id, org_id, store_url")
      .eq("id", connectionId)
      .single();

    if (connection) {
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: connection.workspace_id,
        org_id: connection.org_id,
        category: "store_connection",
        severity: "high",
        title: `Shopify install setup failed for ${connection.store_url}`,
        description:
          error instanceof Error
            ? error.message
            : "Unknown error during shopify-app-install",
        metadata: { connection_id: connectionId },
        group_key: `install_failed:${connectionId}`,
        status: "open",
      });
    }
  },
});
```

---

## 2. Auto Discover SKUs Task

### File: `src/trigger/tasks/auto-discover-skus.ts`

**Role**: Multi-signal SKU matching cascade. Writes confirmed mappings directly; fuzzy matches go to `pending_review`.

```typescript
/**
 * Auto-discover SKUs on a client store + match to warehouse variants.
 *
 * Matching cascade (in order):
 *   1. EXACT SKU — remote.sku === warehouse.sku (same org)
 *   2. BARCODE — remote.barcode === warehouse.barcode (non-empty)
 *   3. TITLE FUZZY — Jaccard similarity >= 0.6 on product titles → pending_review
 *   4. UNMATCHED — review queue item
 *
 * Platforms supported:
 *   - Shopify: /products.json with fields=id,title,product_type,vendor,variants
 *   - WooCommerce: /products + /products/{id}/variations for variable products
 *   - Squarespace: existing inventory API
 */

import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { titleSimilarity, normalizeTitleForMatching } from "@/lib/shared/title-similarity";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const payloadSchema = z.object({
  connectionId: z.string().uuid(),
});

// Types
type RemoteVariant = {
  remoteProductId: string;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null; // Shopify-only
  remoteSku: string;
  remoteTitle: string; // product title + variant title
  remoteBarcode: string | null;
};

type WarehouseVariant = {
  variantId: string;
  productId: string;
  sku: string;
  title: string; // product title
  variantTitle: string | null;
  barcode: string | null;
  orgId: string;
};

type MatchResult = {
  remote: RemoteVariant;
  warehouseVariantId: string;
  confidence: "exact_sku" | "barcode" | "title_fuzzy";
  score: number;
  status: "confirmed" | "pending_review";
};

export const autoDiscoverSkusTask = task({
  id: "auto-discover-skus",
  maxDuration: 180,
  run: async (payload: z.infer<typeof payloadSchema>) => {
    const { connectionId } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();

    // 1. Load connection
    // 2. Fetch remote variants (platform-specific, see below)
    const remoteVariants: RemoteVariant[] = await fetchRemoteVariants(connection);

    // 3. Fetch warehouse variants for this org
    const warehouseVariants: WarehouseVariant[] = await fetchWarehouseVariants(
      supabase,
      connection.org_id,
    );

    // 4. Build matching indexes
    const bySkuMap = new Map<string, WarehouseVariant>();
    const byBarcodeMap = new Map<string, WarehouseVariant>();
    for (const wv of warehouseVariants) {
      bySkuMap.set(wv.sku, wv);
      if (wv.barcode) byBarcodeMap.set(wv.barcode, wv);
    }

    // 5. Run matching cascade
    const matches: MatchResult[] = [];
    const unmatched: RemoteVariant[] = [];

    for (const remote of remoteVariants) {
      // TIER 1: Exact SKU
      if (remote.remoteSku) {
        const w = bySkuMap.get(remote.remoteSku);
        if (w) {
          matches.push({
            remote,
            warehouseVariantId: w.variantId,
            confidence: "exact_sku",
            score: 1.0,
            status: "confirmed",
          });
          continue;
        }
      }

      // TIER 2: Barcode
      if (remote.remoteBarcode) {
        const w = byBarcodeMap.get(remote.remoteBarcode);
        if (w) {
          matches.push({
            remote,
            warehouseVariantId: w.variantId,
            confidence: "barcode",
            score: 0.95,
            status: "confirmed",
          });
          continue;
        }
      }

      // TIER 3: Title fuzzy — compare to every warehouse variant
      let bestScore = 0;
      let bestMatch: WarehouseVariant | null = null;
      const remoteNorm = normalizeTitleForMatching(remote.remoteTitle);
      if (remoteNorm.length >= 10) {
        for (const w of warehouseVariants) {
          const score = titleSimilarity(remote.remoteTitle, w.title);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = w;
          }
        }
        if (bestMatch && bestScore >= 0.6) {
          matches.push({
            remote,
            warehouseVariantId: bestMatch.variantId,
            confidence: "title_fuzzy",
            score: bestScore,
            status: "pending_review",
          });
          continue;
        }
      }

      unmatched.push(remote);
    }

    // 6. Upsert mappings
    let confirmedCount = 0;
    let pendingCount = 0;
    for (const m of matches) {
      await supabase.from("client_store_sku_mappings").upsert(
        {
          workspace_id: connection.workspace_id,
          connection_id: connectionId,
          variant_id: m.warehouseVariantId,
          remote_product_id: m.remote.remoteProductId,
          remote_variant_id: m.remote.remoteVariantId,
          remote_inventory_item_id: m.remote.remoteInventoryItemId,
          remote_sku: m.remote.remoteSku,
          remote_title: m.remote.remoteTitle,
          remote_barcode: m.remote.remoteBarcode,
          match_confidence: m.confidence,
          match_score: m.score,
          match_status: m.status,
          is_active: true,
        },
        { onConflict: "connection_id,variant_id" },
      );
      if (m.status === "confirmed") confirmedCount++;
      else pendingCount++;
    }

    // 7. Create review items for unmatched (group by connection to avoid spam)
    if (unmatched.length > 0) {
      await supabase.from("warehouse_review_queue").upsert(
        {
          workspace_id: connection.workspace_id,
          org_id: connection.org_id,
          category: "unmatched_sku",
          severity: "low",
          title: `${unmatched.length} products on ${connection.store_url} need manual mapping`,
          description: `No exact SKU, barcode, or fuzzy title match found. Review and manually map in admin.`,
          metadata: {
            connection_id: connectionId,
            unmatched_count: unmatched.length,
            sample_skus: unmatched.slice(0, 10).map((u) => u.remoteSku || u.remoteTitle),
          },
          group_key: `unmatched_skus:${connectionId}`,
          status: "open",
        },
        { onConflict: "group_key", ignoreDuplicates: false },
      );
    }

    return {
      total: remoteVariants.length,
      confirmed: confirmedCount,
      pending: pendingCount,
      unmatched: unmatched.length,
    };
  },
});

// Platform-specific remote fetchers — full implementation per platform

async function fetchRemoteVariants(
  connection: ClientStoreConnection,
): Promise<RemoteVariant[]> {
  switch (connection.platform) {
    case "shopify":
      return fetchShopifyVariants(connection);
    case "woocommerce":
      return fetchWooCommerceVariants(connection);
    case "squarespace":
      return fetchSquarespaceVariants(connection);
    default:
      throw new Error(`Unsupported platform: ${connection.platform}`);
  }
}

// Shopify — paginate products with full fields, include variants barcode + inventory_item_id
async function fetchShopifyVariants(connection: ClientStoreConnection): Promise<RemoteVariant[]> {
  // Implementation: paginate /products.json?fields=id,title,product_type,vendor,variants
  // For each variant return: { remoteProductId, remoteVariantId, remoteInventoryItemId, remoteSku, remoteTitle: `${product.title} — ${variant.title}`, remoteBarcode: variant.barcode }
  // Use shopify-rate-limiter to avoid 429
  throw new Error("TODO");
}

// WooCommerce — fetch parent products, then for each variable product fetch /variations
async function fetchWooCommerceVariants(connection: ClientStoreConnection): Promise<RemoteVariant[]> {
  // Step 1: GET /wp-json/wc/v3/products?per_page=100 (paginate)
  // Step 2: For each product with type="variable", GET /wp-json/wc/v3/products/{id}/variations
  // Step 3: Return all simple products + all variations with their own SKU
  throw new Error("TODO");
}

async function fetchSquarespaceVariants(connection: ClientStoreConnection): Promise<RemoteVariant[]> {
  // Existing squarespace-client.getInventory returns items with SKU
  // Expand to include title and sku
  throw new Error("TODO");
}

async function fetchWarehouseVariants(
  supabase: ReturnType<typeof createServiceRoleClient>,
  orgId: string,
): Promise<WarehouseVariant[]> {
  // Query warehouse_products join warehouse_product_variants where product.org_id = orgId
  // Return flat array with all needed fields
  throw new Error("TODO");
}
```

---

## 3. Store Inventory Reconcile Task

### File: `src/trigger/tasks/store-inventory-reconcile.ts`

**Role**: Every 30 min, sample mapped SKUs per connection, fetch live remote quantity, compare to warehouse truth. Drift → review item.

```typescript
/**
 * Store inventory reconcile — cron every 30 minutes.
 *
 * For each active client_store_connection with do_not_fanout=false:
 *   1. Sample 50 confirmed mappings at random
 *   2. For each: fetch remote qty via StoreSyncClient.getRemoteQuantity
 *   3. Compare to warehouse_inventory_levels.available - safety_stock
 *   4. If |drift| > 1: create review queue item (severity: high), group_key: drift:{connection}:{sku}
 *   5. Write sensor_readings entry per connection
 *
 * Pattern mirrors bandcamp-sales-backfill self-healing.
 */

import { schedules } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const storeInventoryReconcileTask = schedules.task({
  id: "store-inventory-reconcile",
  cron: "*/30 * * * *",
  maxDuration: 300,
  run: async () => {
    const supabase = createServiceRoleClient();

    // Get all active connections with fanout enabled
    const { data: connections } = await supabase
      .from("client_store_connections")
      .select("*")
      .eq("connection_status", "active")
      .eq("do_not_fanout", false);

    if (!connections || connections.length === 0) return { checked: 0, drifted: 0 };

    let totalChecked = 0;
    let totalDrifted = 0;

    for (const connection of connections) {
      try {
        // Sample 50 confirmed mappings
        const { data: mappings } = await supabase
          .from("client_store_sku_mappings")
          .select("id, remote_sku, variant_id")
          .eq("connection_id", connection.id)
          .eq("is_active", true)
          .eq("match_status", "confirmed")
          .limit(50);

        if (!mappings || mappings.length === 0) continue;

        // Get warehouse levels for these variants
        const variantIds = mappings.map((m) => m.variant_id);
        const { data: levels } = await supabase
          .from("warehouse_inventory_levels")
          .select("variant_id, available, safety_stock")
          .in("variant_id", variantIds);

        const warehouseMap = new Map(
          (levels ?? []).map((l) => [
            l.variant_id,
            Math.max(0, l.available - (l.safety_stock ?? 3)),
          ]),
        );

        const client = createStoreSyncClient(connection);
        const driftedSkus: Array<{ sku: string; warehouse: number; remote: number }> = [];

        for (const mapping of mappings) {
          if (!mapping.remote_sku) continue;

          try {
            const remoteQty = await client.getRemoteQuantity(mapping.remote_sku);
            if (remoteQty === null) continue;

            const warehouseQty = warehouseMap.get(mapping.variant_id) ?? 0;
            const drift = Math.abs(remoteQty - warehouseQty);

            totalChecked++;
            if (drift > 1) {
              totalDrifted++;
              driftedSkus.push({
                sku: mapping.remote_sku,
                warehouse: warehouseQty,
                remote: remoteQty,
              });
            }
          } catch (err) {
            // Individual SKU lookup failure — log but don't abort
            console.error(
              `[reconcile] SKU ${mapping.remote_sku} lookup failed:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        // Create review item if drift detected
        if (driftedSkus.length > 0) {
          await supabase.from("warehouse_review_queue").upsert(
            {
              workspace_id: connection.workspace_id,
              org_id: connection.org_id,
              category: "inventory_drift",
              severity: "high",
              title: `${driftedSkus.length} SKUs drifted on ${connection.store_url}`,
              description: driftedSkus
                .slice(0, 10)
                .map((d) => `${d.sku}: warehouse=${d.warehouse}, remote=${d.remote}`)
                .join("\n"),
              metadata: {
                connection_id: connection.id,
                drifted_skus: driftedSkus,
              },
              group_key: `drift:${connection.id}`,
              status: "open",
              occurrence_count: 1,
            },
            { onConflict: "group_key", ignoreDuplicates: false },
          );
        }

        // Write sensor reading
        await supabase.from("sensor_readings").insert({
          workspace_id: connection.workspace_id,
          sensor_name: "client_store.drift_count",
          status: driftedSkus.length > 5 ? "warning" : "healthy",
          value: {
            connection_id: connection.id,
            checked: mappings.length,
            drifted: driftedSkus.length,
          },
          message: `${driftedSkus.length}/${mappings.length} drifted on ${connection.store_url}`,
        });
      } catch (err) {
        console.error(
          `[reconcile] Connection ${connection.id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { checked: totalChecked, drifted: totalDrifted };
  },
});
```

---

## 4. Retry Failed Webhooks Task

### File: `src/trigger/tasks/retry-failed-webhooks.ts`

**Role**: Every 5 min, replay stuck or failed webhook events with exponential backoff.

```typescript
/**
 * Retry failed webhook events — cron every 5 minutes.
 *
 * Replay rules:
 *   - status IN ('pending', 'processing_failed')
 *   - age > 5 minutes (avoid racing with in-flight processing)
 *   - metadata.retry_count < 5 (max 5 retries with exponential backoff)
 *   - backoff: 2^retry_count minutes since last attempt
 *
 * After 5 retries: mark status='failed_permanent', create review item.
 */

import { schedules, tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const MAX_RETRIES = 5;

export const retryFailedWebhooksTask = schedules.task({
  id: "retry-failed-webhooks",
  cron: "*/5 * * * *",
  maxDuration: 120,
  run: async () => {
    const supabase = createServiceRoleClient();
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();

    const { data: events } = await supabase
      .from("webhook_events")
      .select("id, platform, status, metadata, created_at, processed_at")
      .in("status", ["pending", "processing_failed"])
      .lt("created_at", cutoff)
      .limit(100);

    if (!events || events.length === 0) return { retried: 0, permanent_failed: 0 };

    let retried = 0;
    let permanentFailed = 0;

    for (const event of events) {
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      const retryCount = (metadata.retry_count as number | undefined) ?? 0;

      if (retryCount >= MAX_RETRIES) {
        // Mark as permanently failed
        await supabase
          .from("webhook_events")
          .update({ status: "failed_permanent" })
          .eq("id", event.id);

        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: null, // webhook_events may not have workspace_id
            category: "webhook_processing",
            severity: "high",
            title: `Webhook ${event.id} failed permanently after ${MAX_RETRIES} retries`,
            description: `Platform: ${event.platform}`,
            metadata: { webhook_event_id: event.id, platform: event.platform },
            group_key: `webhook_failed:${event.id}`,
            status: "open",
          },
          { onConflict: "group_key", ignoreDuplicates: true },
        );
        permanentFailed++;
        continue;
      }

      // Exponential backoff
      const lastAttempt = event.processed_at ?? event.created_at;
      const backoffMs = 2 ** retryCount * 60_000;
      const timeSince = Date.now() - new Date(lastAttempt).getTime();
      if (timeSince < backoffMs) continue; // Not time yet

      // Increment retry count
      await supabase
        .from("webhook_events")
        .update({
          metadata: { ...metadata, retry_count: retryCount + 1 },
          status: "pending",
        })
        .eq("id", event.id);

      // Re-trigger appropriate processor
      const taskId =
        event.platform === "shopify"
          ? "process-shopify-webhook"
          : "process-client-store-webhook";

      try {
        await tasks.trigger(taskId, { webhookEventId: event.id });
        retried++;
      } catch (err) {
        console.error(
          `[retry-webhooks] Failed to re-trigger ${event.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { retried, permanent_failed: permanentFailed };
  },
});
```

---

## 5. Shopify Rate Limiter

### File: `src/lib/clients/shopify-rate-limiter.ts`

**Role**: Token bucket per store URL. Shopify REST limit is 40 req/min (bucket size 40, refill 2/s).

```typescript
/**
 * Shopify REST rate limiter — leaky bucket per store.
 *
 * Shopify limits:
 *   - REST: 40 req/min bucket, 2 req/s refill
 *   - GraphQL: 1000 cost points/s
 *
 * Usage:
 *   const limiter = getShopifyRateLimiter(storeUrl);
 *   await limiter.acquire();
 *   const res = await fetch(url);
 *   if (res.status === 429) {
 *     await limiter.handle429(res.headers.get('Retry-After'));
 *     // retry
 *   }
 */

type Bucket = {
  tokens: number;
  lastRefillAt: number;
};

const buckets = new Map<string, Bucket>();
const BUCKET_SIZE = 40;
const REFILL_RATE = 2; // tokens per second

export function getShopifyRateLimiter(storeUrl: string) {
  return {
    async acquire(): Promise<void> {
      let bucket = buckets.get(storeUrl);
      if (!bucket) {
        bucket = { tokens: BUCKET_SIZE, lastRefillAt: Date.now() };
        buckets.set(storeUrl, bucket);
      }

      // Refill based on elapsed time
      const now = Date.now();
      const elapsedSec = (now - bucket.lastRefillAt) / 1000;
      bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + elapsedSec * REFILL_RATE);
      bucket.lastRefillAt = now;

      if (bucket.tokens < 1) {
        // Need to wait for next token
        const waitMs = ((1 - bucket.tokens) / REFILL_RATE) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        bucket.tokens = 0;
        bucket.lastRefillAt = Date.now();
      } else {
        bucket.tokens -= 1;
      }
    },

    async handle429(retryAfterHeader: string | null): Promise<void> {
      const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 2;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      // Also drain the bucket to be safe
      const bucket = buckets.get(storeUrl);
      if (bucket) bucket.tokens = 0;
    },
  };
}

/**
 * Wrapped fetch with automatic rate limiting + 429 retry.
 * Max 3 retries on 429.
 */
export async function rateLimitedShopifyFetch(
  storeUrl: string,
  url: string,
  init?: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  const limiter = getShopifyRateLimiter(storeUrl);
  let attempt = 0;

  while (attempt <= maxRetries) {
    await limiter.acquire();
    const res = await fetch(url, init);

    if (res.status === 429 && attempt < maxRetries) {
      await limiter.handle429(res.headers.get("Retry-After"));
      attempt++;
      continue;
    }

    return res;
  }

  throw new Error(`Shopify rate limit retry exhausted after ${maxRetries} attempts`);
}
```

---

## 6. Title Similarity Shared Module

### File: `src/lib/shared/title-similarity.ts`

**Role**: Extract from `shipment-fulfillment-cost.ts` and export for reuse in SKU matching.

```typescript
/**
 * Title similarity utilities for fuzzy matching.
 * Extracted from shipment-fulfillment-cost.ts for reuse in SKU discovery.
 */

export function normalizeTitleForMatching(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(lp|cd|cdr|ep|cassette|tape|vinyl|12"|10"|7"|split|dlp|2xlp|album|single)\b/gi, "")
    .replace(/[""'`\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Jaccard similarity with containment bonus.
 * Returns 0..1. Threshold for matching is typically 0.6.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitleForMatching(a);
  const nb = normalizeTitleForMatching(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const wordsA = new Set(na.split(/\s+/).filter((w) => w.length > 1));
  const wordsB = new Set(nb.split(/\s+/).filter((w) => w.length > 1));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) if (wordsB.has(word)) intersection++;

  const union = wordsA.size + wordsB.size - intersection;
  const jaccard = intersection / union;

  // Containment bonus
  const smaller = Math.min(wordsA.size, wordsB.size);
  const containment = intersection / smaller;

  return Math.max(jaccard, containment * 0.9);
}
```

---

## 7. Shopify Webhook Registration Helper

### File: `src/lib/server/shopify-webhook-registration.ts`

**Role**: Helper used by `shopify-app-install` and periodic sensor. Registers webhooks on a merchant store, idempotent.

```typescript
/**
 * Register webhooks on a merchant's Shopify store.
 * Idempotent — checks existing webhooks and skips already-registered ones.
 */

import { rateLimitedShopifyFetch } from "@/lib/clients/shopify-rate-limiter";

export interface WebhookToRegister {
  topic: string;
  address: string;
}

export interface RegisterResult {
  registered: number;
  skipped: number;
  failed: number;
  details: Array<{ topic: string; status: "registered" | "skipped" | "failed"; error?: string }>;
}

export async function registerShopifyWebhooks(params: {
  storeUrl: string;
  accessToken: string;
  webhooks: WebhookToRegister[];
}): Promise<RegisterResult> {
  const { storeUrl, accessToken, webhooks } = params;
  const base = storeUrl.replace(/\/$/, "");
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  // Fetch existing webhooks
  const listRes = await rateLimitedShopifyFetch(
    storeUrl,
    `${base}/admin/api/2026-01/webhooks.json`,
    { headers },
  );
  if (!listRes.ok) throw new Error(`Failed to list webhooks: ${listRes.status}`);
  const { webhooks: existing } = (await listRes.json()) as {
    webhooks: Array<{ id: number; topic: string; address: string }>;
  };

  const result: RegisterResult = { registered: 0, skipped: 0, failed: 0, details: [] };

  for (const wh of webhooks) {
    // Check if already registered at correct address
    const match = existing.find((e) => e.topic === wh.topic && e.address === wh.address);
    if (match) {
      result.skipped++;
      result.details.push({ topic: wh.topic, status: "skipped" });
      continue;
    }

    // Delete any existing registration at wrong address (cleanup)
    const stale = existing.filter((e) => e.topic === wh.topic && e.address !== wh.address);
    for (const s of stale) {
      await rateLimitedShopifyFetch(
        storeUrl,
        `${base}/admin/api/2026-01/webhooks/${s.id}.json`,
        { method: "DELETE", headers },
      );
    }

    // Register new
    try {
      const res = await rateLimitedShopifyFetch(
        storeUrl,
        `${base}/admin/api/2026-01/webhooks.json`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            webhook: { topic: wh.topic, address: wh.address, format: "json" },
          }),
        },
      );
      if (!res.ok) {
        const errBody = await res.text();
        result.failed++;
        result.details.push({ topic: wh.topic, status: "failed", error: errBody });
        continue;
      }
      result.registered++;
      result.details.push({ topic: wh.topic, status: "registered" });
    } catch (err) {
      result.failed++;
      result.details.push({
        topic: wh.topic,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Verify all required webhooks are still registered.
 * Used by periodic sensor to detect and self-heal registration drift.
 */
export async function verifyShopifyWebhooks(params: {
  storeUrl: string;
  accessToken: string;
  requiredTopics: string[];
  expectedAddress: string;
}): Promise<{ ok: boolean; missing: string[]; misrouted: string[] }> {
  // GET /webhooks.json, compare to required list
  // Return topics missing + topics registered at wrong address
  throw new Error("TODO");
}
```

---

## 8. Webhook Events Admin Dashboard

### File: `src/app/admin/settings/webhooks/page.tsx`

**Role**: Observability UI for webhook pipeline. Table of recent events with filters, expand for payload, manual retry button.

```tsx
/**
 * Admin webhook events dashboard.
 * Surfaces webhook_events table with status filters, payload inspection, retry button.
 */

"use client";

import { useState } from "react";
import { useAppQuery, useAppMutation } from "@/lib/hooks/use-app-query";
import { getWebhookEvents, retryWebhookEvent } from "@/actions/webhook-events";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type WebhookEventStatus =
  | "pending"
  | "processed"
  | "echo_cancelled"
  | "processing_failed"
  | "failed_permanent"
  | "sku_not_found"
  | "no_change";

export default function WebhookEventsPage() {
  const [statusFilter, setStatusFilter] = useState<WebhookEventStatus | "">("");
  const [platformFilter, setPlatformFilter] = useState<"shopify" | "woocommerce" | "squarespace" | "">("");

  const { data, isLoading } = useAppQuery({
    queryKey: ["admin", "webhook-events", statusFilter, platformFilter],
    queryFn: () =>
      getWebhookEvents({
        status: statusFilter || undefined,
        platform: platformFilter || undefined,
        limit: 100,
      }),
    tier: CACHE_TIERS.SESSION,
    refetchInterval: 30_000, // Refresh every 30s
  });

  const retryMutation = useAppMutation({
    mutationFn: (eventId: string) => retryWebhookEvent(eventId),
    invalidateKeys: [["admin", "webhook-events"]],
  });

  // UI:
  //  - Filter controls (status, platform, date range)
  //  - Metric cards: total, pending, failed_permanent, echo_cancelled
  //  - Table: timestamp, platform, topic, status, workspace, age, actions (retry, view payload)
  //  - Expand row: show full payload JSON + processing history

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Webhook Events</h1>
      {/* ... filters ... */}
      {/* ... metric cards ... */}
      {/* ... events table with expandable rows ... */}
    </div>
  );
}
```

**Companion server action** — `src/actions/webhook-events.ts`:

```typescript
"use server";

import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { tasks } from "@trigger.dev/sdk";

export async function getWebhookEvents(filters: {
  status?: string;
  platform?: string;
  limit?: number;
}) {
  await requireAuth();
  const supabase = createServiceRoleClient();

  let query = supabase
    .from("webhook_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 100);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.platform) query = query.eq("platform", filters.platform);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return data ?? [];
}

export async function retryWebhookEvent(eventId: string) {
  await requireAuth();
  const supabase = createServiceRoleClient();

  const { data: event } = await supabase
    .from("webhook_events")
    .select("platform")
    .eq("id", eventId)
    .single();

  if (!event) throw new Error("Event not found");

  const taskId =
    event.platform === "shopify" ? "process-shopify-webhook" : "process-client-store-webhook";

  await tasks.trigger(taskId, { webhookEventId: eventId });
  return { success: true };
}
```

---

## 9. Mapping Review Component

### File: `src/components/admin/mapping-review.tsx`

**Role**: Staff UI for approving/rejecting fuzzy-matched SKU mappings.

```tsx
/**
 * Side-by-side mapping review.
 * Shows warehouse product vs remote product; staff approves, rejects, or manually maps.
 */

"use client";

import { useState } from "react";
import { useAppQuery, useAppMutation } from "@/lib/hooks/use-app-query";
import {
  getPendingMappings,
  approveMapping,
  rejectMapping,
  manuallyMapSku,
} from "@/actions/store-connections";

interface PendingMapping {
  mappingId: string;
  matchConfidence: "title_fuzzy" | "barcode";
  matchScore: number;
  warehouseProduct: {
    variantId: string;
    sku: string;
    title: string;
    variantTitle: string | null;
    imageUrl: string | null;
  };
  remoteProduct: {
    sku: string;
    title: string;
    barcode: string | null;
    imageUrl: string | null;
    url: string;
  };
}

export function MappingReview({ connectionId }: { connectionId: string }) {
  const { data: pending, isLoading } = useAppQuery({
    queryKey: ["mapping-review", connectionId],
    queryFn: () => getPendingMappings(connectionId),
  });

  const approve = useAppMutation({
    mutationFn: (mappingId: string) => approveMapping(mappingId),
    invalidateKeys: [["mapping-review", connectionId]],
  });

  const reject = useAppMutation({
    mutationFn: (mappingId: string) => rejectMapping(mappingId),
    invalidateKeys: [["mapping-review", connectionId]],
  });

  // UI:
  //   - Stack of cards, one per pending mapping
  //   - Each card: side-by-side warehouse product + remote product
  //   - Match confidence + score badge
  //   - Buttons: "Approve", "Reject", "Manually Map" (opens search modal)
  //   - Bulk: "Approve all with score >= 0.8"

  return <div>{/* ... */}</div>;
}
```

---

## 10. Connection Progress API

### File: `src/app/api/portal/stores/connection-progress/route.ts`

**Role**: Poll endpoint for the post-connection progress card on portal.

```typescript
/**
 * GET /api/portal/stores/connection-progress?id=<connection_id>
 *
 * Returns the install progress for a client's store connection.
 * Used by portal/stores page to show a live progress card after OAuth.
 */

import { NextResponse } from "next/server";
import { requireClient } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export async function GET(request: Request) {
  const { orgId } = await requireClient();
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("id");
  if (!connectionId) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const supabase = createServiceRoleClient();

  // Verify connection belongs to client's org
  const { data: conn } = await supabase
    .from("client_store_connections")
    .select("id, connection_status, last_error, metadata")
    .eq("id", connectionId)
    .eq("org_id", orgId)
    .single();

  if (!conn) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Count mappings by status
  const { count: total } = await supabase
    .from("client_store_sku_mappings")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connectionId);

  const { count: confirmed } = await supabase
    .from("client_store_sku_mappings")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connectionId)
    .eq("match_status", "confirmed");

  const { count: pending } = await supabase
    .from("client_store_sku_mappings")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connectionId)
    .eq("match_status", "pending_review");

  // Check channel_sync_log for install completion
  const { data: installLog } = await supabase
    .from("channel_sync_log")
    .select("status, completed_at")
    .eq("channel", "shopify_client")
    .eq("sync_type", "app_install")
    .contains("metadata", { connection_id: connectionId })
    .order("completed_at", { ascending: false })
    .limit(1)
    .single();

  return NextResponse.json({
    connectionStatus: conn.connection_status,
    lastError: conn.last_error,
    install: {
      status: installLog?.status ?? "in_progress",
      completedAt: installLog?.completed_at ?? null,
    },
    mappings: {
      total: total ?? 0,
      confirmed: confirmed ?? 0,
      pending: pending ?? 0,
    },
  });
}
```

---

**Next**: [06 Migrations & Config](06-migrations-config-tests.md) for new migration SQL, trigger.config.ts, and test skeletons.
