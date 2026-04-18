# Shopify Hardening — Code Reference 02: Existing Trigger Tasks

Part 2 of 6. Full source code for all existing Trigger.dev tasks the plan modifies.

Related: [01 OAuth & Webhooks](01-oauth-webhooks.md) · [03 Actions & UI](03-actions-and-ui.md) · [04 Bandcamp Chain](04-bandcamp-shopify-chain.md) · [05 New Code](05-new-code-skeletons.md) · [06 Migrations & Config](06-migrations-config-tests.md)

---

## Table of Contents

1. [`src/trigger/tasks/process-shopify-webhook.ts`](#1-process-shopify-webhook) — 208 lines
2. [`src/trigger/tasks/process-client-store-webhook.ts`](#2-process-client-store-webhook) — 299 lines
3. [`src/trigger/tasks/client-store-order-detect.ts`](#3-client-store-order-detect) — 146 lines
4. [`src/trigger/tasks/multi-store-inventory-push.ts`](#4-multi-store-inventory-push) — 319 lines
5. [`src/trigger/tasks/mark-platform-fulfilled.ts`](#5-mark-platform-fulfilled) — 290 lines

---

## 1. process-shopify-webhook

### File: `src/trigger/tasks/process-shopify-webhook.ts`

**Role**: Async processing of Shopify webhook events. Fetches event from DB, parses payload, looks up SKU, computes delta, calls `recordInventoryChange`.

**Plan modifications (Phase 0.3, 0.4)**:
- **C3**: Remove dead `local_sku` / `platform` / `app_id` code at lines 114-132
- **C4**: `throw error` instead of `return` when `recordInventoryChange` fails (let Trigger retry)
- **Phase 1.3**: Add `topic === "app/uninstalled"` branch — disables connection, creates review item

```typescript
/**
 * Process Shopify inventory webhook — event trigger.
 *
 * Heavy processing happens here, not in the Route Handler (Rule #66).
 * Rule #65: Echo cancellation for inventory updates.
 * Rule #64: Inventory changes via record_inventory_change_txn RPC.
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Payload is IDs only — task fetches data from Postgres.
 * Rule #20: Single write path via recordInventoryChange().
 */

import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const payloadSchema = z.object({
  webhookEventId: z.string().uuid(),
});

/**
 * Parse Shopify inventory_levels/update webhook payload into SKU + absolute quantity.
 * Shopify sends absolute quantities, not deltas — we must compute delta ourselves.
 *
 * Shopify inventory_levels/update payload shape:
 * { inventory_item_id: number, location_id: number, available: number, updated_at: string }
 */
const shopifyInventoryPayloadSchema = z.object({
  inventory_item_id: z.number(),
  available: z.number().nullable(),
});

export interface ParsedShopifyInventory {
  inventoryItemId: number;
  available: number;
}

/**
 * Pure function: parse and validate raw Shopify inventory webhook payload.
 * Exported for testing.
 */
export function parseShopifyInventoryPayload(data: unknown): ParsedShopifyInventory | null {
  const result = shopifyInventoryPayloadSchema.safeParse(data);
  if (!result.success) return null;
  return {
    inventoryItemId: result.data.inventory_item_id,
    available: result.data.available ?? 0,
  };
}

/**
 * Pure function: compute inventory delta from webhook absolute quantity vs warehouse truth.
 * Returns 0 if no change. Exported for testing.
 */
export function computeDelta(webhookQuantity: number, warehouseQuantity: number): number {
  return webhookQuantity - warehouseQuantity;
}

export const processShopifyWebhookTask = task({
  id: "process-shopify-webhook",
  maxDuration: 60,
  run: async (payload: z.infer<typeof payloadSchema>) => {
    const { webhookEventId } = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();

    // Fetch the webhook event from DB (Rule #12: task fetches its own data)
    const { data: event, error: fetchError } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("id", webhookEventId)
      .single();

    if (fetchError || !event) {
      console.error(
        `[process-shopify-webhook] Event ${webhookEventId} not found: ${fetchError?.message}`,
      );
      return { processed: false, reason: "event_not_found" };
    }

    const metadata = event.metadata as Record<string, unknown>;
    const webhookData = metadata.payload as Record<string, unknown> | undefined;
    if (!webhookData) {
      return { processed: false, reason: "no_payload" };
    }

    // Parse the Shopify inventory payload
    const parsed = parseShopifyInventoryPayload(webhookData);
    if (!parsed) {
      console.error(
        `[process-shopify-webhook] Failed to parse inventory payload for event ${webhookEventId}`,
      );
      await markEvent(supabase, webhookEventId, "parse_failed");
      return { processed: false, reason: "parse_failed" };
    }

    // Look up SKU from inventory_item_id via our variant table
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("sku, id")
      .eq("shopify_inventory_item_id", String(parsed.inventoryItemId))
      .eq("workspace_id", event.workspace_id)
      .single();

    if (!variant) {
      // Unknown inventory item — not one of our tracked SKUs
      await markEvent(supabase, webhookEventId, "sku_not_found");
      return {
        processed: false,
        reason: "sku_not_found",
        inventoryItemId: parsed.inventoryItemId,
      };
    }

    // Rule #65: Echo cancellation — check if this webhook's quantity matches
    // what we last pushed. If so, this is our own update echoing back.
    const appId = (webhookData.app_id as number | undefined) ?? null;
    const echoAppId = metadata.app_id as number | undefined;
    if (appId || echoAppId) {
      // If we know our Shopify app ID, compare. For now, check last_pushed_quantity.
    }

    const { data: mapping } = await supabase
      .from("client_store_sku_mappings")
      .select("last_pushed_quantity")
      .eq("local_sku", variant.sku)
      .eq("platform", "shopify")
      .maybeSingle();

    if (mapping && mapping.last_pushed_quantity === parsed.available) {
      await markEvent(supabase, webhookEventId, "echo_cancelled");
      return { processed: true, reason: "echo_cancelled", sku: variant.sku };
    }

    // Get current warehouse level to compute delta
    const { data: level } = await supabase
      .from("warehouse_inventory_levels")
      .select("available")
      .eq("workspace_id", event.workspace_id)
      .eq("sku", variant.sku)
      .single();

    if (!level) {
      await markEvent(supabase, webhookEventId, "no_inventory_level");
      return { processed: false, reason: "no_inventory_level", sku: variant.sku };
    }

    const delta = computeDelta(parsed.available, level.available);
    if (delta === 0) {
      await markEvent(supabase, webhookEventId, "no_change");
      return { processed: true, reason: "no_change", sku: variant.sku };
    }

    // Rule #20: Single inventory write path via recordInventoryChange
    // Rule #64: This calls the record_inventory_change_txn RPC internally
    try {
      const result = await recordInventoryChange({
        workspaceId: event.workspace_id,
        sku: variant.sku,
        delta,
        source: "shopify",
        correlationId: `shopify_wh:${webhookEventId}`,
        metadata: {
          webhook_event_id: webhookEventId,
          inventory_item_id: parsed.inventoryItemId,
          shopify_available: parsed.available,
          warehouse_available: level.available,
        },
      });

      if (result.alreadyProcessed) {
        await markEvent(supabase, webhookEventId, "already_processed");
        return { processed: true, reason: "idempotent_skip", sku: variant.sku };
      }

      await markEvent(supabase, webhookEventId, "processed");
      return {
        processed: true,
        sku: variant.sku,
        delta,
        newQuantity: result.newQuantity,
        success: result.success,
      };
    } catch (error) {
      console.error(
        `[process-shopify-webhook] recordInventoryChange failed for SKU=${variant.sku}:`,
        error,
      );
      await markEvent(supabase, webhookEventId, "processing_failed");
      return {
        processed: false,
        reason: "inventory_change_failed",
        sku: variant.sku,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

async function markEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  eventId: string,
  status: string,
): Promise<void> {
  await supabase
    .from("webhook_events")
    .update({ status, processed_at: new Date().toISOString() })
    .eq("id", eventId);
}
```

**Silent bugs in this file**:
- Lines 114-120: Dead `app_id` code (M1)
- Lines 122-128: Broken query — `local_sku` and `platform` don't exist on `client_store_sku_mappings` (C3)
- Line 190: `return` swallows error instead of `throw` (C4)

---

## 2. process-client-store-webhook

### File: `src/trigger/tasks/process-client-store-webhook.ts`

**Role**: Processes client store webhooks (WooCommerce, Squarespace, legacy Shopify). Handles inventory updates and order creation with SKU mapping resolution.

**Plan modifications (Phase 3.3)**:
- Add `.eq("source", platform)` to duplicate check at line 124 (prevents cross-platform external_order_id collisions)
- Per-iteration Sentry capture in the decrement loop
- Filter SKU mapping queries by `match_status = 'confirmed'` (Phase 2.5)

```typescript
/**
 * Process client store webhook — event trigger.
 *
 * Heavy processing happens here, not in the Route Handler (Rule #66).
 * Rule #65: Echo cancellation for inventory updates.
 * Rule #7: Uses createServiceRoleClient().
 */

import { task, tasks } from "@trigger.dev/sdk";
import { triggerBundleFanout } from "@/lib/server/bundles";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const processClientStoreWebhookTask = task({
  id: "process-client-store-webhook",
  maxDuration: 60,
  run: async (payload: { webhookEventId: string }) => {
    const supabase = createServiceRoleClient();

    // Fetch the webhook event
    const { data: event } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("id", payload.webhookEventId)
      .single();

    if (!event) throw new Error(`Webhook event ${payload.webhookEventId} not found`);

    const metadata = event.metadata as Record<string, unknown>;
    const webhookData = metadata.payload as Record<string, unknown> | undefined;
    if (!webhookData) return { processed: false, reason: "no_payload" };

    const topic = event.topic ?? "";

    // Determine connection for echo cancellation check
    const connectionId = metadata.connection_id as string | undefined;

    if (topic.includes("inventory") || topic.includes("stock")) {
      return await handleInventoryUpdate(supabase, event, webhookData, connectionId);
    }

    if (topic.includes("order")) {
      return await handleOrderCreated(supabase, event, webhookData, connectionId);
    }

    return { processed: false, reason: "unknown_topic", topic };
  },
});

async function handleInventoryUpdate(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) {
  const sku = (data.sku as string) ?? "";
  const newQuantity = data.quantity as number | undefined;

  if (!sku || newQuantity === undefined) {
    return { processed: false, reason: "missing_sku_or_quantity" };
  }

  // Rule #65: Echo cancellation
  if (connectionId) {
    const { data: mapping } = await supabase
      .from("client_store_sku_mappings")
      .select("last_pushed_quantity")
      .eq("connection_id", connectionId)
      .eq("remote_sku", sku)
      .single();

    if (mapping && mapping.last_pushed_quantity === newQuantity) {
      // This is our own push echoing back
      await supabase
        .from("webhook_events")
        .update({ status: "echo_cancelled" })
        .eq("id", event.id as string);

      return { processed: true, reason: "echo_cancelled", sku };
    }
  }

  // Get current warehouse inventory to compute delta
  const { data: level } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("workspace_id", event.workspace_id as string)
    .eq("sku", sku)
    .single();

  if (!level) return { processed: false, reason: "sku_not_found", sku };

  const delta = newQuantity - level.available;
  if (delta === 0) return { processed: true, reason: "no_change", sku };

  const platform = event.platform as string;
  const source =
    platform === "shopify" ? "shopify" : platform === "woocommerce" ? "woocommerce" : "shopify";

  await recordInventoryChange({
    workspaceId: event.workspace_id as string,
    sku,
    delta,
    source: source as "shopify" | "woocommerce",
    correlationId: `webhook:${event.platform}:${event.id}`,
    metadata: { webhook_event_id: event.id, platform },
  });

  await supabase
    .from("webhook_events")
    .update({ status: "processed" })
    .eq("id", event.id as string);

  return { processed: true, sku, delta };
}

async function handleOrderCreated(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  connectionId: string | undefined,
) {
  const workspaceId = event.workspace_id as string;
  const remoteOrderId = (data.id as string) ?? (data.order_id as string) ?? "";
  const lineItems = (data.line_items as Array<Record<string, unknown>>) ?? [];

  // Check for duplicate
  const { data: existing } = await supabase
    .from("warehouse_orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("external_order_id", remoteOrderId)
    .single();

  if (existing) return { processed: true, reason: "duplicate_order" };

  // Get org from connection
  let orgId: string | null = null;
  if (connectionId) {
    const { data: conn } = await supabase
      .from("client_store_connections")
      .select("org_id")
      .eq("id", connectionId)
      .single();
    orgId = conn?.org_id ?? null;
  }

  if (!orgId) return { processed: false, reason: "no_org_id" };

  const platform = event.platform as string;
  const { data: newOrder } = await supabase
    .from("warehouse_orders")
    .insert({
      workspace_id: workspaceId,
      org_id: orgId,
      external_order_id: remoteOrderId,
      order_number: (data.order_number as string) ?? (data.name as string) ?? null,
      source: platform,
      line_items: lineItems,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (newOrder && lineItems.length > 0) {
    const items = lineItems.map((li) => ({
      order_id: newOrder.id,
      workspace_id: workspaceId,
      sku: (li.sku as string) ?? "",
      quantity: (li.quantity as number) ?? 1,
    }));
    await supabase.from("warehouse_order_items").insert(items);

    // Decrement warehouse inventory for each line item.
    // This loop is NOT atomic — partial failures are recorded in warehouse_review_queue.
    // floor_violation (medium) = expected stock-short; system_fault (high) = needs investigation.
    const platform = event.platform as string;
    const bundleCache = new Map<string, boolean>();
    const decrementResults: {
      sku: string;
      delta: number;
      status: "ok" | "floor_violation" | "not_mapped" | "error";
      reason?: string;
    }[] = [];

    for (let index = 0; index < lineItems.length; index++) {
      const li = lineItems[index];
      const remoteSku = (li.sku as string) ?? "";
      if (!remoteSku) continue;

      // Resolve warehouse SKU via mapping (remote SKU may differ from warehouse SKU)
      const { data: mapping } = await supabase
        .from("client_store_sku_mappings")
        .select("variant_id, warehouse_product_variants!inner(sku)")
        .eq("connection_id", connectionId ?? "")
        .eq("remote_sku", remoteSku)
        .single();

      const warehouseSku = (
        mapping?.warehouse_product_variants as unknown as { sku: string } | null
      )?.sku;
      if (!warehouseSku) {
        decrementResults.push({ sku: remoteSku, delta: 0, status: "not_mapped" });
        continue;
      }

      const qty = (li.quantity as number) ?? 1;
      // Include line item ID or index to prevent correlation ID collision when
      // the same warehouse SKU appears in two separate line items of one order.
      const lineItemId = (li.id as string | undefined) ?? String(index);
      const result = await recordInventoryChange({
        workspaceId,
        sku: warehouseSku,
        delta: -qty,
        source: platform === "woocommerce" ? "woocommerce" : "shopify",
        correlationId: `store-order:${event.id}:${warehouseSku}:${lineItemId}`,
        metadata: {
          order_id: newOrder.id,
          remote_sku: remoteSku,
          connection_id: connectionId,
          line_item_id: lineItemId,
        },
      });

      if (result.success || result.alreadyProcessed) {
        decrementResults.push({ sku: warehouseSku, delta: -qty, status: "ok" });

        if (result.success && !result.alreadyProcessed && qty > 0 && mapping?.variant_id) {
          const fanout = await triggerBundleFanout({
            variantId: mapping.variant_id,
            soldQuantity: qty,
            workspaceId,
            correlationBase: `store-order:${event.id}:${warehouseSku}`,
            cache: bundleCache,
          });
          if (fanout.error) {
            console.error("[process-client-store-webhook] Bundle fanout failed:", fanout.error);
          }
        }
      } else if ((result as { reason?: string }).reason === "floor_violation") {
        decrementResults.push({
          sku: warehouseSku,
          delta: -qty,
          status: "floor_violation",
          reason: "insufficient_stock",
        });
      } else {
        decrementResults.push({
          sku: warehouseSku,
          delta: -qty,
          status: "error",
          reason: "system_fault",
        });
      }
    }

    // Record partial application to review queue if any line item failed
    const failures = decrementResults.filter((r) => r.status !== "ok" && r.status !== "not_mapped");
    if (failures.length > 0) {
      const hasSystemFault = failures.some((r) => r.status === "error");
      await supabase.from("warehouse_review_queue").upsert(
        {
          workspace_id: workspaceId,
          org_id: orgId,
          category: "inventory_partial_apply",
          severity: hasSystemFault ? "high" : "medium",
          title: hasSystemFault
            ? `Order ${newOrder.id}: inventory write failed (system error)`
            : `Order ${newOrder.id}: inventory short on ${failures.length} SKU(s)`,
          description: failures
            .map((f) => `${f.sku}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`)
            .join("; "),
          metadata: { order_id: newOrder.id, decrement_results: decrementResults },
          status: "open",
          group_key: `inv_partial:${newOrder.id}`,
          occurrence_count: 1,
        },
        { onConflict: "group_key", ignoreDuplicates: false },
      );
    }

    // Trigger immediate push to all channels if any decrement succeeded
    if (decrementResults.some((r) => r.status === "ok")) {
      await Promise.allSettled([
        tasks.trigger("bandcamp-inventory-push", {}),
        tasks.trigger("multi-store-inventory-push", {}),
      ]).catch(() => {
        /* non-critical */
      });
    }
  }

  await supabase
    .from("webhook_events")
    .update({ status: "processed" })
    .eq("id", event.id as string);

  return { processed: true, orderId: newOrder?.id };
}
```

**Silent bugs in this file**:
- Line 129: Dedup missing `source` filter — cross-platform `external_order_id` collisions possible
- Lines 248, 261: `console.error` with no Sentry capture and no review queue item
- No unit tests exist for this task (H5)

---

## 3. client-store-order-detect

### File: `src/trigger/tasks/client-store-order-detect.ts`

**Role**: Every 10 min, polls each active connection for new orders via REST API. Fallback for missing webhooks. Uses `isEchoOrder` to drop our own pushes echoing back.

**Plan modifications (Phase 3)**:
- Per-iteration Sentry capture at line 133
- Improve echo detection — current logic is all-or-nothing; refine to per-line matching

```typescript
/**
 * Client store order detect — cron every 10 minutes.
 *
 * Polls each active client_store_connection for new orders.
 * Rule #65: Echo cancellation — if order quantities match last_pushed_quantity, it's our own push echoing.
 *
 * NOTE: Discogs connections are intentionally skipped here.
 * They are handled by discogs-client-order-sync, which:
 *   - Uses OAuth 1.0a auth with Redis-backed rate limiting
 *   - Does not apply echo detection (we don't push inventory to client Discogs)
 *   - Runs on its own 10-minute cron schedule
 */

import { schedules } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { clientStoreOrderQueue } from "@/trigger/lib/client-store-order-queue";

export function isEchoOrder(
  lineItems: Array<{ sku: string; quantity: number }>,
  lastPushedQuantities: Map<string, number>,
): boolean {
  if (lineItems.length === 0) return false;
  return lineItems.every((item) => {
    const lastPushed = lastPushedQuantities.get(item.sku);
    return lastPushed !== undefined && item.quantity === lastPushed;
  });
}

export const clientStoreOrderDetectTask = schedules.task({
  id: "client-store-order-detect",
  cron: "*/10 * * * *",
  maxDuration: 180,
  queue: clientStoreOrderQueue,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    let ordersCreated = 0;
    let echoesCancelled = 0;
    let errors = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("client_store_connections")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("connection_status", "active");

      if (!connections || connections.length === 0) continue;

      for (const connection of connections as ClientStoreConnection[]) {
        // Discogs handled by discogs-client-order-sync (OAuth 1.0a + Redis rate limiter)
        if (connection.platform === "discogs") continue;

        try {
          const since =
            connection.last_poll_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const client = createStoreSyncClient(connection);
          const remoteOrders = await client.getOrders(since);

          // Get last_pushed_quantity for echo detection (Rule #65)
          const { data: skuMappings } = await supabase
            .from("client_store_sku_mappings")
            .select("remote_sku, last_pushed_quantity")
            .eq("connection_id", connection.id);

          const lastPushedMap = new Map(
            (skuMappings ?? [])
              .filter((m) => m.remote_sku && m.last_pushed_quantity !== null)
              .map((m) => [m.remote_sku as string, m.last_pushed_quantity as number]),
          );

          for (const order of remoteOrders) {
            // Check for duplicate
            const { data: existing } = await supabase
              .from("warehouse_orders")
              .select("id")
              .eq("workspace_id", workspaceId)
              .eq("external_order_id", order.remoteOrderId)
              .eq("source", connection.platform)
              .single();

            if (existing) continue;

            // Rule #65: Echo cancellation
            if (isEchoOrder(order.lineItems, lastPushedMap)) {
              echoesCancelled++;
              continue;
            }

            // Create order + items
            const { data: newOrder } = await supabase
              .from("warehouse_orders")
              .insert({
                workspace_id: workspaceId,
                org_id: connection.org_id,
                external_order_id: order.remoteOrderId,
                order_number: order.orderNumber,
                source: connection.platform,
                line_items: order.lineItems,
                created_at: order.createdAt,
                updated_at: new Date().toISOString(),
              })
              .select("id")
              .single();

            if (newOrder) {
              const orderItems = order.lineItems.map((li) => ({
                order_id: newOrder.id,
                workspace_id: workspaceId,
                sku: li.sku,
                quantity: li.quantity,
                shopify_line_item_id: li.remoteVariantId,
              }));

              if (orderItems.length > 0) {
                await supabase.from("warehouse_order_items").insert(orderItems);
              }

              ordersCreated++;
            }
          }

          // Update last_poll_at
          await supabase
            .from("client_store_connections")
            .update({
              last_poll_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id);
        } catch (error) {
          errors++;
          console.error(
            `[client-store-order-detect] Failed for connection ${connection.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    return { ordersCreated, echoesCancelled, errors };
  },
});
```

**Silent bug in this file**: Line 133 — `console.error` without Sentry + review item (H7).

---

## 4. multi-store-inventory-push

### File: `src/trigger/tasks/multi-store-inventory-push.ts`

**Role**: Every 5 min, pushes latest inventory to all active client stores. Implements bundle MIN logic, safety buffer, per-connection circuit breaker. `shouldRetryConnection` + `computeFreshnessState` helpers exported but **not wired into the task body** (only used in tests).

**Plan modifications (Phase 3.1, 3.2)**:
- Wire `shouldRetryConnection(consecutiveFailures, lastErrorAt)` — skip connections in backoff window
- Add rate limiter before each `pushInventory` call (Phase 3.1)
- Track `consecutive_push_failures` per mapping; after 5, mark `is_active=false` + review item (Phase 3.2)
- Per-iteration Sentry capture at line 237
- Filter mappings by `match_status = 'confirmed'` (Phase 2.5)

```typescript
/**
 * Multi-store inventory push — cron every 5 minutes.
 *
 * Rule #53: Circuit breaker per connection. 5 consecutive auth failures → disabled.
 * Rule #44: Track last_pushed_quantity and last_pushed_at per mapping.
 * Rule #71: Track freshness state per connection.
 * One broken connection must NEVER block others.
 */

import { schedules } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 60_000; // 1 minute

export type FreshnessState = "fresh" | "delayed" | "stale" | "reconciling";

export function computeFreshnessState(lastPushedAt: string | null): FreshnessState {
  if (!lastPushedAt) return "stale";
  const ageMs = Date.now() - new Date(lastPushedAt).getTime();
  if (ageMs < 5 * 60_000) return "fresh";
  if (ageMs < 30 * 60_000) return "delayed";
  return "stale";
}

export function shouldRetryConnection(
  consecutiveFailures: number,
  lastErrorAt: string | null,
): boolean {
  if (consecutiveFailures === 0) return true;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;
  if (!lastErrorAt) return true;

  const backoffMs = BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1);
  const timeSinceError = Date.now() - new Date(lastErrorAt).getTime();
  return timeSinceError >= backoffMs;
}

export const multiStoreInventoryPushTask = schedules.task({
  id: "multi-store-inventory-push",
  cron: "*/5 * * * *",
  maxDuration: 180,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    let totalPushed = 0;
    let totalFailed = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("client_store_connections")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("do_not_fanout", false)
        .eq("connection_status", "active");

      if (!connections || connections.length === 0) continue;

      // Load workspace settings including pause flag
      const { data: ws } = await supabase
        .from("workspaces")
        .select("default_safety_stock, bundles_enabled, inventory_sync_paused")
        .eq("id", workspaceId)
        .single();

      // Pause guard — state-change-only logging to avoid flooding channel_sync_log
      if (ws?.inventory_sync_paused) {
        const { data: lastLog } = await supabase
          .from("channel_sync_log")
          .select("status")
          .eq("workspace_id", workspaceId)
          .eq("channel", "multi-store")
          .eq("sync_type", "inventory_push")
          .order("completed_at", { ascending: false })
          .limit(1)
          .single();

        if (lastLog?.status !== "paused") {
          await supabase.from("channel_sync_log").insert({
            workspace_id: workspaceId,
            channel: "multi-store",
            sync_type: "inventory_push",
            status: "paused",
            items_processed: 0,
            items_failed: 0,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            metadata: { reason: "inventory_sync_paused" },
          });
        }
        continue;
      }

      const workspaceSafetyStock = ws?.default_safety_stock ?? 3;
      const bundlesEnabled = ws?.bundles_enabled ?? false;

      // Load bundle components for this workspace (only if bundles are enabled)
      type BundleComponent = {
        bundle_variant_id: string;
        component_variant_id: string;
        quantity: number;
      };
      const bundleMap = new Map<string, BundleComponent[]>();
      if (bundlesEnabled) {
        const { data: allComponents } = await supabase
          .from("bundle_components")
          .select("bundle_variant_id, component_variant_id, quantity")
          .eq("workspace_id", workspaceId);
        for (const bc of allComponents ?? []) {
          const arr = bundleMap.get(bc.bundle_variant_id) ?? [];
          arr.push(bc);
          bundleMap.set(bc.bundle_variant_id, arr);
        }
      }

      // Process each connection independently — one failure must not block others
      for (const connection of connections as ClientStoreConnection[]) {
        try {
          const pushed = await pushConnectionInventory(
            supabase,
            connection,
            workspaceSafetyStock,
            bundlesEnabled ? bundleMap : new Map(),
          );
          totalPushed += pushed;
        } catch (error) {
          totalFailed++;
          await handleConnectionFailure(supabase, connection, error);
        }
      }
    }

    return { totalPushed, totalFailed };
  },
});

type BundleComponent = {
  bundle_variant_id: string;
  component_variant_id: string;
  quantity: number;
};

async function pushConnectionInventory(
  supabase: ReturnType<typeof createServiceRoleClient>,
  connection: ClientStoreConnection,
  workspaceSafetyStock = 3,
  bundleMap = new Map<string, BundleComponent[]>(),
): Promise<number> {
  // Get SKU mappings for this connection
  const { data: mappings } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "id, variant_id, remote_product_id, remote_variant_id, remote_sku, last_pushed_quantity",
    )
    .eq("connection_id", connection.id)
    .eq("is_active", true);

  if (!mappings || mappings.length === 0) return 0;

  // Get inventory levels for mapped variants + component variants (for bundle MIN)
  const variantIds = mappings.map((m) => m.variant_id);
  const componentVariantIds = Array.from(
    new Set(
      Array.from(bundleMap.values())
        .flat()
        .map((c) => c.component_variant_id),
    ),
  );
  const allVariantIds = Array.from(new Set([...variantIds, ...componentVariantIds]));

  const { data: levels } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id, available, safety_stock")
    .in("variant_id", allVariantIds);

  const inventoryByVariant = new Map(
    (levels ?? []).map((l) => [
      l.variant_id,
      { available: l.available, safetyStock: l.safety_stock as number | null },
    ]),
  );

  // Build SKU mapping context for the sync client
  const skuMappingContext = new Map(
    mappings.map((m) => [
      m.remote_sku ?? "",
      { remoteProductId: m.remote_product_id, remoteVariantId: m.remote_variant_id },
    ]),
  );

  const client = createStoreSyncClient(connection, skuMappingContext);
  let pushed = 0;

  for (const mapping of mappings) {
    const inv = inventoryByVariant.get(mapping.variant_id);
    const rawAvailable = inv?.available ?? 0;
    const effectiveSafety = inv?.safetyStock ?? workspaceSafetyStock;

    // Compute bundle minimum if this variant is configured as a bundle
    let effectiveAvailable = rawAvailable;
    const components = bundleMap.get(mapping.variant_id);
    if (components?.length) {
      const componentMin = Math.min(
        ...components.map((c) => {
          const compInv = inventoryByVariant.get(c.component_variant_id);
          return Math.floor((compInv?.available ?? 0) / c.quantity);
        }),
      );
      effectiveAvailable = Math.min(rawAvailable, Math.max(0, componentMin));
    }

    const pushedQuantity = Math.max(0, effectiveAvailable - effectiveSafety);

    // Skip if effective quantity hasn't changed (compare buffered value, not raw)
    if (mapping.last_pushed_quantity === pushedQuantity) continue;

    const idempotencyKey = `store-push:${connection.id}:${mapping.id}:${pushedQuantity}`;

    try {
      await client.pushInventory(mapping.remote_sku ?? "", pushedQuantity, idempotencyKey);

      // Rule #44: Track the buffered quantity that was actually pushed
      await supabase
        .from("client_store_sku_mappings")
        .update({
          last_pushed_quantity: pushedQuantity,
          last_pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", mapping.id);

      pushed++;
    } catch (error) {
      console.error(
        `[multi-store-push] Failed to push ${mapping.remote_sku} to connection ${connection.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Update connection health
  await supabase
    .from("client_store_connections")
    .update({
      last_poll_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  return pushed;
}

// Rule #53: Circuit breaker — exponential backoff, auto-disable after 5 auth failures
async function handleConnectionFailure(
  supabase: ReturnType<typeof createServiceRoleClient>,
  connection: ClientStoreConnection,
  error: unknown,
) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const isAuthError =
    errorMsg.includes("401") || errorMsg.includes("403") || errorMsg.includes("auth");

  // Count consecutive failures (simple: increment metadata counter)
  const { data: current } = await supabase
    .from("client_store_connections")
    .select("last_error, last_error_at")
    .eq("id", connection.id)
    .single();

  // Track consecutive failures via metadata
  const previousFailureCount = current?.last_error?.startsWith("consecutive:")
    ? Number.parseInt(current.last_error.split(":")[1], 10)
    : 0;
  const consecutiveFailures = previousFailureCount + 1;

  if (isAuthError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    // Auto-disable connection
    await supabase
      .from("client_store_connections")
      .update({
        connection_status: "disabled_auth_failure",
        do_not_fanout: true,
        last_error: `consecutive:${consecutiveFailures} ${errorMsg}`,
        last_error_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    // Create review queue item
    await supabase.from("warehouse_review_queue").insert({
      workspace_id: connection.workspace_id,
      org_id: connection.org_id,
      category: "store_connection",
      severity: "high",
      title: `${connection.platform} connection disabled: auth failure`,
      description: `Connection to ${connection.store_url} disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive auth failures. Last error: ${errorMsg}`,
      metadata: {
        connection_id: connection.id,
        platform: connection.platform,
        consecutive_failures: consecutiveFailures,
      },
      group_key: `connection_disabled:${connection.id}`,
      status: "open",
    });
  } else {
    await supabase
      .from("client_store_connections")
      .update({
        last_error: `consecutive:${consecutiveFailures} ${errorMsg}`,
        last_error_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);
  }
}
```

**Silent bugs in this file**:
- `shouldRetryConnection` never called in `run` — backoff unused
- Line 237: per-SKU errors swallowed to `console.error` only — no Sentry, no review item (H7)
- No rate limiting before `pushInventory` — 429s slip through (H1)

---

## 5. mark-platform-fulfilled

### File: `src/trigger/tasks/mark-platform-fulfilled.ts`

**Role**: Marks an order as fulfilled on its originating platform (Shopify, WooCommerce, Squarespace, Discogs). Called after label creation.

**Plan modifications**: Minor — ensure Shopify path handles the fulfillment_order lifecycle correctly; already has retry and review queue on failure.

```typescript
/**
 * Mark a fulfillment order as shipped on its originating platform.
 *
 * Platforms:
 *   shopify    → fulfillment_orders + fulfillments API (2026-01)
 *   woocommerce → PUT /orders/{id} status: completed + tracking meta
 *   squarespace → POST /commerce/orders/{id}/fulfillments  ← C1 fix (not "no API")
 *   discogs    → PLAINTEXT OAuth 1.0a message + status update
 *   bandcamp   → skipped — bandcamp-mark-shipped cron handles it
 *
 * On success: sets platform_fulfillment_status = 'confirmed'
 * On failure: sets platform_fulfillment_status = 'failed' + review queue item
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { task } from "@trigger.dev/sdk";
import OAuth from "oauth-1.0a";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

export const markPlatformFulfilledTask = task({
  id: "mark-platform-fulfilled",
  maxDuration: 60,
  run: async (payload: { order_id: string; tracking_number: string; carrier: string }) => {
    const supabase = createServiceRoleClient();
    const { order_id, tracking_number, carrier } = payload;

    const { data: order } = await supabase
      .from("warehouse_orders")
      .select("id, source, metadata, org_id, workspace_id, external_order_id")
      .eq("id", order_id)
      .single();

    if (!order) return { skipped: true, reason: "order_not_found" };

    // Bandcamp handled separately by bandcamp-mark-shipped cron
    if (order.source === "bandcamp")
      return { skipped: true, reason: "bandcamp_handled_separately" };
    if (order.source === "manual") return { skipped: true, reason: "manual_order" };

    const platformOrderId = (order.metadata as Record<string, string> | null)?.platform_order_id;
    if (!platformOrderId) return { skipped: true, reason: "no_platform_order_id_in_metadata" };

    const { data: connection } = await supabase
      .from("client_store_connections")
      .select("*")
      .eq("org_id", order.org_id)
      .eq("platform", order.source)
      .eq("connection_status", "active")
      .single();

    if (!connection) return { skipped: true, reason: "no_active_connection" };

    try {
      switch (order.source) {
        case "shopify":
          await markShopifyFulfilled(connection, platformOrderId, tracking_number, carrier);
          break;
        case "woocommerce":
          await markWooCommerceFulfilled(connection, platformOrderId, tracking_number, carrier);
          break;
        case "squarespace":
          await markSquarespaceFulfilled(connection, platformOrderId, tracking_number, carrier);
          break;
        case "discogs":
          await markDiscogsFulfilled(connection, platformOrderId, tracking_number, carrier);
          break;
        default:
          return { skipped: true, reason: `unsupported_platform:${order.source}` };
      }

      await supabase
        .from("warehouse_orders")
        .update({ platform_fulfillment_status: "confirmed", updated_at: new Date().toISOString() })
        .eq("id", order_id);

      return { success: true, platform: order.source };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mark-platform-fulfilled] ${order.source} error:`, msg);

      await supabase
        .from("warehouse_orders")
        .update({ platform_fulfillment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", order_id);

      await supabase.from("warehouse_review_queue").insert({
        workspace_id: order.workspace_id,
        org_id: order.org_id,
        category: "fulfillment",
        severity: "medium",
        title: `Failed to mark ${order.source} order fulfilled`,
        description: `Order ${platformOrderId}: ${msg}`,
        metadata: {
          order_id: order.id,
          platform: order.source,
          platform_order_id: platformOrderId,
          tracking_number,
          error: msg,
        },
        group_key: `platform_fulfill:${order.id}`,
        status: "open",
      });

      return { success: false, error: msg };
    }
  },
});

async function markShopifyFulfilled(
  connection: { api_key: string | null; store_url: string },
  orderId: string,
  trackingNumber: string,
  carrier: string,
): Promise<void> {
  const apiKey = connection.api_key;
  if (!apiKey) throw new Error("Missing api_key for Shopify connection");

  const baseUrl = connection.store_url.replace(/\/$/, "");
  const headers = { "X-Shopify-Access-Token": apiKey, "Content-Type": "application/json" };

  const foRes = await fetch(
    `${baseUrl}/admin/api/2026-01/orders/${orderId}/fulfillment_orders.json`,
    { headers },
  );
  if (!foRes.ok) throw new Error(`Shopify fulfillment_orders ${foRes.status}`);

  const { fulfillment_orders } = (await foRes.json()) as {
    fulfillment_orders: Array<{ id: number; status: string }>;
  };
  const openFO = fulfillment_orders.find((fo) => fo.status === "open");
  if (!openFO) throw new Error("No open fulfillment order found on Shopify");

  const fulfillRes = await fetch(`${baseUrl}/admin/api/2026-01/fulfillments.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: openFO.id }],
        tracking_info: { number: trackingNumber, company: carrier },
        notify_customer: false, // AfterShip handles notifications
      },
    }),
  });

  if (!fulfillRes.ok) {
    const body = await fulfillRes.text();
    throw new Error(`Shopify fulfillment create ${fulfillRes.status}: ${body}`);
  }
}

async function markWooCommerceFulfilled(
  connection: {
    api_key: string | null;
    api_secret: string | null;
    store_url: string;
    metadata?: Record<string, unknown> | null;
  },
  orderId: string,
  trackingNumber: string,
  carrierName: string,
): Promise<void> {
  const { api_key, api_secret } = connection;
  if (!api_key || !api_secret) throw new Error("Missing credentials for WooCommerce connection");

  const baseUrl = connection.store_url.replace(/\/$/, "");
  const auth = Buffer.from(`${api_key}:${api_secret}`).toString("base64");

  const meta = connection.metadata as { tracking_meta_keys?: string[] } | null;
  const trackingMetaKeys = meta?.tracking_meta_keys ?? ["_tracking_number", "_tracking_provider"];

  const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders/${orderId}`, {
    method: "PUT",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      meta_data: [
        { key: trackingMetaKeys[0] ?? "_tracking_number", value: trackingNumber },
        { key: trackingMetaKeys[1] ?? "_tracking_provider", value: carrierName },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WooCommerce order update ${res.status}: ${body}`);
  }
}

async function markSquarespaceFulfilled(
  connection: { api_key: string | null; store_url: string },
  orderId: string,
  trackingNumber: string,
  carrierName: string,
): Promise<void> {
  const apiKey = connection.api_key;
  if (!apiKey) throw new Error("Missing api_key for Squarespace connection");

  const res = await fetch(
    `https://api.squarespace.com/1.0/commerce/orders/${orderId}/fulfillments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "ClandestineFulfillment/1.0",
      },
      body: JSON.stringify({
        shouldSendNotification: false,
        shipments: [
          {
            shipDate: new Date().toISOString(),
            carrierName,
            trackingNumber,
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Squarespace fulfillment ${res.status}: ${body}`);
  }
}

async function markDiscogsFulfilled(
  connection: {
    api_key: string | null;
    api_secret: string | null;
    metadata?: Record<string, unknown> | null;
  },
  orderId: string,
  trackingNumber: string,
  carrierName: string,
): Promise<void> {
  const { api_key, api_secret } = connection;
  if (!api_key || !api_secret) throw new Error("Missing OAuth tokens for Discogs connection");

  const oauth = new OAuth({
    consumer: {
      key: env().DISCOGS_CONSUMER_KEY,
      secret: env().DISCOGS_CONSUMER_SECRET,
    },
    signature_method: "PLAINTEXT",
    hash_function(_base, key) {
      return key;
    },
  });

  const token = { key: api_key, secret: api_secret };

  const messageUrl = `https://api.discogs.com/marketplace/orders/${orderId}/messages`;
  const messageData = {
    url: messageUrl,
    method: "POST",
    data: {
      message: `Your order has shipped! Tracking: ${trackingNumber}${carrierName ? ` via ${carrierName}` : ""}`,
      status: "Shipped",
    },
  };

  const authHeader = oauth.toHeader(oauth.authorize(messageData, token));
  const res = await fetch(messageUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader.Authorization,
      "User-Agent": "ClandestineFulfillment/1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: messageData.data.message,
      status: messageData.data.status,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs order message ${res.status}: ${body}`);
  }
}
```

---

**Next**: [03 Actions & UI](03-actions-and-ui.md) for server actions and portal/admin UI.
