# Clandestine Fulfillment — Inventory System Audit

**Date:** April 6, 2026
**Scope:** Full inventory data pipeline — Supabase, Redis, Shopify, Bandcamp, multi-store push
**Method:** Direct source code reading + live database queries via service-role client

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Database Schema](#2-database-schema)
3. [Architecture: Data Flow](#3-architecture-data-flow)
4. [Code Map: Every File That Touches Inventory](#4-code-map-every-file-that-touches-inventory)
5. [How Each Data Path Works](#5-how-each-data-path-works)
6. [Live Database Snapshot](#6-live-database-snapshot-april-6-2026)
7. [Background Jobs Schedule](#7-background-jobs-schedule)
8. [Issues and Risks](#8-issues-and-risks)
9. [Recommendations](#9-recommendations)
10. [Bandcamp Live Inventory Seed Data (April 9, 2026)](#10-bandcamp-live-inventory-seed-data-april-9-2026)

---

## 1. Executive Summary

Clandestine Fulfillment is a 3PL warehouse management app for independent record labels. It manages physical inventory (vinyl, CDs, cassettes, merch) across multiple sales channels.

### Three Storage Layers

| Layer | Technology | Role |
|-------|-----------|------|
| **Source of truth** | Supabase Postgres (`yspmgzphxlkcnfalndbh.supabase.co`) | All inventory tables, audit log, RLS-protected |
| **Fast-read cache** | Upstash Redis (`smooth-goldfish-38578.upstash.io`) | Per-SKU hash (`inv:{sku}`) for instant lookups |
| **Upstream catalog** | Shopify (`kw16ph-t9.myshopify.com`) | Product/variant/inventory source, synced every 15 min |

### Current State (live data)

| Metric | Count |
|--------|-------|
| Products in database | 3,764 |
| Variants (SKUs) | 2,875 |
| Inventory level rows | 1,046 |
| Variants with positive stock | 479 |
| Variants with NO inventory tracking | ~992 (34.5%) |
| Organizations (labels) | 175 |
| Bandcamp connections | 17 |
| Activity log entries | 2,164 |

**Key finding:** Over a third of all variants have no inventory level row at all. They exist in the catalog but are invisible to the inventory system.

---

## 2. Database Schema

### 2.1 `warehouse_products`

The product catalog, synced from Shopify. One row per product.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK | |
| `workspace_id` | uuid | FK → workspaces | |
| `org_id` | uuid | FK → organizations, NOT NULL | |
| `shopify_product_id` | text | UNIQUE(workspace_id, shopify_product_id) | |
| `title` | text | NOT NULL | |
| `vendor` | text | | Shopify vendor field |
| `product_type` | text | | |
| `status` | text | CHECK: active/draft/archived | Synced directly from Shopify |
| `tags` | text[] | | |
| `shopify_handle` | text | | |
| `images` | jsonb | | Array of `{src: url}` |
| `created_at` | timestamptz | | |
| `updated_at` | timestamptz | | |
| `synced_at` | timestamptz | | Last Shopify sync timestamp |

**Indexes:** `org_id`, `workspace_id`, `shopify_product_id`

### 2.2 `warehouse_product_variants`

SKU-level variant data. One row per purchasable item.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK | |
| `product_id` | uuid | FK → warehouse_products (CASCADE) | |
| `workspace_id` | uuid | FK → workspaces | |
| `sku` | text | NOT NULL, UNIQUE(workspace_id, sku) | |
| `shopify_variant_id` | text | | Shopify GID |
| `shopify_inventory_item_id` | text | | Used by webhook handler |
| `title` | text | | |
| `price` | numeric | | |
| `compare_at_price` | numeric | | |
| `barcode` | text | | |
| `weight` | numeric | | |
| `weight_unit` | text | | |
| `option1_name` | text | | |
| `option1_value` | text | | |
| `format_name` | text | | LP, CD, Cassette, etc. |
| `street_date` | date | | |
| `is_preorder` | boolean | | |
| `bandcamp_url` | text | | |
| `media_mail_eligible` | boolean | | |
| `hs_tariff_code` | text | Default `8523.80` | |
| `cost` | numeric | | Defaults to 50% of price on first sync |

**Indexes:** `product_id`, `(workspace_id, sku)`, `shopify_variant_id`, `barcode`

### 2.3 `warehouse_inventory_levels`

The core inventory table. One row per tracked variant.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK | |
| `variant_id` | uuid | FK → variants (CASCADE), UNIQUE | |
| `workspace_id` | uuid | FK → workspaces | |
| `org_id` | uuid | FK → organizations | Auto-derived by trigger |
| `sku` | text | NOT NULL | |
| `available` | integer | NOT NULL DEFAULT 0 | Current sellable stock |
| `committed` | integer | NOT NULL DEFAULT 0 | Reserved for orders |
| `incoming` | integer | NOT NULL DEFAULT 0 | Expected from suppliers |
| `safety_stock` | integer | | NULL = use workspace default (3) |
| `allow_negative_stock` | boolean | NOT NULL DEFAULT false | |
| `last_redis_write_at` | timestamptz | | Race-condition guard for backfill |
| `created_at` | timestamptz | | |
| `updated_at` | timestamptz | | |

**Indexes:** `(workspace_id, sku)`, `org_id`

**Trigger:** `derive_inventory_org_id()` — BEFORE INSERT OR UPDATE, auto-populates `org_id` by joining variant → product → org.

### 2.4 `warehouse_inventory_activity`

Append-only audit log. Every inventory mutation creates a row here.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK | |
| `workspace_id` | uuid | FK → workspaces | |
| `sku` | text | NOT NULL | |
| `delta` | integer | NOT NULL | Positive = stock added, negative = stock removed |
| `source` | text | NOT NULL, CHECK | shopify/bandcamp/squarespace/woocommerce/shipstation/manual/inbound/preorder/backfill |
| `correlation_id` | text | NOT NULL, UNIQUE(sku, correlation_id) | Idempotency key |
| `previous_quantity` | integer | | |
| `new_quantity` | integer | | |
| `metadata` | jsonb | | Source-specific context |
| `created_at` | timestamptz | | |

**Indexes:** `sku`, `created_at DESC`

### 2.5 `warehouse_locations` / `warehouse_variant_locations`

Physical location tracking (shelf, bin, floor, staging).

**`warehouse_locations`:**

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK |
| `name` | text | NOT NULL, UNIQUE(workspace_id, name) |
| `barcode` | text | |
| `location_type` | text | CHECK: shelf/bin/floor/staging |
| `is_active` | boolean | |

**`warehouse_variant_locations`:**

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PK |
| `variant_id` | uuid | FK → variants (CASCADE) |
| `location_id` | uuid | FK → locations |
| `workspace_id` | uuid | FK |
| `quantity` | integer | DEFAULT 0 |
| | | UNIQUE(variant_id, location_id) |

### 2.6 `warehouse_inbound_shipments` / `warehouse_inbound_items`

Client-submitted receiving pipeline (currently unused — 0 rows in both tables).

**`warehouse_inbound_shipments`:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK |
| `org_id` | uuid | FK → organizations |
| `tracking_number` | text | |
| `carrier` | text | |
| `expected_date` | date | |
| `actual_arrival_date` | date | |
| `status` | text | CHECK: expected/arrived/checking_in/checked_in/issue |
| `notes` | text | |
| `submitted_by` | uuid | FK → users |
| `checked_in_by` | uuid | FK → users |

**`warehouse_inbound_items`:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `inbound_shipment_id` | uuid | FK → inbound_shipments (CASCADE) |
| `workspace_id` | uuid | FK |
| `sku` | text | NOT NULL |
| `expected_quantity` | integer | DEFAULT 0 |
| `received_quantity` | integer | Nullable until check-in |
| `condition_notes` | text | |
| `location_id` | uuid | FK → locations |

### 2.7 `client_store_connections` / `client_store_sku_mappings`

Multi-channel store integrations and per-SKU push tracking.

**`client_store_connections`:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK |
| `org_id` | uuid | FK |
| `platform` | text | CHECK: shopify/woocommerce/squarespace/bigcommerce/discogs |
| `store_url` | text | |
| `api_key` | text | |
| `api_secret` | text | |
| `connection_status` | text | pending/active/disabled_auth_failure/error |
| `last_webhook_at` | timestamptz | |
| `last_poll_at` | timestamptz | |
| `last_error_at` | timestamptz | |
| `last_error` | text | Includes `consecutive:N` prefix for failure tracking |
| `do_not_fanout` | boolean | Circuit breaker flag |
| `metadata` | jsonb | |

**`client_store_sku_mappings`:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `connection_id` | uuid | FK → connections (CASCADE) |
| `variant_id` | uuid | FK → variants |
| `remote_product_id` | text | |
| `remote_variant_id` | text | |
| `remote_sku` | text | |
| `last_pushed_quantity` | integer | Echo cancellation / drift tracking |
| `last_pushed_at` | timestamptz | |
| `is_active` | boolean | |

### 2.8 `bundle_components`

Bundle-to-component relationships for MIN availability calculation (currently unused — 0 rows).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK |
| `bundle_variant_id` | uuid | FK → variants (CASCADE) |
| `component_variant_id` | uuid | FK → variants (CASCADE), CHECK != bundle_variant_id |
| `quantity` | integer | > 0 |
| | | UNIQUE(bundle_variant_id, component_variant_id) |

### 2.9 `bandcamp_connections` / `bandcamp_product_mappings`

Bandcamp integration — OAuth connections and SKU-to-merch-item mappings.

**`bandcamp_connections`:** 17 active connections, one per label/band.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK |
| `org_id` | uuid | FK |
| `band_id` | integer | Bandcamp band ID |
| `band_name` | text | |
| `is_active` | boolean | |
| `last_synced_at` | timestamptz | |

**`bandcamp_product_mappings`:** 1,413 mappings linking Bandcamp merch items to warehouse variants.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK |
| `variant_id` | uuid | FK → variants |
| `bandcamp_item_id` | integer | Bandcamp `package_id` |
| `bandcamp_item_type` | text | |
| `last_quantity_sold` | integer | Compared against API to detect new sales |
| `last_synced_at` | timestamptz | |
| `bandcamp_url` | text | |
| `authority_status` | text | |

### 2.10 Key Database Functions

**`derive_inventory_org_id()`** — BEFORE INSERT OR UPDATE trigger on `warehouse_inventory_levels`. Auto-populates `org_id` by joining variant → product → org. Writers never set `org_id` manually.

**`record_inventory_change_txn(p_workspace_id, p_sku, p_delta, p_source, p_correlation_id, p_metadata)`** — PL/pgSQL RPC (SECURITY DEFINER). In a single ACID transaction:

1. `UPDATE warehouse_inventory_levels SET available = available + p_delta WHERE workspace_id = p_workspace_id AND sku = p_sku`
2. `INSERT INTO warehouse_inventory_activity (...) ON CONFLICT (sku, correlation_id) DO NOTHING`
3. Raises `inventory_floor_violation` if stock would go negative on non-allowed SKUs

### 2.11 RLS Policies

All inventory tables have RLS enabled:

| Table | Staff Policy | Client Policy |
|-------|-------------|---------------|
| `warehouse_products` | `is_staff_user()` → full CRUD | `org_id = get_user_org_id()` → SELECT |
| `warehouse_product_variants` | `is_staff_user()` → full CRUD | JOIN to products.org_id → SELECT |
| `warehouse_inventory_levels` | `is_staff_user()` → full CRUD | `org_id = get_user_org_id()` → SELECT |
| `warehouse_inventory_activity` | `is_staff_user()` → full CRUD | Staff-only (no client access) |
| `warehouse_inbound_shipments` | `is_staff_user()` → full CRUD | `org_id = get_user_org_id()` → SELECT |
| `warehouse_inbound_items` | `is_staff_user()` → full CRUD | JOIN to inbound_shipments.org_id → SELECT |
| `warehouse_locations` | `is_staff_user()` → full CRUD | Staff-only |
| `warehouse_variant_locations` | `is_staff_user()` → full CRUD | JOIN to variants → products.org_id → SELECT |

Helper functions: `get_user_org_id()` (SECURITY DEFINER, STABLE), `is_staff_user()` (SECURITY DEFINER, STABLE).

---

## 3. Architecture: Data Flow

### Hub-and-Spoke Model

The system does NOT sync Shopify and Bandcamp directly. The warehouse database is the central hub:

```
                        ┌──────────────────┐
       Shopify ──READ──►│                  │──PUSH──► Bandcamp
       (15-min sync)    │    Warehouse     │          (5-min push)
                        │    Database      │
       Shopify ──WEBHOOK│   (Supabase)     │──PUSH──► WooCommerce
       (real-time)      │    + Redis       │          (5-min push)
                        │                  │
       Bandcamp ──READ──│                  │
       (5-min poll)     │                  │
                        │                  │
       Manual ─────────►│                  │
       adjustments      └──────────────────┘
                               ▲
                         Inbound check-in
                         (never used)
```

### The Single Write Path

ALL inventory mutations (except bulk Shopify sync) flow through one function:

```
recordInventoryChange(workspaceId, sku, delta, source, correlationId)
    │
    ├──► Step 1: Redis SETNX idempotency check
    │    Key: processed:{correlationId}
    │    If key exists → return "already processed"
    │    If new → HINCRBY inv:{sku} available {delta}
    │
    ├──► Step 2: Postgres RPC record_inventory_change_txn
    │    Atomic UPDATE + INSERT in single transaction
    │    ON CONFLICT (sku, correlation_id) DO NOTHING
    │
    └──► Step 3: Fanout (non-blocking, best-effort)
         Trigger bandcamp-inventory-push and/or multi-store-inventory-push
```

### Idempotency (Dual Layer)

| Layer | Mechanism | Key Pattern |
|-------|-----------|-------------|
| Redis | Lua script: SETNX with 24h TTL | `processed:{correlationId}` |
| Postgres | UNIQUE constraint on activity table | `(sku, correlation_id)` with `ON CONFLICT DO NOTHING` |

### Correlation ID Patterns

| Source | Pattern | Example |
|--------|---------|---------|
| Shopify webhook | `shopify_wh:{webhookEventId}` | `shopify_wh:a1b2c3d4-...` |
| Bandcamp sale | `bandcamp-sale:{bandId}:{packageId}:{totalSold}` | `bandcamp-sale:123:456:5` |
| Manual adjustment | `manual:{userId}:{timestamp}` | `manual:uuid:1712436000000` |
| Inbound check-in | `inbound:{shipmentId}:{itemId}` | `inbound:uuid:uuid` |
| Shopify sync | `shopify-sync:{runId}:{workspaceId}` | Single reconciliation event |

---

## 4. Code Map: Every File That Touches Inventory

### Core Write Path

| File | Purpose |
|------|---------|
| `src/lib/server/record-inventory-change.ts` | Single canonical write path. Redis HINCRBY + Postgres RPC + fanout. |
| `src/lib/server/inventory-fanout.ts` | After a write, triggers downstream push tasks for affected SKU. |
| `src/lib/server/supabase-server.ts` | Three Supabase client constructors: server (cookie auth), service-role (bypass RLS), browser. |
| `src/lib/clients/redis-inventory.ts` | Redis operations: `getInventory`, `setInventory`, `adjustInventory` (Lua SETNX), `bulkSetInventory`. |

### Shopify Integration

| File | Purpose |
|------|---------|
| `src/trigger/tasks/shopify-sync.ts` | 15-min cron delta sync. Fetches products + inventory from Shopify, upserts to Postgres + Redis. |
| `src/trigger/tasks/shopify-full-backfill.ts` | Full catalog re-sync (manual trigger). |
| `src/trigger/tasks/process-shopify-webhook.ts` | Handles `inventory_levels/update` webhooks. Computes delta, calls `recordInventoryChange()`. |
| `src/lib/clients/shopify-client.ts` | GraphQL client: `fetchProducts`, `fetchInventoryLevels`, `inventoryAdjustQuantities`, product mutations. |

### Bandcamp Integration

| File | Purpose |
|------|---------|
| `src/trigger/tasks/bandcamp-sale-poll.ts` | 5-min cron. Polls Bandcamp merch API, detects new sales, decrements inventory. |
| `src/trigger/tasks/bandcamp-inventory-push.ts` | 5-min cron. Pushes current stock levels TO Bandcamp (with safety buffer). |
| `src/lib/clients/bandcamp.ts` | OAuth token refresh, `getMerchDetails`, `updateQuantities`, `getOrders`, `updateShipped`. |

### Multi-Store Push

| File | Purpose |
|------|---------|
| `src/trigger/tasks/multi-store-inventory-push.ts` | 5-min cron. Pushes to WooCommerce/other stores. Circuit breaker per connection. |

### Reconciliation and Monitoring

| File | Purpose |
|------|---------|
| `src/trigger/tasks/redis-backfill.ts` | Weekly (Tue 3am EST). Rebuilds Redis from Postgres with race-condition protection. |
| `src/trigger/tasks/sensor-check.ts` | 5-min cron. Drift detection, staleness checks, auto-heals up to 50 SKUs/run. |
| `src/trigger/lib/sensors.ts` | Sensor threshold functions (drift, propagation lag, staleness, webhook silence). |

### Bundles

| File | Purpose |
|------|---------|
| `src/trigger/tasks/bundle-component-fanout.ts` | Decrements component inventory when a bundle sells. |
| `src/trigger/tasks/bundle-availability-sweep.ts` | Daily recomputation of bundle MIN availability. |

### Inbound Receiving

| File | Purpose |
|------|---------|
| `src/trigger/tasks/inbound-checkin-complete.ts` | Records inventory changes when items are checked in. |
| `src/trigger/tasks/inbound-product-create.ts` | Creates Shopify + DB products for unknown SKUs during inbound. |

### Server Actions (UI Layer)

| File | Purpose |
|------|---------|
| `src/actions/inventory.ts` | `getInventoryLevels()`, `adjustInventory()`, `getInventoryDetail()`, `getClientInventoryLevels()`, `updateInventoryBuffer()`, `updateWorkspaceDefaultBuffer()`, `updateVariantFormat()` |

### Audit Script

| File | Purpose |
|------|---------|
| `scripts/audit-supabase.mjs` | Live DB audit runner. Checks migration parity, table counts, Bandcamp integrity, operational data, webhook health. |

---

## 5. How Each Data Path Works

### 5.1 Shopify Delta Sync (every 15 minutes)

**File:** `src/trigger/tasks/shopify-sync.ts`

This is the primary data pipeline. It pulls products and inventory FROM Shopify INTO the warehouse database.

**Flow:**

1. Load sync cursor from `warehouse_sync_state` (type: `shopify_delta`)
2. Subtract 2-minute overlap window from cursor (Rule #46)
3. Page through Shopify products via GraphQL (50/page, filtered by `updatedAt`)
4. For each product:
   - Look up existing `org_id` from `warehouse_products`
   - **Skip if no org_id** — this is why 992 variants have no inventory
   - Upsert into `warehouse_products` (on `workspace_id, shopify_product_id`)
   - For each variant with a SKU:
     - Upsert into `warehouse_product_variants` (on `workspace_id, sku`)
     - Collect `inventoryItem.id` for inventory level fetch
5. Fetch inventory levels from Shopify for collected inventory item IDs
6. For each level:
   - Look up variant by `shopify_variant_id` (using string replacement hack — see Issues)
   - Upsert into `warehouse_inventory_levels` (on `variant_id`)
   - Set Redis hash `inv:{sku}` directly
7. Update sync cursor
8. Log single `sync_reconciliation` activity record

**Key code — product skip logic (line 187-188):**

```typescript
const orgId = existingProduct?.org_id;
if (!orgId) continue; // Skip products not mapped to an org
```

**Key code — inventory item ID lookup (line 312-317):**

```typescript
.eq(
  "shopify_variant_id",
  level.inventoryItemId.replace(
    "gid://shopify/InventoryItem/",
    "gid://shopify/ProductVariant/",
  ),
)
```

This string replacement assumes InventoryItem and ProductVariant share the same numeric ID. Shopify does NOT guarantee this.

**Key code — Redis bulk write (line 339-343):**

```typescript
await redis.hset(`inv:${variant.sku}`, {
  available: level.available,
  committed: level.committed,
  incoming: level.incoming,
});
```

### 5.2 Shopify Webhooks (real-time)

**File:** `src/trigger/tasks/process-shopify-webhook.ts`

Handles `inventory_levels/update` webhooks for near-real-time inventory changes.

**Flow:**

1. Fetch webhook event from `webhook_events` table
2. Parse Shopify payload: extract `inventory_item_id` and `available`
3. Look up variant by `shopify_inventory_item_id` column
4. Echo cancellation: if `last_pushed_quantity` matches webhook quantity, skip (our own update echoing back)
5. Get current warehouse level from `warehouse_inventory_levels`
6. Compute delta: `webhookQuantity - warehouseQuantity`
7. If delta != 0, call `recordInventoryChange()` with source `"shopify"` and correlation `shopify_wh:{eventId}`

**Key code — echo cancellation (line 129-131):**

```typescript
if (mapping && mapping.last_pushed_quantity === parsed.available) {
  await markEvent(supabase, webhookEventId, "echo_cancelled");
  return { processed: true, reason: "echo_cancelled", sku: variant.sku };
}
```

**Key code — delta computation (line 55-57):**

```typescript
export function computeDelta(webhookQuantity: number, warehouseQuantity: number): number {
  return webhookQuantity - warehouseQuantity;
}
```

### 5.3 Bandcamp Sale Poll (every 5 minutes)

**File:** `src/trigger/tasks/bandcamp-sale-poll.ts`

Detects sales on Bandcamp by polling the merch API and comparing `quantity_sold`.

**Flow:**

1. For each active `bandcamp_connections` row (17 total):
2. Refresh OAuth token via `refreshBandcampToken()`
3. Call `getMerchDetails(bandId)` — returns all merch items with current `quantity_sold`
4. For each item with a `bandcamp_product_mappings` row:
   - Compare `item.quantity_sold` to `mapping.last_quantity_sold`
   - If increased: compute negative delta, call `recordInventoryChange()`
   - Update `last_quantity_sold` on the mapping
5. After a sale, immediately trigger both push tasks (don't wait for cron)
6. If the sold item is a bundle, trigger `bundle-component-fanout`

**Key code — sale detection (line 60-72):**

```typescript
const lastSold = mapping.last_quantity_sold ?? 0;
const newSold = item.quantity_sold;

if (newSold > lastSold) {
  const delta = -(newSold - lastSold); // Negative — items were sold

  const correlationId = `bandcamp-sale:${connection.band_id}:${item.package_id}:${newSold}`;

  const result = await recordInventoryChange({
    workspaceId,
    sku: variant.sku,
    delta,
    source: "bandcamp",
    correlationId,
    // ...
  });
}
```

### 5.4 Bandcamp Inventory Push (every 5 minutes)

**File:** `src/trigger/tasks/bandcamp-inventory-push.ts`

Pushes current warehouse stock levels TO Bandcamp.

**Flow:**

1. For each active Bandcamp connection:
2. Load all `bandcamp_product_mappings` with non-null `bandcamp_item_id`
3. Fetch `warehouse_inventory_levels` for all mapped variant IDs
4. For each mapping:
   - Get `rawAvailable` from inventory levels
   - Compute effective safety stock: per-SKU override or workspace default (3)
   - If bundle: compute MIN across components
   - `pushedQuantity = max(0, available - effectiveSafety)`
5. Call Bandcamp `updateQuantities` API with all items

**Key code — safety buffer calculation (line 129-149):**

```typescript
const rawAvailable = inv?.available ?? 0;
const effectiveSafety = inv?.safetyStock ?? workspaceSafetyStock;

let effectiveAvailable = rawAvailable;
if (bundlesEnabled) {
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
}

const pushedQuantity = Math.max(0, effectiveAvailable - effectiveSafety);
```

### 5.5 Multi-Store Inventory Push (every 5 minutes)

**File:** `src/trigger/tasks/multi-store-inventory-push.ts`

Pushes inventory to external stores (currently 1 WooCommerce connection for Northern Spy Records).

**Flow:**

1. For each active `client_store_connections` row (where `do_not_fanout = false`):
2. Load SKU mappings from `client_store_sku_mappings`
3. Fetch inventory levels for mapped variants
4. For each mapping:
   - Apply safety buffer (same calculation as Bandcamp push)
   - Skip if `last_pushed_quantity` hasn't changed
   - Call platform-specific `pushInventory()` via `createStoreSyncClient()`
   - Update `last_pushed_quantity` and `last_pushed_at`
5. Circuit breaker: 5 consecutive auth failures → connection auto-disabled, review queue item created

**Key code — circuit breaker (line 251-252):**

```typescript
if (isAuthError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
  // Auto-disable connection
  await supabase
    .from("client_store_connections")
    .update({
      connection_status: "disabled_auth_failure",
      do_not_fanout: true,
      // ...
    })
    .eq("id", connection.id);
}
```

### 5.6 `recordInventoryChange()` — The Single Write Path

**File:** `src/lib/server/record-inventory-change.ts`

Every non-bulk inventory mutation goes through this function. It enforces dual-write to Redis and Postgres.

**Full implementation:**

```typescript
export async function recordInventoryChange(
  params: RecordInventoryChangeParams,
): Promise<RecordInventoryChangeResult> {
  const { workspaceId, sku, delta, source, correlationId, metadata } = params;

  // Step 2: Redis HINCRBY with SETNX idempotency guard (Rule #47)
  const redisResult = await adjustInventory(sku, "available", delta, correlationId);

  if (redisResult === null) {
    // Already processed — idempotency key existed
    return { success: true, newQuantity: null, alreadyProcessed: true };
  }

  // Step 3: Postgres RPC in a single ACID transaction (Rule #64)
  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.rpc("record_inventory_change_txn", {
      p_workspace_id: workspaceId,
      p_sku: sku,
      p_delta: delta,
      p_source: source,
      p_correlation_id: correlationId,
      p_metadata: metadata ?? {},
    });

    if (error) {
      console.error(
        `[recordInventoryChange] Postgres RPC failed after Redis write. ` +
          `SKU=${sku} delta=${delta} correlationId=${correlationId} error=${error.message}`,
      );
      return { success: false, newQuantity: redisResult, alreadyProcessed: false };
    }
  } catch (err) {
    console.error(
      `[recordInventoryChange] Postgres RPC exception after Redis write. ` +
        `SKU=${sku} delta=${delta} correlationId=${correlationId}`,
      err,
    );
    return { success: false, newQuantity: redisResult, alreadyProcessed: false };
  }

  // Step 4: enqueue fanout (Rule #43) — non-blocking, best-effort
  try {
    const { fanoutInventoryChange } = await import("@/lib/server/inventory-fanout");
    fanoutInventoryChange(workspaceId, sku, redisResult).catch((err) => {
      console.error(`[recordInventoryChange] Fanout failed for SKU=${sku}:`, err);
    });
  } catch {
    // Fanout is non-critical — cron jobs will pick up changes
  }

  return { success: true, newQuantity: redisResult, alreadyProcessed: false };
}
```

### 5.7 Redis Idempotency Guard

**File:** `src/lib/clients/redis-inventory.ts`

The Lua script that ensures each correlationId is processed exactly once:

```lua
if redis.call('SETNX', KEYS[1], 1) == 1 then
  redis.call('EXPIRE', KEYS[1], 86400)
  return redis.call('HINCRBY', KEYS[2], ARGV[1], ARGV[2])
else
  return nil
end
```

Called as:

```typescript
export async function adjustInventory(
  sku: string,
  field: keyof InventoryLevels,
  delta: number,
  idempotencyKey: string,
): Promise<number | null> {
  const redis = getRedis();
  const result = await redis.eval(
    ADJUST_LUA_SCRIPT,
    [`processed:${idempotencyKey}`, `inv:${sku}`],
    [field, delta],
  );
  return result as number | null;
}
```

### 5.8 Manual Adjustments

**File:** `src/actions/inventory.ts`

Staff can adjust inventory via the admin UI:

```typescript
export async function adjustInventory(
  sku: string,
  delta: number,
  reason: string,
): Promise<{ success: boolean; newQuantity: number | null }> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: userData } = await supabase
    .from("users")
    .select("workspace_id")
    .eq("auth_user_id", user.id)
    .single();

  const correlationId = `manual:${user.id}:${Date.now()}`;

  const result = await recordInventoryChange({
    workspaceId: userData.workspace_id,
    sku,
    delta,
    source: "manual",
    correlationId,
    metadata: { reason, adjusted_by: user.id },
  });

  return { success: result.success, newQuantity: result.newQuantity };
}
```

### 5.9 Inventory Fanout

**File:** `src/lib/server/inventory-fanout.ts`

After `recordInventoryChange()` succeeds, this determines which downstream systems need updating:

```typescript
export async function fanoutInventoryChange(
  workspaceId: string,
  sku: string,
  _newQuantity: number,
): Promise<FanoutResult> {
  const supabase = createServiceRoleClient();

  // Check if SKU has store connection mappings
  const { data: skuMappings } = await supabase
    .from("client_store_sku_mappings")
    .select("connection_id")
    .eq("is_active", true)
    .eq("remote_sku", sku);

  // Check if SKU has a Bandcamp mapping
  const { data: bandcampMappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, variant_id")
    .eq("workspace_id", workspaceId);

  // Get the variant for this SKU
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();

  const hasBandcampMapping = variant &&
    (bandcampMappings ?? []).some((m) => m.variant_id === variant.id);

  // Enqueue pushes
  if ((skuMappings ?? []).length > 0) {
    await tasks.trigger("multi-store-inventory-push", {});
  }
  if (hasBandcampMapping) {
    await tasks.trigger("bandcamp-inventory-push", {});
  }

  // If the SKU is a bundle component, also trigger pushes for parent bundles
  if (variant) {
    const { data: parentBundles } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("component_variant_id", variant.id)
      .limit(1);

    if (parentBundles?.length) {
      await tasks.trigger("bandcamp-inventory-push", {});
      await tasks.trigger("multi-store-inventory-push", {});
    }
  }
}
```

### 5.10 Redis Weekly Backfill

**File:** `src/trigger/tasks/redis-backfill.ts`

Rebuilds Redis from Postgres every Tuesday at 3am EST with race-condition protection:

```typescript
for (const level of levels) {
  // If a live write happened after backfill started, skip that SKU
  if (shouldSkipSku(level.last_redis_write_at, backfillStartedAt)) {
    skippedLiveWrites++;
    continue;
  }

  await setInventory(level.sku, {
    available: level.available,
    committed: level.committed,
    incoming: level.incoming,
  });

  updated++;
}
```

### 5.11 Sensor Check (Drift Detection + Auto-Heal)

**File:** `src/trigger/tasks/sensor-check.ts`

Runs every 5 minutes. Checks 10 sensors including Redis/Postgres drift:

```typescript
// inv.redis_postgres_drift — detect and auto-heal up to 50 drifted SKUs per run
const { data: sample } = await supabase
  .from("warehouse_inventory_levels")
  .select("sku, available, committed, incoming")
  .eq("workspace_id", workspaceId)
  .limit(100);

let mismatches = 0;
let healed = 0;
for (const row of sample ?? []) {
  const redis = await getInventory(row.sku);
  if (redis.available !== row.available) {
    mismatches++;
    if (healed < 50) {
      await setInventory(row.sku, {
        available: row.available,
        committed: row.committed ?? 0,
        incoming: row.incoming ?? 0,
      });
      healed++;
    }
  }
}
```

**All 10 sensors:**

1. `inv.redis_postgres_drift` — Redis vs Postgres available count mismatch
2. `inv.propagation_lag` — Oldest `last_pushed_at` across store mappings
3. `sync.shopify_stale` — Time since last Shopify delta sync
4. `sync.bandcamp_stale` — Time since last Bandcamp connection sync
5. `bandcamp.merch_sync_log_stale` — Time since last successful merch_sync
6. `bandcamp.scraper_review_open` — Open bandcamp_scraper review queue items
7. `bandcamp.scrape_block_rate` — Recent 403/429 rate from scraper
8. `webhook.silence` — Active connections with no recent webhooks
9. `billing.unpaid` — Overdue invoices older than 7 days
10. `review.critical_open` — Critical review items open longer than 1 hour

### 5.12 Supabase Client Configuration

**File:** `src/lib/server/supabase-server.ts`

Three client constructors:

```typescript
// 1. Server Components / Server Actions — cookie-based auth, respects RLS
export async function createServerSupabaseClient() {
  return _createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll, setAll },
  });
}

// 2. Service role — bypasses RLS. For Trigger.dev tasks and trusted server ops ONLY.
export function createServiceRoleClient() {
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// 3. Browser — anon key, RLS based on user session cookie
export function createBrowserSupabaseClient() {
  return _createBrowserClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
```

---

## 6. Live Database Snapshot (April 6, 2026)

### 6.1 Critical Table Row Counts

| Table | Rows | Notes |
|-------|------|-------|
| `users` | 6 | |
| `workspaces` | 1 | |
| `organizations` | 175 | |
| `warehouse_products` | 3,764 | |
| `warehouse_product_variants` | 2,875 | |
| `warehouse_inventory_levels` | 1,046 | |
| `warehouse_orders` | 22,036 | |
| `warehouse_order_items` | 3,850 | |
| `warehouse_shipments` | 531 | |
| `warehouse_shipment_items` | 628 | |
| `warehouse_inbound_shipments` | 0 | **Never used** |
| `warehouse_inbound_items` | 0 | **Never used** |
| `webhook_events` | 1,264 | |
| `channel_sync_log` | 34,057 | |
| `sensor_readings` | 39,087 | |
| `warehouse_review_queue` | 1,668 | |
| `bandcamp_connections` | 17 | |
| `bandcamp_product_mappings` | 1,413 | |
| `bandcamp_sales` | 146,427 | |
| `bandcamp_sales_backfill_state` | 17 | |
| `client_store_connections` | 1 | |
| `bundle_components` | 0 | **Not in use** |
| `warehouse_inventory_activity` | 2,164 | |
| `billing_snapshots` | 0 | **Not in use** |

### 6.2 Product Status Breakdown

| Status | Count |
|--------|-------|
| Active | 1,582 |
| Draft | 1,965 |
| Archived | 217 |
| **Total** | **3,764** |

### 6.3 Inventory Level Breakdown

| Metric | Count |
|--------|-------|
| Total inventory level rows | 1,046 |
| Variants with positive stock (available > 0) | 479 |
| Variants with zero stock (available = 0) | 567 |
| Variants with negative stock (available < 0) | 0 |
| Variants WITH an inventory level row | ~1,000 |
| Variants WITHOUT any inventory tracking | ~992 (34.5%) |
| Distinct products with positive inventory | ~461 |
| Orphan inventory rows (variant missing) | 0 |

### 6.4 Top 20 SKUs by Available Stock

All top SKUs show `available = 999` with `committed = 0` and `incoming = 0`. This is likely seed/placeholder data.

| SKU | Available | Committed | Incoming |
|-----|-----------|-----------|----------|
| EM-T-CS | 999 | 0 | 0 |
| LR-VSBL | 999 | 0 | 0 |
| GH-AHFA-C | 999 | 0 | 0 |
| NG-PMV3-C | 999 | 0 | 0 |
| LP-ASIFALWA-9U05 | 999 | 0 | 0 |
| CD-THECASBA-9SM6 | 999 | 0 | 0 |
| CS-ASIFALWA-9U7X | 999 | 0 | 0 |
| LP-TOMBEAUX-9QIP | 999 | 0 | 0 |
| LR-HWGW-GWC | 999 | 0 | 0 |
| CD-ASIFALWA-9UEO | 999 | 0 | 0 |
| CD-THEMASQU-9Q3Q | 999 | 0 | 0 |
| CD-HIGHTIDE-9TTL | 999 | 0 | 0 |
| SG-DT-RV | 999 | 0 | 0 |
| CD-PEACEBEY-9PWT | 999 | 0 | 0 |
| LR-PIM-PIMC | 999 | 0 | 0 |
| CD-ASIFALWA-KAIC | 999 | 0 | 0 |
| CD-THECASBA-K8M6 | 999 | 0 | 0 |
| AC-CIP-V | 999 | 0 | 0 |
| ME-SS-PBV | 999 | 0 | 0 |
| CD-FINISHHI-9STQ | 999 | 0 | 0 |

### 6.5 Products by Organization (labels with products)

| Organization | Products |
|-------------|----------|
| Clandestine Distribution | 1,003 |
| Leaving Records | 421 |
| Northern Spy Records | 356 |
| Whited Sepulchre Records | 164 |
| NNA Tapes | 157 |
| True Panther | 96 |
| Avant! Records | 94 |
| Egghunt Records | 71 |
| Feel It Records | 63 |
| Whited Sepulchre | 61 |
| a La Carte Records | 57 |
| Urashima | 54 |
| Industrial Coast | 52 |
| Total Black | 45 |
| Suction Records | 41 |
| Elevator Bath | 41 |
| Gilgongo Records | 39 |
| LILA | 38 |
| Nagrania Cukiernicze | 34 |
| Aurora Central | 30 |
| Torn Light Records | 29 |
| Monorail Trespassing | 29 |
| Chicago Research | 28 |
| Slowscan | 26 |
| Funeral Party Records | 25 |
| Birdwatcher | 25 |
| Fixed Rhythms | 25 |
| Alter | 22 |
| Hologram Label | 22 |
| Young and Cold Records | 19 |
| Zum | 18 |
| Fantastique | 18 |
| Rope Or Guillotine | 16 |
| Psychic Liberation | 16 |
| Sound Pollution | 16 |
| Nostilevo | 16 |
| Difficult Interactions | 16 |
| Helicopter | 16 |
| Satatuhatta | 16 |
| SUSS | 15 |
| Beso De Muerte | 15 |
| Raw Culture | 15 |
| Enmossed | 14 |
| Virtues | 13 |
| Black Day In July | 13 |
| Bliss Point | 12 |
| Digital Regress | 11 |
| Radio Topo | 11 |
| Absurd Expo | 9 |
| Unknown Precept | 9 |
| In The Pines | 8 |
| Redscroll | 8 |
| Iron Lung Records | 8 |
| Enmossed\|Psychic Liberation | 8 |
| Discreet Music | 8 |
| Working Man Lay Down | 7 |
| Human Headstone Presents | 7 |
| Noir Age | 7 |
| Archaic Vaults | 6 |
| IFB Records | 6 |
| Lord Spikeheart | 6 |
| True Panther Records | 6 |
| Helicopter (Seoul - Korea) | 6 |
| She Lost Kontrol Records | 5 |
| Fixed Rythms | 5 |
| Monorail Tresspassing | 5 |
| What Lies Beneath | 5 |
| Midnight Mannequin | 5 |
| Young & Cold | 5 |
| Happy Families | 5 |
| Phage Tapes | 5 |
| 4Q | 5 |
| Torn Light | 5 |
| (remaining 97 orgs with 1-4 products each) | ... |

### 6.6 Inventory Activity

| Metric | Value |
|--------|-------|
| Total activity records | 2,164 |
| Activity in last 24h | 98 |
| Source: shopify | 853 |
| Source: bandcamp | 143 |
| Source: backfill | 4 |

### 6.7 Webhook Health (last 7 days)

| Platform | Status | Events (7d) | Latest Event |
|----------|--------|-------------|-------------|
| Shopify | OK | 410 | 2026-04-06T11:00:47 |
| AfterShip | OK | 467 | 2026-04-01T02:42:42 |
| ShipStation | **STALE** | 0 | Never |
| Stripe | **STALE** | 0 | Never |
| Resend | **STALE** | 0 | Never |

Shopify webhooks breakdown: 410 events with status `pending` (not yet processed).

### 6.8 Sync Log Health

| Sync Type | Latest Status | Latest Timestamp |
|-----------|--------------|-----------------|
| `inventory_push` | completed | 2026-04-06T19:51:59 |
| `sale_poll` | completed | 2026-04-06T19:51:49 |
| `scrape_page` | completed | 2026-04-06T19:51:09 |
| `scrape_sweep` | completed | 2026-04-06T19:50:55 |
| `delta` | completed | 2026-04-06T19:45:06 |

Stuck sync logs (running > 1 hour): 0

### 6.9 Review Queue

| Status | Count |
|--------|-------|
| Open | 1,000+ |
| Open > 24 hours | 1,087 |

### 6.10 Store Connections

| Platform | Store URL | Status |
|----------|-----------|--------|
| WooCommerce | https://northernspyrecs.com | Active |

No Shopify store connection exists. Inventory changes are NOT being pushed back to Shopify.

### 6.11 Bandcamp Sales Backfill

3 backfill mismatches detected:

| Band | State Total | Actual Rows | Status |
|------|------------|-------------|--------|
| Xol Meissner | 29 | 25 | partial |
| SUSS | 1,020 | 510 | partial |
| Northern Spy Records | 11,673 | 18,621 | running (stale) |

Northern Spy's backfill has been stuck in "running" state with error "Stale running detected by cron."

---

## 7. Background Jobs Schedule

### Cron Tasks

| Task ID | Schedule | Max Duration | Queue | Purpose |
|---------|----------|-------------|-------|---------|
| `shopify-sync` | `*/15 * * * *` | 14 min | default | Delta sync products/variants/inventory from Shopify |
| `bandcamp-sale-poll` | `*/5 * * * *` | 2 min | bandcampQueue | Detect Bandcamp sales, decrement inventory |
| `bandcamp-inventory-push` | `*/5 * * * *` | 2 min | bandcampQueue | Push stock levels to Bandcamp |
| `multi-store-inventory-push` | `*/5 * * * *` | 3 min | default | Push stock to WooCommerce/other stores |
| `sensor-check` | `*/5 * * * *` | 1 min | default | Drift detection, staleness, auto-heal |
| `redis-backfill` | `0 3 * * 2` (Tue 3am EST) | 10 min | default | Full Redis rebuild from Postgres |
| `bundle-availability-sweep` | Daily 6am UTC | default | default | Recompute bundle MIN availability |
| `shopify-order-sync` | Cron | default | default | Sync Shopify orders |
| `monthly-billing` | `0 6 1 * *` (1st, 6am) | 10 min | default | Generate billing snapshots |
| `storage-calc` | `0 7 1 * *` (1st, 7am) | 10 min | default | Calculate storage fees |

### Event-Driven Tasks

| Task ID | Triggered By | Purpose |
|---------|-------------|---------|
| `process-shopify-webhook` | Shopify webhook route handler | Process inventory level updates |
| `inbound-checkin-complete` | `completeCheckIn()` server action | Record inventory for received items |
| `inbound-product-create` | `createInbound()` server action | Create products for unknown SKUs |
| `bundle-component-fanout` | Bandcamp sale poll | Decrement component inventory when bundle sells |
| `aftership-register` | Post-shipment ingest | Register tracking numbers |

---

## 8. Issues and Risks

### Critical

**C1: 34.5% of variants have no inventory tracking.**
992 of 2,875 variants have no `warehouse_inventory_levels` row. The Shopify sync at `src/trigger/tasks/shopify-sync.ts` line 187-188 skips any product where `org_id` can't be resolved from an existing row. Products synced before their org was mapped were added to the catalog but never had inventory fetched.

**C2: InventoryItem-to-ProductVariant ID string replacement hack.**
`src/trigger/tasks/shopify-sync.ts` line 312-317 converts Shopify `gid://shopify/InventoryItem/` to `gid://shopify/ProductVariant/` by string replacement, assuming they share the same numeric ID. Shopify does NOT guarantee this. Some inventory levels may be mapped to the wrong variant.

**C3: No Shopify push connection.**
There is no `client_store_connections` row for the Shopify store. Inventory changes from Bandcamp sales or manual adjustments are NOT being pushed back to Shopify. The system is Shopify-inbound only. This means: if an item sells on Bandcamp, the warehouse DB is decremented, and Bandcamp is updated, but Shopify still shows the old stock level until the next webhook or manual edit on the Shopify side.

**C4: No inventory level row created for new inbound products.**
`src/trigger/tasks/inbound-product-create.ts` creates products and variants but does NOT create a `warehouse_inventory_levels` row. The subsequent `recordInventoryChange()` from `inbound-checkin-complete` calls the RPC, which does an UPDATE (not UPSERT) — it will fail with "No inventory level found."

**C5: Missing workspace_id scoping in server actions.**
`src/actions/inventory.ts` — `getInventoryDetail()` (line 274) and `updateInventoryBuffer()` (line 488-491) query by SKU alone without `workspace_id`. The service-role client bypasses RLS, so in a multi-workspace deployment, these could hit the wrong row.

### Medium

**M1: All stocked products are in "draft" status.**
Every product sampled with positive inventory has `status = "draft"`. This is synced directly from Shopify's product status. Either the Shopify store has most products in draft, or the status mapping needs investigation.

**M2: 1,087 unresolved review queue items.**
The system generates alerts (sensor criticals, sync errors, unknown vendors) but 1,087 items have been open longer than 24 hours. Nobody is triaging them.

**M3: Top stock values are all 999.**
The top 20 SKUs all show `available = 999` with zero committed and incoming. This looks like seed/placeholder data, not real warehouse counts.

**M4: Redis backfill drift counter is hardcoded to 0.**
`src/trigger/tasks/redis-backfill.ts` line 85 sets `mismatches: 0` with a comment "Future: compare Redis values before overwrite." The drift review queue logic (lines 100-111) will never fire. The sensor-check partially covers this, but backfill's own reporting is dead code.

**M5: Portal `updateInventoryBuffer()` doesn't verify org ownership.**
`src/actions/inventory.ts` line 477-494 — authenticates the user but doesn't verify they're authorized to modify that particular SKU's buffer. Only checks that they're logged in.

**M6: `safety_stock` not included in inventory list queries.**
`getInventoryLevels()` and `getClientInventoryLevels()` don't include `safety_stock` in their Supabase select. The UI always shows the hardcoded default of 3 regardless of per-SKU overrides.

**M7: ShipStation/Stripe/Resend webhooks never connected.**
Zero events from ShipStation, Stripe, and Resend have ever been received. These integrations are either not configured or the webhook URLs are not registered with those services.

**M8: Bandcamp backfill mismatches.**
3 connections have mismatches between `bandcamp_sales_backfill_state.total_transactions` and actual `bandcamp_sales` row counts. Northern Spy's backfill is stuck in "running" state.

**M9: Migration parity unknown.**
The `schema_migrations` table doesn't exist in the Supabase project. 42 local migration files are not tracked. It's unclear which migrations have actually been applied to production.

### Low

**L1: Inline quantity edits bypass the reason dialog.**
Admin inventory page's inline edit passes `"Inline quantity edit"` as the reason — less audit context than the dialog.

**L2: No Zod validation on `adjustInventory()` inputs.**
`src/actions/inventory.ts` — `sku`, `delta`, and `reason` are TypeScript-typed but not Zod-validated at the boundary.

**L3: Portal doesn't invalidate queries after buffer changes.**
The `+`/`-` buffer buttons call `updateInventoryBuffer()` but don't invalidate the React Query cache. Displayed value won't update until navigation.

**L4: Shopify sync is not truly bulk.**
Despite the function name `upsertProductsBulk`, it loops through products one at a time with individual `upsert()` calls.

---

## 9. Recommendations

### Immediate (fixes to data integrity)

1. **Run a full inventory backfill** for the 992 variants without inventory levels. Either trigger `shopify-full-backfill` after ensuring all products have org mappings, or write a one-time script that creates `warehouse_inventory_levels` rows by fetching current stock from Shopify for unmapped variants.

2. **Fix the InventoryItem ID lookup** in `shopify-sync.ts`. Store `shopify_inventory_item_id` on the variants table during sync (Shopify provides it in the GraphQL response at `variant.inventoryItem.id`), then query by that column directly instead of string-replacing variant IDs.

3. **Add workspace_id scoping** to `getInventoryDetail()` and `updateInventoryBuffer()` in `src/actions/inventory.ts`.

### Short-term (operational gaps)

4. **Create a Shopify store connection** in `client_store_connections` so inventory changes from Bandcamp sales flow back to Shopify via `multi-store-inventory-push`.

5. **Triage the review queue.** 1,087 items need attention. Consider adding auto-resolution for low-severity items and a dashboard for staff.

6. **Register ShipStation/Stripe/Resend webhooks** with those services if those integrations are supposed to be live.

7. **Fix the inbound product creation path** to also create a `warehouse_inventory_levels` row, or change the RPC to use UPSERT semantics.

### Medium-term (robustness)

8. **Include `safety_stock`** in the inventory list server actions so the UI reflects actual per-SKU buffer values.

9. **Implement the Redis comparison** in the backfill task to surface actual drift counts.

10. **Add org ownership verification** to `updateInventoryBuffer()` for portal users.

11. **Investigate draft product status.** Verify whether the Shopify store actually has 1,965 draft products or if the status sync is incorrect.

12. **Unstick the Northern Spy backfill.** Reset the backfill state and re-run, or fix the stale-running detection to properly recover.

---

## 10. Bandcamp Live Inventory Seed Data (April 9, 2026)

### Source File

`~/Downloads/bandcamp-live-inventory-2026-04-09.xlsx` — exported from the Bandcamp API on April 9, 2026. This is a real-time snapshot of what Bandcamp currently reports as available inventory across all connected accounts.

### File Structure

| Column | Description |
|--------|-------------|
| `Account` | Bandcamp band/label name |
| `Artist` | Bandcamp artist subdomain |
| `Album` | Album/release title |
| `Product Title` | Merch item title (e.g., "12\" Vinyl", "CD in Digipack") |
| `Option/Variant` | Option-level variant (color, size) — present on 354 rows |
| `SKU (Item)` | Item-level SKU — present on all 1,382 rows |
| `SKU (Option)` | Option-level SKU — present on 354 rows |
| `Catalog Number` | Bandcamp catalog number |
| `Price` | Item price |
| `Currency` | Currency code (USD) |
| `Qty Available (LIVE)` | Current Bandcamp inventory. **This is the seed value.** |
| `Qty Sold (LIVE)` | Cumulative units sold on Bandcamp |
| `Release Date` | Bandcamp release date |
| `Image URL` | Bandcamp thumbnail URL |
| `Package ID` | Bandcamp `package_id` (used in `bandcamp_product_mappings.bandcamp_item_id`) |

### Summary Statistics

| Metric | Count |
|--------|-------|
| Total rows | 1,382 |
| Unique accounts (bands) | 16 |
| Unique item SKUs | 1,099 |
| Unique SKUs (item + option) | 1,426 |
| Items with positive stock | 683 |
| Items with zero stock | 633 |
| Items with NULL stock (tracking disabled on Bandcamp) | 66 |
| **Total units in stock** | **35,341** |

### Inventory by Account

| Account | Items w/ Stock | Units | Zero | NULL | Total Items |
|---------|---------------|-------|------|------|-------------|
| LEAVING RECORDS | 153 | 11,049 | 184 | 19 | 356 |
| Whited Sepulchre Records | 125 | 7,035 | 88 | 4 | 217 |
| Northern Spy Records | 166 | 6,617 | 197 | 9 | 372 |
| Lord Spikeheart | 47 | 3,604 | 4 | 0 | 51 |
| True Panther | 31 | 3,015 | 47 | 7 | 85 |
| Egghunt Records | 24 | 849 | 21 | 6 | 51 |
| LILA | 18 | 842 | 9 | 1 | 28 |
| NNA Tapes | 44 | 810 | 57 | 1 | 102 |
| Birdwatcher Records | 9 | 454 | 7 | 9 | 25 |
| SUSS | 47 | 454 | 17 | 0 | 64 |
| Good Neighbor | 1 | 232 | 0 | 0 | 1 |
| In The Pines | 15 | 149 | 2 | 3 | 20 |
| Micah Thomas | 1 | 117 | 0 | 1 | 2 |
| Nicole McCabe | 1 | 74 | 0 | 4 | 5 |
| Matt McBane | 1 | 40 | 0 | 1 | 2 |
| Xol Meissner | 0 | 0 | 0 | 1 | 1 |

### Cross-Reference with Warehouse Database

| Check | Result |
|-------|--------|
| XLSX item SKUs | 1,099 |
| Matched to `warehouse_product_variants` | **1,080 (98.3%)** |
| NOT matched (no variant row in DB) | 19 |
| Of matched: has `warehouse_inventory_levels` row | 740 |
| Of matched: NO `warehouse_inventory_levels` row | **340** |
| Of those with levels: positive available | 425 |
| Of those with levels: zero available | 315 |

**Key findings:**
- 98.3% of Bandcamp SKUs already exist as warehouse variants — the catalog is well-synced.
- 19 SKUs exist in Bandcamp but NOT in the warehouse database at all (mostly merch items like t-shirts, stickers, and some older catalog numbers).
- **340 SKUs exist as variants but have no inventory level row** — these are the items that need seed data most urgently, because the system has the product but no stock count.

### Unmatched SKUs (19 items not in warehouse)

These Bandcamp items have no corresponding `warehouse_product_variants` row:

```
00198704240478
CS-EGGHUN-HELL-BLOCK
CS-IN-THE-SAN-LORENZO
CS-LEAVIN-ASHRAM
CS-LEAVIN-BANANA-LIVE
CS-LEAVIN-ELDERBERRY
CS-NNA-TA-DANCE-AND
CS-NNA-TA-THE-THIRTEEN
CS-NORTHE-LOST-AND-FOU
CS-NORTHE-REST-IN-FLEA
EHSIF-CLR
LP-LEAVIN-ELDERBERRY
LP-NNA-TA-THE-THIRTEEN
LP-NORTHE-REST-IN-FLEA
LP-NORTHE-RIP
MERCH-EGGHUN-HERE-S-TO-AL
MERCH-EGGHUN-THE-FEELING-
MERCH-IN-THE-STICKER-3-TO
MERCH-MICAH--TIDE
MERCH-NORTHE-PAISLEY
```

### NULL Qty Available (66 items)

Bandcamp returns `NULL` for `qty_available` when inventory tracking is disabled for that item. These 66 items likely have unlimited stock on Bandcamp (digital-only, or physical items with tracking turned off). They should be reviewed during the warehouse count to determine if they need a finite stock number.

### Top 20 Items by Bandcamp Stock

| SKU | Available | Sold | Account | Product |
|-----|-----------|------|---------|---------|
| CD-NS-174 | 1,528 | 653 | Northern Spy Records | Triple CD |
| HTN-U-V | 499 | 0 | LEAVING RECORDS | BLACK VINYL |
| LA-TIS-TIS1 | 492 | 0 | True Panther | the infinite spine 12\" Clear Vinyl |
| LP-WSR-044-1 | 487 | 23 | Whited Sepulchre Records | Limited Edition 12\" Vinyl |
| M-MM-2BV | 469 | 0 | LEAVING RECORDS | 2LP BLACK VINYL |
| SR-S-C | 460 | 4 | Northern Spy Records | CD |
| LP-NS-175C | 450 | 46 | Northern Spy Records | Limited Edition 12\" \"Emulsive Return\" Variant LP |
| LP-EHR-064C | 425 | 63 | Egghunt Records | Limited Edition \"Melted Cream\" color vinyl LP |
| SG-LAUS-V | 412 | 0 | LEAVING RECORDS | VINYL |
| LP-NS-177 | 410 | 89 | Northern Spy Records | Limited Edition 12\" \"Sun Slip\" Variant LP |
| CD-NS-111 | 399 | 9 | Northern Spy Records | Maurice Louca - Elephantine CD |
| 669158573523 | 387 | 0 | LEAVING RECORDS | BLACK VINYL |
| L-IWT2-B2V | 367 | 0 | LEAVING RECORDS | BLACK 2LP VINYL |
| LA-TCI-12VE | 297 | 0 | True Panther | 12\" Vinyl EP |
| P-IDTG-LE12 | 296 | 4 | Whited Sepulchre Records | Limited Edition 12\" Vinyl |
| P-IDTG-LECD | 294 | 6 | Whited Sepulchre Records | Limited Edition Compact Disc |
| E-P-LE12 | 289 | 13 | Whited Sepulchre Records | Limited Edition 12\" Vinyl |
| BDW-TI-BV | 287 | 0 | LEAVING RECORDS | BLACK VINYL |
| CD-NS-177 | 273 | 27 | Northern Spy Records | Compact Disc |
| TW-SW-V | 271 | 0 | LEAVING RECORDS | VINYL |

### Seeding Plan: How to Use This Data

The intention is to use this Bandcamp live inventory as the **initial seed** for the warehouse database, then follow up with a physical warehouse count to correct the numbers.

**Phase 1: Seed from Bandcamp data**

The seeding script needs to handle three categories:

1. **740 SKUs with existing inventory levels** — These already have `warehouse_inventory_levels` rows. The seed should UPDATE `available` to the Bandcamp `Qty Available (LIVE)` value, overwriting any current placeholder values (e.g., the 999s). This is a bulk `UPDATE ... SET available = {bandcamp_qty} WHERE sku = {sku}`.

2. **340 SKUs with variants but no inventory level** — These need `INSERT INTO warehouse_inventory_levels` with the Bandcamp quantity. The variant_id can be resolved by looking up `warehouse_product_variants` by SKU.

3. **19 SKUs not in warehouse at all** — These need variant + product rows created first (or can be deferred until the Shopify sync picks them up). Most are merch items (t-shirts, stickers) that may not be in Shopify.

4. **66 items with NULL qty_available** — These need manual review during the warehouse count. For seeding, either skip them (leave as 0) or set to a default pending count.

After writing to Postgres, the same values must be written to Redis (`inv:{sku}`) to keep the projection in sync — or the weekly backfill can be triggered manually.

**Key technical requirements for the seed script:**
- Must use the service-role Supabase client (bypasses RLS)
- Should NOT use `recordInventoryChange()` for bulk seeding — that path is for incremental changes with idempotency. Use direct `upsert()` like `shopify-sync` does (Rule #59 exception).
- Must update Redis after Postgres writes
- Should log a single `warehouse_inventory_activity` record with `source: "backfill"` and `correlation_id: "bandcamp-seed:2026-04-09"` for audit trail
- Should produce a summary report: how many updated, inserted, skipped, and any errors

**Phase 2: Physical warehouse count**

After seeding, staff will do a physical count in the warehouse. The app's manual adjustment feature (`adjustInventory()` in `src/actions/inventory.ts`) can be used to correct individual SKUs, or a bulk import script can process a count spreadsheet. Each adjustment flows through `recordInventoryChange()` with `source: "manual"`, preserving the audit trail.

**Phase 3: Ongoing sync**

Once seeded and corrected, the existing cron jobs maintain sync:
- Bandcamp sale poll (5 min) detects sales and decrements stock
- Bandcamp inventory push (5 min) pushes warehouse stock TO Bandcamp
- Shopify sync (15 min) pulls catalog changes FROM Shopify
- Sensor check (5 min) detects and auto-heals Redis/Postgres drift

---

## Appendix: Supabase Configuration

| Setting | Value |
|---------|-------|
| Project URL | `https://yspmgzphxlkcnfalndbh.supabase.co` |
| Database | Port 6543 (Supavisor/PgBouncer), port 5432 (direct) |
| Redis | `https://smooth-goldfish-38578.upstash.io` |
| Shopify Store | `https://kw16ph-t9.myshopify.com` |
| Shopify API Version | `2026-01` |
| App URL | `https://cpanel.clandestinedistro.com` |
