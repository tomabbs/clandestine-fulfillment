# V7 Codebase Verification Report

Generated: 2026-03-24

This report answers all 15 audit checks and 5 owner-decision questions using the current codebase.
It also includes full source code for all files/migrations requested in the audit list.

---

## Part A: Direct Answers to the 15 Verification Questions

## 1) `warehouse_orders` schema — does `metadata` exist?

**Answer:** No. `warehouse_orders` does not currently have a `metadata` column.

**Evidence:**
- Base table in `supabase/migrations/20260316000004_orders.sql` has no `metadata`.
- Later migration `20260320000008_bandcamp_shipment_tracking.sql` adds `bandcamp_payment_id`, but still no `metadata`.
- Repo-wide migration scan finds no `ALTER TABLE warehouse_orders ... metadata`.

---

## 2) `inventory-fanout.ts` — what is the actual Bandcamp query?

**Answer:** It selects only `id` from `bandcamp_product_mappings`, then later checks `m.variant_id`, which is inconsistent.

**Current code detail:**
- Query: `.from("bandcamp_product_mappings").select("id").eq("workspace_id", workspaceId)`
- Later: `(bandcampMappings ?? []).some((m) => (m as Record<string, unknown>).variant_id === variant.id)`

This is a real mismatch.

---

## 3) `client_store_connections` schema — `api_key` or `access_token`?

**Answer:** Schema uses `api_key` and `api_secret` (not `access_token`).

**Evidence:** `supabase/migrations/20260316000011_store_connections.sql`:
- `api_key text`
- `api_secret text`

---

## 4) `aftership-client.ts` — current `createTracking` signature?

**Answer:** `createTracking(trackingNumber, carrier, metadata?)`; no `emails[]` support currently.

**Signature:**
- `createTracking(trackingNumber: string, carrier: string, metadata?: Record<string, unknown>)`

**Payload fields currently sent:**
- `tracking_number`
- `slug`
- optional `title`
- optional `order_id`

---

## 5) `aftership-register.ts` — does it already join `warehouse_orders`?

**Answer:** No. It only reads `warehouse_shipments` and does not join or fetch order email.

---

## 6) `bandcamp-order-sync.ts` — what fields does it set on insert?

**Answer:** It inserts many core fields (`workspace_id`, `org_id`, `bandcamp_payment_id`, `order_number`, customer, totals, `line_items`, `shipping_address`, `source`, `synced_at`) but **does not set `metadata`**.

---

## 7) `client-store-order-detect.ts` — does it set `metadata.platform_order_id`?

**Answer:** No. It inserts order fields directly (`shopify_order_id`, etc.) and does not set a `metadata` object.

---

## 8) `webhook_events` table — actual column names?

**Answer:** The audit claim is correct: table uses `platform` and `external_webhook_id` (not `source`/`event_id`).

**Evidence:** `supabase/migrations/20260316000008_monitoring.sql`:
- `platform text NOT NULL`
- `external_webhook_id text NOT NULL`
- `UNIQUE(platform, external_webhook_id)`

---

## 9) `warehouse_shipments` schema — what columns exist?

**Answer:** Confirmed:
- `label_data jsonb` exists.
- `bandcamp_payment_id bigint` exists (added in `20260320000008_bandcamp_shipment_tracking.sql`).
- `status` exists as `text DEFAULT 'shipped'` with **no CHECK constraint** in current migrations.

Also added later:
- `bandcamp_synced_at timestamptz`
- `is_drop_ship boolean DEFAULT false`
- `total_units integer DEFAULT 0`

---

## 10) `src/trigger/tasks/index.ts` — current exports?

**Answer:** ShipStation task is still exported:
- `export { shipstationPollTask } from "./shipstation-poll";`

---

## 11) Admin sidebar — current nav structure?

**Answer:** Top-level nav includes:
- Dashboard, Scan, Inventory, Inbound, Orders, Catalog, Clients, Shipping, Billing, Top Sellers, Review Q, Support.

No dedicated `SCAN Forms` item currently; only `Scan` at `/admin/scan`.

---

## 12) `query-keys.ts` — what namespaces exist?

**Answer:** Current namespaces:
- `products`
- `inventory`
- `orders`
- `shipments`
- `inbound`
- `billing`
- `support`
- `auth`
- `channels`
- `reviewQueue`
- `clients`
- `storeConnections`
- `pirateShipImports`
- `bandcamp`
- `storeMappings`
- `catalog`
- `clientReleases`

---

## 13) Portal layout — current implementation?

**Answer:** Yes, effectively minimal layout (25 lines) with UI shell only.
No auth/role guard or redirect logic in `src/app/portal/layout.tsx`.

---

## 14) `store-sync-client.ts` — structure, `markFulfilled`, Shopify API version?

**Answer:**
- Supports `shopify`, `squarespace`, `woocommerce`; `bigcommerce` throws not implemented.
- No `markFulfilled` interface/function exists.
- Shopify calls are hardcoded to `2024-01` in all endpoints in this file.

---

## 15) Discogs package — does `@lionralfs/discogs-client` exist?

**Answer:** Yes. `npm search` returns `@lionralfs/discogs-client` version `4.1.4` (published `2025-11-30`).

---

## Part B: Owner-Decision Questions (Codebase-Informed Recommendations)

## Q1) Bandcamp shipping address normalization

**Recommendation:** Use a small normalization function, not inline mapping.

Why:
- Same mapping will likely be needed in multiple tasks (order ingest, label creation, webhook fallback paths).
- Current inline mapping already transforms fields (`ship_to_street` -> `street1`, etc.), so extracting this is low risk and improves consistency.

**Sample payload shape available in code:** See `BandcampOrderItem` schema in `src/lib/clients/bandcamp.ts`:
- `ship_to_name`, `ship_to_street`, `ship_to_street_2`, `ship_to_city`, `ship_to_state`, `ship_to_zip`, `ship_to_country`, `ship_to_country_code`.

---

## Q2) Portal shipping page — should clients see `pending_manual`?

**Recommendation:** No. Hide raw internal status and map it to client-friendly "Processing" (or keep it fully internal and filter out).

Why:
- `pending_manual` is operational workflow language, not customer-facing language.
- Portal currently only offers known client-facing statuses and fallback renders unknown statuses verbatim.

---

## Q3) Post-onboarding store connection flow

**Recommendation:** **A)** Add `Connect Another Store` in portal settings.

Why:
- Current portal settings page shows existing connections and credential submission for pending rows, but no create action.
- There is no onboarding route under `src/app` currently, so option B is not immediately available.
- Option A is lowest friction for clients and aligns with existing settings UX.

---

## Q4) Shopify API version standardization

**Recommendation:** **A)** Keep `2024-01` for V7 unless there is a specific feature dependency on newer APIs.

Why:
- Current code uses `2024-01` consistently in production paths (`store-sync-client.ts`, `store-connections.ts`).
- Version uplift should be deliberate and tested as a separate migration item.

---

## Q5) PrintNode

**Recommendation:** **A)** Remove PrintNode references from V7 scope docs/code comments.

Why:
- No active PrintNode implementation in `src/`; references are currently doc-only.
- Keeping optional/commented references in a release plan creates scope ambiguity.

---

## Part C: Full Source Appendix (Requested Files)

## C1) `src/lib/server/inventory-fanout.ts`

```ts
/**
 * Inventory fanout — Rule #43 step (4).
 *
 * Called after recordInventoryChange succeeds.
 * Enqueues downstream pushes for affected SKU.
 */

import { tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface FanoutResult {
  storeConnectionsPushed: number;
  bandcampPushed: boolean;
}

/**
 * Determines which downstream systems need updating when an inventory SKU changes.
 * Pure logic — exported for testing.
 */
export function determineFanoutTargets(
  hasStoreConnections: boolean,
  hasBandcampMapping: boolean,
): { pushToStores: boolean; pushToBandcamp: boolean } {
  return {
    pushToStores: hasStoreConnections,
    pushToBandcamp: hasBandcampMapping,
  };
}

export async function fanoutInventoryChange(
  workspaceId: string,
  sku: string,
  _newQuantity: number,
): Promise<FanoutResult> {
  const supabase = createServiceRoleClient();
  let storeConnectionsPushed = 0;
  let bandcampPushed = false;

  // Check if SKU has store connection mappings
  const { data: skuMappings } = await supabase
    .from("client_store_sku_mappings")
    .select("connection_id")
    .eq("is_active", true)
    .eq("remote_sku", sku);

  // Check if SKU has a Bandcamp mapping
  const { data: bandcampMappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("id")
    .eq("workspace_id", workspaceId);

  // Get the variant for this SKU to check Bandcamp mapping
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();

  const hasBandcampMapping =
    variant &&
    (bandcampMappings ?? []).some((m) => (m as Record<string, unknown>).variant_id === variant.id);

  const targets = determineFanoutTargets((skuMappings ?? []).length > 0, !!hasBandcampMapping);

  // Enqueue multi-store push (it handles all connections)
  if (targets.pushToStores) {
    try {
      await tasks.trigger("multi-store-inventory-push", {});
      storeConnectionsPushed = (skuMappings ?? []).length;
    } catch {
      // Non-critical: the cron will pick it up in the next cycle
    }
  }

  // Enqueue Bandcamp push
  if (targets.pushToBandcamp) {
    try {
      await tasks.trigger("bandcamp-inventory-push", {});
      bandcampPushed = true;
    } catch {
      // Non-critical
    }
  }

  return { storeConnectionsPushed, bandcampPushed };
}
```

## C2) `src/lib/clients/aftership-client.ts`

```ts
/**
 * AfterShip API client.
 * Uses AFTERSHIP_API_KEY from env. Zod validation on responses (Rule #5).
 */

import { z } from "zod";
import { env } from "@/lib/shared/env";

const trackingSchema = z.object({
  id: z.string(),
  tracking_number: z.string(),
  slug: z.string(),
  active: z.boolean().optional(),
  tag: z.string().optional(),
  title: z.string().optional(),
  checkpoints: z
    .array(
      z.object({
        slug: z.string().optional(),
        tag: z.string(),
        message: z.string().optional(),
        location: z.string().nullish(),
        checkpoint_time: z.string(),
        subtag: z.string().optional(),
        subtag_message: z.string().optional(),
        city: z.string().nullish(),
        state: z.string().nullish(),
        country_name: z.string().nullish(),
      }),
    )
    .optional()
    .default([]),
});

const createTrackingResponseSchema = z.object({
  data: z.object({ tracking: trackingSchema }),
});

const getTrackingResponseSchema = z.object({
  data: z.object({ tracking: trackingSchema }),
});

export type AfterShipTracking = z.infer<typeof trackingSchema>;
export type AfterShipCheckpoint = AfterShipTracking["checkpoints"][number];

function getApiKey(): string {
  return env().AFTERSHIP_API_KEY;
}

async function aftershipFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const apiKey = getApiKey();
  const res = await fetch(`https://api.aftership.com/v4${path}`, {
    method: options.method ?? "GET",
    headers: {
      "aftership-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AfterShip API ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

export async function createTracking(
  trackingNumber: string,
  carrier: string,
  metadata?: Record<string, unknown>,
): Promise<AfterShipTracking> {
  const response = await aftershipFetch<z.infer<typeof createTrackingResponseSchema>>(
    "/trackings",
    {
      method: "POST",
      body: {
        tracking: {
          tracking_number: trackingNumber,
          slug: normalizeCarrierSlug(carrier),
          ...(metadata?.title ? { title: metadata.title } : {}),
          ...(metadata?.orderId ? { order_id: metadata.orderId } : {}),
        },
      },
    },
  );

  return createTrackingResponseSchema.parse(response).data.tracking;
}

export async function getTracking(
  trackingNumber: string,
  carrier: string,
): Promise<AfterShipTracking> {
  const slug = normalizeCarrierSlug(carrier);
  const response = await aftershipFetch<z.infer<typeof getTrackingResponseSchema>>(
    `/trackings/${slug}/${trackingNumber}`,
  );

  return getTrackingResponseSchema.parse(response).data.tracking;
}

/**
 * Normalize carrier names to AfterShip slugs.
 */
export function normalizeCarrierSlug(carrier: string): string {
  const normalized = carrier.toLowerCase().trim();
  const slugMap: Record<string, string> = {
    usps: "usps",
    ups: "ups",
    fedex: "fedex",
    dhl: "dhl",
    "dhl express": "dhl",
    "dhl ecommerce": "dhl-ecommerce",
    "canada post": "canada-post",
    "royal mail": "royal-mail",
    "australia post": "australia-post",
    pirateship: "usps",
    "pirate ship": "usps",
  };
  return slugMap[normalized] ?? normalized;
}
```

## C3) `src/trigger/tasks/aftership-register.ts`

```ts
/**
 * AfterShip tracking registration — event trigger.
 *
 * Receives shipment_id, registers tracking with AfterShip.
 * If AfterShip rejects (duplicate, invalid), creates review queue item.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { task } from "@trigger.dev/sdk";
import { createTracking } from "@/lib/clients/aftership-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const aftershipRegisterTask = task({
  id: "aftership-register",
  maxDuration: 30,
  run: async (payload: { shipment_id: string }) => {
    const supabase = createServiceRoleClient();

    const { data: shipment } = await supabase
      .from("warehouse_shipments")
      .select("id, tracking_number, carrier, order_id, org_id, workspace_id")
      .eq("id", payload.shipment_id)
      .single();

    if (!shipment) throw new Error(`Shipment ${payload.shipment_id} not found`);
    if (!shipment.tracking_number || !shipment.carrier) {
      return { skipped: true, reason: "no_tracking_info" };
    }

    try {
      const tracking = await createTracking(shipment.tracking_number, shipment.carrier, {
        title: `Shipment ${shipment.id}`,
        orderId: shipment.order_id,
      });

      return { registered: true, aftershipId: tracking.id };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isDuplicate = msg.includes("4003") || msg.includes("already exists");
      const isInvalid = msg.includes("4005") || msg.includes("invalid");

      if (isDuplicate) {
        return { registered: false, reason: "duplicate" };
      }

      // Create review queue item for unexpected errors
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: shipment.workspace_id,
        org_id: shipment.org_id,
        category: "tracking",
        severity: isInvalid ? "low" : "medium",
        title: `AfterShip registration failed: ${shipment.tracking_number}`,
        description: `Carrier: ${shipment.carrier}. Error: ${msg}`,
        metadata: {
          shipment_id: shipment.id,
          tracking_number: shipment.tracking_number,
          carrier: shipment.carrier,
          error: msg,
        },
        group_key: `aftership_register:${shipment.id}`,
        status: "open",
      });

      return { registered: false, reason: "error", error: msg };
    }
  },
});
```

## C4) `src/trigger/tasks/bandcamp-order-sync.ts`

```ts
/**
 * Bandcamp order sync — poll get_orders and create warehouse_orders.
 *
 * Rule #9: Uses bandcampQueue.
 * Rule #48: API calls in Trigger tasks.
 *
 * Creates warehouse_orders with bandcamp_payment_id so shipments can be linked.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export const bandcampOrderSyncTask = task({
  id: "bandcamp-order-sync",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = payload.workspaceId
      ? [payload.workspaceId]
      : await getAllWorkspaceIds(supabase);

    let totalCreated = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, org_id, band_id")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections?.length) continue;

      const accessToken = await refreshBandcampToken(workspaceId);

      for (const conn of connections) {
        try {
          const endTime = new Date();
          const startTime = new Date(endTime);
          startTime.setDate(startTime.getDate() - 30);

          const items = await getOrders(
            {
              bandId: conn.band_id,
              startTime: startTime.toISOString().replace("T", " ").slice(0, 19),
              endTime: endTime.toISOString().replace("T", " ").slice(0, 19),
            },
            accessToken,
          );

          // Group by payment_id (one order per payment)
          const byPayment = new Map<number, typeof items>();
          for (const item of items) {
            const list = byPayment.get(item.payment_id) ?? [];
            list.push(item);
            byPayment.set(item.payment_id, list);
          }

          for (const [paymentId, orderItems] of Array.from(byPayment.entries())) {
            const first = orderItems[0]!;
            const { data: existing } = await supabase
              .from("warehouse_orders")
              .select("id")
              .eq("workspace_id", workspaceId)
              .eq("bandcamp_payment_id", paymentId)
              .maybeSingle();

            if (existing) continue;

            const lineItems = orderItems.map((i: BandcampOrderItem) => ({
              sku: i.sku,
              title: i.item_name,
              quantity: i.quantity ?? 1,
              price: i.sub_total,
            }));

            const { error } = await supabase.from("warehouse_orders").insert({
              workspace_id: workspaceId,
              org_id: conn.org_id,
              bandcamp_payment_id: paymentId,
              order_number: `BC-${paymentId}`,
              customer_name: first.buyer_name,
              customer_email: first.buyer_email,
              financial_status: "paid",
              fulfillment_status: first.ship_date ? "fulfilled" : "unfulfilled",
              total_price: first.order_total ?? 0,
              currency: first.currency ?? "USD",
              line_items: lineItems,
              shipping_address: first.ship_to_name
                ? {
                    name: first.ship_to_name,
                    street1: first.ship_to_street,
                    street2: first.ship_to_street_2,
                    city: first.ship_to_city,
                    state: first.ship_to_state,
                    postalCode: first.ship_to_zip,
                    country: first.ship_to_country,
                    countryCode: first.ship_to_country_code,
                  }
                : null,
              source: "bandcamp",
              synced_at: new Date().toISOString(),
            });

            if (error) {
              logger.warn("Bandcamp order insert failed", {
                paymentId,
                error: error.message,
              });
              continue;
            }

            totalCreated++;
          }
        } catch (err) {
          logger.error("Bandcamp order sync failed", {
            connectionId: conn?.id,
            bandId: conn?.band_id,
            error: String(err),
          });
        }
      }
    }

    return { totalCreated };
  },
});

export const bandcampOrderSyncSchedule = schedules.task({
  id: "bandcamp-order-sync-cron",
  cron: "0 */6 * * *", // Every 6 hours
  queue: bandcampQueue,
  run: async () => {
    await bandcampOrderSyncTask.trigger({});
    return { ok: true };
  },
});
```

## C5) `src/trigger/tasks/client-store-order-detect.ts`

```ts
/**
 * Client store order detect — cron every 10 minutes.
 *
 * Polls each active client_store_connection for new orders.
 * Rule #65: Echo cancellation — if order quantities match last_pushed_quantity, it's our own push echoing.
 */

import { schedules } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";

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
              .eq("shopify_order_id", order.remoteOrderId)
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
                shopify_order_id: order.remoteOrderId,
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

## C6) `src/trigger/tasks/index.ts`

```ts
// Task registry — all task names exported from one place (Rule #58)

export { aftershipRegisterTask } from "./aftership-register";
export { bandcampInventoryPushTask } from "./bandcamp-inventory-push";
export {
  bandcampMarkShippedSchedule,
  bandcampMarkShippedTask,
} from "./bandcamp-mark-shipped";
export {
  bandcampOrderSyncSchedule,
  bandcampOrderSyncTask,
} from "./bandcamp-order-sync";
export { bandcampSalePollTask } from "./bandcamp-sale-poll";
export { bandcampScrapePageTask, bandcampSyncSchedule, bandcampSyncTask } from "./bandcamp-sync";
export { clientStoreOrderDetectTask } from "./client-store-order-detect";
export { inboundCheckinComplete } from "./inbound-checkin-complete";
export { inboundProductCreate } from "./inbound-product-create";
export { monthlyBillingTask } from "./monthly-billing";
export { multiStoreInventoryPushTask } from "./multi-store-inventory-push";
export { pirateShipImportTask } from "./pirate-ship-import";
export { preorderFulfillmentTask } from "./preorder-fulfillment";
export { preorderSetupTask } from "./preorder-setup";
export { processClientStoreWebhookTask } from "./process-client-store-webhook";
export { processShopifyWebhookTask } from "./process-shopify-webhook";
export { redisBackfillTask } from "./redis-backfill";
export { sensorCheckTask } from "./sensor-check";
export { shipmentIngestTask } from "./shipment-ingest";
export { shipstationPollTask } from "./shipstation-poll";
export { shopifyFullBackfillTask } from "./shopify-full-backfill";
export { shopifyOrderSyncTask } from "./shopify-order-sync";
export { shopifySyncTask } from "./shopify-sync";
export { storageCalcTask } from "./storage-calc";
export { supportEscalationTask } from "./support-escalation";
```

## C7) `src/components/admin/admin-sidebar.tsx`

```tsx
"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  AlertCircle,
  ChevronDown,
  LayoutDashboard,
  Library,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Package,
  PackagePlus,
  Receipt,
  ScanBarcode,
  Settings,
  ShoppingCart,
  Sun,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { useTheme } from "@/contexts/ThemeContext";

const NAV_ITEMS = [
  { title: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { title: "Scan", href: "/admin/scan", icon: ScanBarcode },
  { title: "Inventory", href: "/admin/inventory", icon: Package },
  { title: "Inbound", href: "/admin/inbound", icon: PackagePlus },
  { title: "Orders", href: "/admin/orders", icon: ShoppingCart },
  { title: "Catalog", href: "/admin/catalog", icon: Library },
  { title: "Clients", href: "/admin/clients", icon: Users },
  { title: "Shipping", href: "/admin/shipping", icon: Truck },
  { title: "Billing", href: "/admin/billing", icon: Receipt },
  { title: "Top Sellers", href: "/admin/reports/top-sellers", icon: TrendingUp },
  { title: "Review Q", href: "/admin/review-queue", icon: AlertCircle },
  { title: "Support", href: "/admin/support", icon: MessageSquare },
] as const;

const SETTINGS_ITEMS = [
  { title: "General", href: "/admin/settings" },
  { title: "Users", href: "/admin/settings/users" },
  { title: "Bandcamp Accounts", href: "/admin/settings/bandcamp" },
  { title: "Store Connections", href: "/admin/settings/store-connections" },
  { title: "Store Mapping", href: "/admin/settings/store-mapping" },
  { title: "Channels", href: "/admin/channels" },
  { title: "Integrations", href: "/admin/settings/integrations" },
  { title: "Health", href: "/admin/settings/health" },
] as const;

export function AdminSidebar() {
  const pathname = usePathname();
  const supabaseRef = useRef<ReturnType<typeof createBrowserClient> | null>(null);

  function getSupabase() {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      );
    }
    return supabaseRef.current;
  }

  async function handleLogout() {
    await getSupabase().auth.signOut();
    window.location.href = "/login";
  }

  return (
    <Sidebar>
      <SidebarHeader className="border-b px-4 py-3">
        <Image
          src="/logo.webp"
          alt="Clandestine Distribution"
          width={216}
          height={43}
          priority
          className="h-auto w-auto"
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={pathname === item.href}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              {/* Settings collapsible */}
              <Collapsible
                defaultOpen={pathname.startsWith("/admin/settings")}
                className="group/collapsible"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger render={<SidebarMenuButton />}>
                    <Settings />
                    <span>Settings</span>
                    <ChevronDown className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {SETTINGS_ITEMS.map((item) => (
                        <SidebarMenuSubItem key={item.href}>
                          <SidebarMenuSubButton
                            render={<Link href={item.href} />}
                            isActive={pathname === item.href}
                          >
                            {item.title}
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <ThemeToggle />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton />}>
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-xs">CF</AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">Staff User</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const options = [
    { value: "light" as const, icon: Sun, label: "Light" },
    { value: "dark" as const, icon: Moon, label: "Dark" },
    { value: "system" as const, icon: Monitor, label: "System" },
  ];

  return (
    <div className="flex items-center justify-center gap-1 px-3 py-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.label}
          onClick={() => setTheme(opt.value)}
          className={`rounded-md p-1.5 transition-colors ${
            theme === opt.value
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          }`}
        >
          <opt.icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
```

## C8) `src/lib/shared/query-keys.ts`

```ts
export const queryKeys = {
  products: {
    all: ["products"] as const,
    list: (filters?: Record<string, unknown>) => ["products", "list", filters] as const,
    detail: (id: string) => ["products", "detail", id] as const,
  },
  inventory: {
    all: ["inventory"] as const,
    list: (filters?: Record<string, unknown>) => ["inventory", "list", filters] as const,
    detail: (sku: string) => ["inventory", "detail", sku] as const,
  },
  orders: {
    all: ["orders"] as const,
    list: (filters?: Record<string, unknown>) => ["orders", "list", filters] as const,
    detail: (id: string) => ["orders", "detail", id] as const,
  },
  shipments: {
    all: ["shipments"] as const,
    list: (filters?: Record<string, unknown>) => ["shipments", "list", filters] as const,
    detail: (id: string) => ["shipments", "detail", id] as const,
    summary: (filters?: Record<string, unknown>) => ["shipments", "summary", filters] as const,
  },
  inbound: {
    all: ["inbound"] as const,
    list: (filters?: Record<string, unknown>) => ["inbound", "list", filters] as const,
    detail: (id: string) => ["inbound", "detail", id] as const,
  },
  billing: {
    all: ["billing"] as const,
    rules: () => ["billing", "rules"] as const,
    overrides: () => ["billing", "overrides"] as const,
    snapshots: (filters?: Record<string, unknown>) => ["billing", "snapshots", filters] as const,
  },
  support: {
    all: ["support"] as const,
    conversations: (filters?: Record<string, unknown>) =>
      ["support", "conversations", filters] as const,
    messages: (conversationId: string) => ["support", "messages", conversationId] as const,
    viewerContext: () => ["support", "viewer-context"] as const,
  },
  auth: {
    all: ["auth"] as const,
    userContext: () => ["auth", "user-context"] as const,
  },
  channels: {
    all: ["channels"] as const,
    syncStatus: (channel?: string) => ["channels", "sync-status", channel] as const,
  },
  reviewQueue: {
    all: ["review-queue"] as const,
    list: (filters?: Record<string, unknown>) => ["review-queue", "list", filters] as const,
  },
  clients: {
    all: ["clients"] as const,
    list: () => ["clients", "list"] as const,
    detail: (id: string) => ["clients", "detail", id] as const,
    products: (id: string, filters?: Record<string, unknown>) =>
      ["clients", "products", id, filters] as const,
    shipments: (id: string, filters?: Record<string, unknown>) =>
      ["clients", "shipments", id, filters] as const,
    sales: (id: string) => ["clients", "sales", id] as const,
    billing: (id: string) => ["clients", "billing", id] as const,
    stores: (id: string) => ["clients", "stores", id] as const,
    settings: (id: string) => ["clients", "settings", id] as const,
    supportHistory: (id: string) => ["clients", "support-history", id] as const,
    aliases: (id: string) => ["clients", "aliases", id] as const,
    presence: (orgIds: string[], onlineUserIds: string[]) =>
      ["clients", "presence", orgIds, onlineUserIds] as const,
  },
  storeConnections: {
    all: ["store-connections"] as const,
    list: (orgId?: string) => ["store-connections", "list", orgId] as const,
  },
  pirateShipImports: {
    all: ["pirate-ship-imports"] as const,
    list: (filters?: Record<string, unknown>) => ["pirate-ship-imports", "list", filters] as const,
    detail: (id: string) => ["pirate-ship-imports", "detail", id] as const,
  },
  bandcamp: {
    all: ["bandcamp"] as const,
    accounts: (workspaceId: string) => ["bandcamp", "accounts", workspaceId] as const,
    mappings: (orgId: string) => ["bandcamp", "mappings", orgId] as const,
  },
  storeMappings: {
    all: ["store-mappings"] as const,
    list: (workspaceId: string) => ["store-mappings", "list", workspaceId] as const,
  },
  catalog: {
    all: ["catalog"] as const,
    list: (filters?: Record<string, unknown>) => ["catalog", "list", filters] as const,
  },
  clientReleases: {
    all: ["client-releases"] as const,
    list: () => ["client-releases", "list"] as const,
  },
} as const;
```

## C9) `src/app/portal/layout.tsx`

```tsx
"use client";

import { PortalPresenceTracker } from "@/components/portal/portal-presence-tracker";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { CommandPalette } from "@/components/shared/command-palette";
import { SupportLauncher } from "@/components/support/support-launcher";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider data-warehouse-theme>
      <PortalSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <main className="flex-1">{children}</main>
      </SidebarInset>
      <CommandPalette />
      <SupportLauncher supportPath="/portal/support" />
      <PortalPresenceTracker />
    </SidebarProvider>
  );
}
```

## C10) `src/lib/clients/store-sync-client.ts`

```ts
import type { ClientStoreConnection } from "@/lib/shared/types";

// Unified store sync interface — dispatches to platform-specific clients.
// Rule #44: WooCommerce uses absolute quantities via updateStockQuantity.
// Rule #15: Idempotency keys must be stable per logical adjustment.

export interface StoreSyncClient {
  /** Push inventory quantity to the remote store for a given SKU */
  pushInventory(sku: string, quantity: number, idempotencyKey: string): Promise<void>;
  /** Get the current remote quantity for a SKU */
  getRemoteQuantity(sku: string): Promise<number | null>;
  /** Get orders since a given ISO timestamp */
  getOrders(since: string): Promise<RemoteOrder[]>;
}

export interface RemoteOrder {
  remoteOrderId: string;
  orderNumber: string;
  createdAt: string;
  lineItems: Array<{
    sku: string;
    quantity: number;
    remoteProductId: string;
    remoteVariantId: string | null;
  }>;
}

interface SkuMappingContext {
  remoteProductId: string | null;
  remoteVariantId: string | null;
}

export function createStoreSyncClient(
  connection: ClientStoreConnection,
  skuMappings?: Map<string, SkuMappingContext>,
): StoreSyncClient {
  switch (connection.platform) {
    case "shopify":
      return createShopifySync(connection);
    case "squarespace":
      return createSquarespaceSync(connection);
    case "woocommerce":
      return createWooCommerceSync(connection, skuMappings);
    case "bigcommerce":
      throw new Error("BigCommerce sync not yet implemented");
    default:
      throw new Error(`Unsupported platform: ${connection.platform}`);
  }
}

// === Shopify sync ===

function createShopifySync(connection: ClientStoreConnection): StoreSyncClient {
  const apiKey = connection.api_key;
  if (!apiKey) throw new Error("Shopify connection missing api_key");

  const baseUrl = connection.store_url.replace(/\/$/, "");
  const headers = {
    "X-Shopify-Access-Token": apiKey,
    "Content-Type": "application/json",
  };

  async function findVariantBySku(
    sku: string,
  ): Promise<{ variantId: number; inventoryItemId: number } | null> {
    const res = await fetch(
      `${baseUrl}/admin/api/2024-01/variants.json?sku=${encodeURIComponent(sku)}`,
      { headers },
    );
    if (!res.ok) throw new Error(`Shopify variant lookup failed: HTTP ${res.status}`);
    const { variants } = (await res.json()) as {
      variants: Array<{ id: number; inventory_item_id: number; sku: string }>;
    };
    const match = variants.find((v) => v.sku === sku);
    if (!match) return null;
    return { variantId: match.id, inventoryItemId: match.inventory_item_id };
  }

  async function getLocationAndQuantity(
    inventoryItemId: number,
  ): Promise<{ locationId: number; available: number } | null> {
    const res = await fetch(
      `${baseUrl}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${inventoryItemId}`,
      { headers },
    );
    if (!res.ok) throw new Error(`Shopify inventory levels fetch failed: HTTP ${res.status}`);
    const { inventory_levels } = (await res.json()) as {
      inventory_levels: Array<{ location_id: number; available: number }>;
    };
    const level = inventory_levels[0];
    if (!level) return null;
    return { locationId: level.location_id, available: level.available };
  }

  return {
    async pushInventory(sku, quantity, _idempotencyKey) {
      const variant = await findVariantBySku(sku);
      if (!variant) {
        console.warn(`[ShopifySync] SKU ${sku} not found in client store — skipping push`);
        return;
      }

      const level = await getLocationAndQuantity(variant.inventoryItemId);
      if (!level) {
        console.warn(`[ShopifySync] No inventory level for SKU ${sku} — skipping push`);
        return;
      }

      const res = await fetch(`${baseUrl}/admin/api/2024-01/inventory_levels/set.json`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          location_id: level.locationId,
          inventory_item_id: variant.inventoryItemId,
          available: quantity,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Shopify inventory set failed: HTTP ${res.status} — ${body}`);
      }
    },

    async getRemoteQuantity(sku) {
      const variant = await findVariantBySku(sku);
      if (!variant) return null;

      const level = await getLocationAndQuantity(variant.inventoryItemId);
      return level?.available ?? null;
    },

    async getOrders(since) {
      const res = await fetch(
        `${baseUrl}/admin/api/2024-01/orders.json?created_at_min=${encodeURIComponent(since)}&status=any&limit=50`,
        { headers },
      );
      if (!res.ok) throw new Error(`Shopify orders fetch failed: HTTP ${res.status}`);
      const { orders } = (await res.json()) as {
        orders: Array<{
          id: number;
          name: string;
          created_at: string;
          line_items: Array<{
            sku: string;
            quantity: number;
            product_id: number;
            variant_id: number;
          }>;
        }>;
      };

      return orders.map((o) => ({
        remoteOrderId: String(o.id),
        orderNumber: o.name,
        createdAt: o.created_at,
        lineItems: o.line_items.map((li) => ({
          sku: li.sku ?? "",
          quantity: li.quantity,
          remoteProductId: String(li.product_id),
          remoteVariantId: li.variant_id ? String(li.variant_id) : null,
        })),
      }));
    },
  };
}

// === Squarespace sync ===

function createSquarespaceSync(connection: ClientStoreConnection): StoreSyncClient {
  const apiKey = connection.api_key;
  if (!apiKey) throw new Error("Squarespace connection missing api_key");

  return {
    async pushInventory(sku, quantity, idempotencyKey) {
      const { getInventory, adjustInventory } = await import("./squarespace-client");

      // Find variant by SKU in remote inventory
      const inventory = await getInventory(apiKey, connection.store_url);
      const item = inventory.find((i) => i.sku === sku);
      if (!item) throw new Error(`SKU ${sku} not found in Squarespace inventory`);

      // Squarespace uses delta adjustments, so compute delta from current
      const delta = quantity - item.quantity;
      if (delta === 0) return;

      await adjustInventory(apiKey, connection.store_url, item.variantId, delta, idempotencyKey);
    },

    async getRemoteQuantity(sku) {
      const { getInventory } = await import("./squarespace-client");
      const inventory = await getInventory(apiKey, connection.store_url);
      const item = inventory.find((i) => i.sku === sku);
      return item?.quantity ?? null;
    },

    async getOrders(since) {
      const { getOrders } = await import("./squarespace-client");
      const { orders } = await getOrders(apiKey, connection.store_url, {
        modifiedAfter: since,
      });

      return orders.map((o) => ({
        remoteOrderId: o.id,
        orderNumber: o.orderNumber,
        createdAt: o.createdOn,
        lineItems: o.lineItems.map((li) => ({
          sku: li.sku ?? "",
          quantity: li.quantity,
          remoteProductId: li.variantId ?? "",
          remoteVariantId: li.variantId ?? null,
        })),
      }));
    },
  };
}

// === WooCommerce sync ===
// Rule #44: WooCommerce uses absolute quantities, not deltas

function createWooCommerceSync(
  connection: ClientStoreConnection,
  skuMappings?: Map<string, SkuMappingContext>,
): StoreSyncClient {
  if (!connection.api_key || !connection.api_secret) {
    throw new Error("WooCommerce connection missing api_key or api_secret");
  }

  const credentials = {
    consumerKey: connection.api_key,
    consumerSecret: connection.api_secret,
    siteUrl: connection.store_url,
  };

  return {
    async pushInventory(sku, quantity, _idempotencyKey) {
      const { getProductBySku, updateStockQuantity } = await import("./woocommerce-client");

      // Use mapping if available, otherwise look up by SKU
      const mapping = skuMappings?.get(sku);
      let productId: number;

      if (mapping?.remoteProductId) {
        productId = Number(mapping.remoteProductId);
      } else {
        const product = await getProductBySku(credentials, sku);
        if (!product) throw new Error(`SKU ${sku} not found in WooCommerce`);
        productId = product.id;
      }

      // Rule #44: absolute quantity, not delta
      await updateStockQuantity(credentials, productId, quantity);
    },

    async getRemoteQuantity(sku) {
      const { getProductBySku } = await import("./woocommerce-client");
      const product = await getProductBySku(credentials, sku);
      return product?.stock_quantity ?? null;
    },

    async getOrders(since) {
      const { getOrders } = await import("./woocommerce-client");
      const orders = await getOrders(credentials, { after: since });

      return orders.map((o) => ({
        remoteOrderId: String(o.id),
        orderNumber: o.number,
        createdAt: o.date_created,
        lineItems: o.line_items.map((li) => ({
          sku: li.sku,
          quantity: li.quantity,
          remoteProductId: String(li.product_id),
          remoteVariantId: li.variation_id ? String(li.variation_id) : null,
        })),
      }));
    },
  };
}
```

## C11) `supabase/migrations/20260316000004_orders.sql`

```sql
-- Migration 004: Orders, shipments, tracking events

CREATE TABLE warehouse_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  shopify_order_id text,
  order_number text,
  customer_name text,
  customer_email text,
  financial_status text,
  fulfillment_status text,
  total_price numeric,
  currency text DEFAULT 'USD',
  line_items jsonb DEFAULT '[]',
  shipping_address jsonb,
  tags text[] DEFAULT '{}',
  is_preorder boolean DEFAULT false,
  street_date date,
  source text DEFAULT 'shopify' CHECK (source IN ('shopify', 'bandcamp', 'woocommerce', 'squarespace', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE INDEX idx_orders_org ON warehouse_orders(org_id);
CREATE INDEX idx_orders_shopify ON warehouse_orders(shopify_order_id);
CREATE INDEX idx_orders_created ON warehouse_orders(created_at DESC);

CREATE TABLE warehouse_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  shipstation_shipment_id text,
  order_id uuid REFERENCES warehouse_orders(id),
  tracking_number text,
  carrier text,
  service text,
  ship_date date,
  delivery_date date,
  status text DEFAULT 'shipped',
  shipping_cost numeric,
  weight numeric,
  dimensions jsonb,
  label_data jsonb,
  voided boolean DEFAULT false,
  billed boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shipments_org ON warehouse_shipments(org_id);
CREATE INDEX idx_shipments_tracking ON warehouse_shipments(tracking_number);
CREATE INDEX idx_shipments_ship_date ON warehouse_shipments(ship_date DESC);

CREATE TABLE warehouse_tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES warehouse_shipments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  status text NOT NULL,
  description text,
  location text,
  event_time timestamptz,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tracking_shipment ON warehouse_tracking_events(shipment_id);
```

## C12) `supabase/migrations/20260316000011_store_connections.sql`

```sql
-- Migration 011: Client store connections and SKU mappings
-- Rule #19: Client credential submission uses service_role (bypasses RLS)
-- Rule #28: Store connection health columns (last_webhook_at, last_poll_at, last_error_at, last_error)
-- Rule #44: last_pushed_quantity / last_pushed_at for WooCommerce drift tracking
-- Rule #53: do_not_fanout flag + connection_status for circuit breakers

CREATE TABLE client_store_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  platform text NOT NULL CHECK (platform IN ('shopify', 'woocommerce', 'squarespace', 'bigcommerce')),
  store_url text NOT NULL,
  api_key text,
  api_secret text,
  webhook_url text,
  webhook_secret text,
  connection_status text NOT NULL DEFAULT 'pending' CHECK (connection_status IN ('pending', 'active', 'disabled_auth_failure', 'error')),
  last_webhook_at timestamptz,
  last_poll_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  do_not_fanout boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_store_connections_org ON client_store_connections(org_id);

CREATE TABLE client_store_sku_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id),
  remote_product_id text,
  remote_variant_id text,
  remote_sku text,
  last_pushed_quantity integer,
  last_pushed_at timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sku_mappings_connection ON client_store_sku_mappings(connection_id);
CREATE INDEX idx_sku_mappings_variant ON client_store_sku_mappings(variant_id);

-- RLS: client_store_connections
-- Staff: full CRUD
-- Clients: SELECT own org only (service_role handles credential writes per Rule #19)
ALTER TABLE client_store_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON client_store_connections FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON client_store_connections FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- RLS: client_store_sku_mappings
-- Staff: full CRUD
-- Clients: SELECT where connection.org_id matches their org (join-based)
ALTER TABLE client_store_sku_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON client_store_sku_mappings FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON client_store_sku_mappings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_store_connections csc
    WHERE csc.id = client_store_sku_mappings.connection_id
    AND csc.org_id = get_user_org_id()
  ));
```

## C13) `supabase/migrations/20260316000008_monitoring.sql`

```sql
-- Migration 008: Review queue, billing snapshots, webhook dedup, sync log, sensors, RPCs
-- Rule #22: persist_billing_snapshot RPC — billing math in TS, row locking in Postgres
-- Rule #37/#62: webhook_events table with UNIQUE(platform, external_webhook_id) for dedup
-- Rule #64: record_inventory_change_txn RPC — single ACID transaction for inventory mutations

CREATE TABLE warehouse_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid REFERENCES organizations(id),
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title text NOT NULL,
  description text,
  metadata jsonb DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'suppressed')),
  assigned_to uuid REFERENCES users(id),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  sla_due_at timestamptz,
  suppressed_until timestamptz,
  group_key text,
  occurrence_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_queue_status ON warehouse_review_queue(status);
CREATE INDEX idx_review_queue_severity ON warehouse_review_queue(severity);
CREATE INDEX idx_review_queue_group_key ON warehouse_review_queue(group_key);

CREATE TABLE warehouse_billing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  billing_period text NOT NULL,
  snapshot_data jsonb NOT NULL,
  grand_total numeric NOT NULL,
  total_shipping numeric,
  total_pick_pack numeric,
  total_materials numeric,
  total_storage numeric,
  total_adjustments numeric,
  stripe_invoice_id text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, org_id, billing_period)
);

-- Add FK from billing_adjustments to snapshots now that the target table exists
ALTER TABLE warehouse_billing_adjustments
  ADD CONSTRAINT fk_billing_adj_snapshot
  FOREIGN KEY (snapshot_id) REFERENCES warehouse_billing_snapshots(id);

-- Rule #37/#62: Webhook dedup table — atomic INSERT ON CONFLICT for all platforms
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  platform text NOT NULL,
  external_webhook_id text NOT NULL,
  topic text,
  status text DEFAULT 'received',
  processed_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(platform, external_webhook_id)
);
CREATE INDEX idx_webhook_events_platform ON webhook_events(platform, created_at DESC);

CREATE TABLE channel_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel text NOT NULL,
  sync_type text,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'partial', 'failed')),
  items_processed integer DEFAULT 0,
  items_failed integer DEFAULT 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sensor_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sensor_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy', 'warning', 'critical')),
  value jsonb,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sensor_readings_name ON sensor_readings(sensor_name, created_at DESC);

-- Rule #22: persist_billing_snapshot RPC
-- Billing math stays in TypeScript; row locking stays in Postgres.
-- JS keys must EXACTLY match PL/pgSQL argument names (including p_ prefix).
CREATE OR REPLACE FUNCTION persist_billing_snapshot(
  p_workspace_id uuid,
  p_org_id uuid,
  p_billing_period text,
  p_snapshot_data jsonb,
  p_grand_total numeric,
  p_total_shipping numeric,
  p_total_pick_pack numeric,
  p_total_materials numeric,
  p_total_storage numeric,
  p_total_adjustments numeric
) RETURNS uuid AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO warehouse_billing_snapshots (
    id, workspace_id, org_id, billing_period, snapshot_data,
    grand_total, total_shipping, total_pick_pack, total_materials,
    total_storage, total_adjustments, status
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_org_id, p_billing_period, p_snapshot_data,
    p_grand_total, p_total_shipping, p_total_pick_pack, p_total_materials,
    p_total_storage, p_total_adjustments, 'draft'
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Rule #64: record_inventory_change_txn RPC
-- Wraps the inventory level update + activity log insert in a single ACID transaction.
-- Sequential PostgREST calls (.update then .insert) are NOT transactional — this RPC is.
CREATE OR REPLACE FUNCTION record_inventory_change_txn(
  p_workspace_id uuid,
  p_sku text,
  p_delta integer,
  p_source text,
  p_correlation_id text,
  p_metadata jsonb DEFAULT '{}'
) RETURNS jsonb AS $$
DECLARE
  v_previous integer;
  v_new integer;
BEGIN
  UPDATE warehouse_inventory_levels
  SET available = available + p_delta,
      updated_at = now(),
      last_redis_write_at = now()
  WHERE workspace_id = p_workspace_id AND sku = p_sku
  RETURNING available - p_delta, available INTO v_previous, v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No inventory level found for workspace=% sku=%', p_workspace_id, p_sku;
  END IF;

  INSERT INTO warehouse_inventory_activity (
    id, workspace_id, sku, delta, source, correlation_id,
    previous_quantity, new_quantity, metadata
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_sku, p_delta, p_source, p_correlation_id,
    v_previous, v_new, p_metadata
  );

  RETURN jsonb_build_object('previous', v_previous, 'new', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

## C14) `supabase/migrations/20260320000008_bandcamp_shipment_tracking.sql`

```sql
-- Bandcamp order + shipment tracking integration
-- bandcamp_payment_id on warehouse_orders: links Bandcamp orders we ingest via get_orders
-- bandcamp_payment_id on warehouse_shipments: used to call update_shipped with carrier + tracking
ALTER TABLE warehouse_orders ADD COLUMN IF NOT EXISTS bandcamp_payment_id bigint;
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS bandcamp_payment_id bigint;
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS bandcamp_synced_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_orders_bandcamp_payment ON warehouse_orders(bandcamp_payment_id) WHERE bandcamp_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_bandcamp_payment ON warehouse_shipments(bandcamp_payment_id) WHERE bandcamp_payment_id IS NOT NULL;
```

## C15) `supabase/migrations/20260318000004_drop_ship.sql`

```sql
-- Add drop-ship support columns

-- Flag on store mapping to identify drop-ship stores
ALTER TABLE warehouse_shipstation_stores ADD COLUMN IF NOT EXISTS is_drop_ship boolean DEFAULT false;

-- Flag on shipment to indicate drop-ship billing
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS is_drop_ship boolean DEFAULT false;

-- Total units in shipment (for drop-ship per-unit billing)
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS total_units integer DEFAULT 0;
```

## C16) Supporting source for Q1 (Bandcamp order payload fields)

`src/lib/clients/bandcamp.ts` defines:
- `ship_to_name`
- `ship_to_street`
- `ship_to_street_2`
- `ship_to_city`
- `ship_to_state`
- `ship_to_zip`
- `ship_to_country`
- `ship_to_country_code`

(This report omits full `bandcamp.ts` only because it was not part of the original 15 requested `cat` targets; add full file appendix if desired.)

---

## Part D: Optional Immediate Fix Targets (if you want me to patch next)

1) `inventory-fanout.ts`: select `variant_id` (or all needed fields) from `bandcamp_product_mappings`.
2) `aftership-client.ts` + `aftership-register.ts`: add optional `emails` payload and pass `warehouse_orders.customer_email`.
3) `client-store-order-detect.ts`: decide canonical external-id strategy (dedupe key) and avoid overloading `shopify_order_id` for non-Shopify sources.
4) Portal/store-connection UX: add `Connect Another Store` in `portal/settings`.
5) Doc cleanup: remove PrintNode references from V7 docs if intentionally out-of-scope.
