# Store Connections — Technical Handoff

**App:** `clandestine-fulfillment` — Next.js 14 App Router, Supabase, Trigger.dev v4, `@tanstack/react-query`  
**Live site:** `https://cpanel.clandestinedistro.com`  
**Purpose:** Connect client-owned Shopify / WooCommerce / Squarespace stores for bidirectional inventory sync and order ingestion.

---

## Audit Summary — What Works vs What Doesn't

| Platform | Create connection | Enter credentials | Test connection | Inventory push (warehouse → store) | Order pull (store → warehouse) | Webhook ingest |
|---|---|---|---|---|---|---|
| **Squarespace** | ✅ | ✅ | ✅ | ✅ Full implementation | ✅ Full implementation | ⚠️ No HMAC verify |
| **WooCommerce** | ✅ | ✅ | ✅ | ✅ Full implementation | ✅ Full implementation | ✅ |
| **Shopify (client)** | ✅ | ✅ | ✅ REST check | ❌ Throws "not yet implemented" | ❌ Throws "not yet implemented" | ✅ Ingest only |
| **BigCommerce** | ✅ (UI only) | ✅ | ❌ Throws | ❌ Throws | ❌ Throws | — |

**Critical gap:** Shopify client-store inventory push and order polling are explicitly stubbed out as `throw new Error("not yet implemented")`. The connection infrastructure, credentials, webhook ingest, and DB schema are all in place — only the Shopify REST API calls inside `store-sync-client.ts` need to be built.

---

## Data Flow Overview

```
1. Staff creates connection in UI
   → client_store_connections row (status: "pending", do_not_fanout: true)

2. Credentials entered (API key / secret)
   → api_key + api_secret stored in client_store_connections

3. "Test" button hit
   → testStoreConnection() makes live API call
   → On success: status = "active"

4. Auto-discover SKUs
   → autoDiscoverSkus() fetches remote product SKUs
   → Matches against warehouse_product_variants.sku for the org
   → Writes client_store_sku_mappings rows

5. Trigger: multi-store-inventory-push (every 5 min)
   → For each active connection with do_not_fanout=false
   → Reads sku_mappings → warehouse_inventory_levels
   → Pushes changed quantities via platform API
   → Records last_pushed_quantity (for echo cancellation)

6. Trigger: client-store-order-detect (every 10 min)
   → For each active connection
   → Polls orders since last_poll_at
   → Creates warehouse_orders + warehouse_order_items

7. Webhook (real-time, optional)
   POST /api/webhooks/client-store?connection_id=X&platform=Y
   → Verifies HMAC (Shopify/WooCommerce)
   → Deduplicates via webhook_events
   → Triggers process-client-store-webhook task
   → Handles inventory update OR order creation
```

---

## Database Schema

### `client_store_connections`

```sql
CREATE TABLE client_store_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  platform text NOT NULL CHECK (platform IN ('shopify', 'woocommerce', 'squarespace', 'bigcommerce')),
  store_url text NOT NULL,
  api_key text,           -- Shopify: Access Token; Squarespace: API key; WooCommerce: Consumer Key
  api_secret text,        -- WooCommerce: Consumer Secret; unused for Shopify/Squarespace
  webhook_url text,       -- The URL to register in the platform (this app's webhook endpoint)
  webhook_secret text,    -- HMAC secret for verifying incoming webhooks
  connection_status text NOT NULL DEFAULT 'pending'
    CHECK (connection_status IN ('pending', 'active', 'disabled_auth_failure', 'error')),
  last_webhook_at timestamptz,   -- Last time we received a webhook
  last_poll_at timestamptz,      -- Last time we polled for orders / inventory
  last_error_at timestamptz,
  last_error text,
  do_not_fanout boolean DEFAULT false,  -- true = paused, won't push inventory
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**RLS:** Staff full CRUD. Clients SELECT own org only. Credential writes go through `submitClientStoreCredentials` via service_role to bypass staff-only write policy.

### `client_store_sku_mappings`

```sql
CREATE TABLE client_store_sku_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id),
  remote_product_id text,    -- Platform product ID in the remote store
  remote_variant_id text,    -- Platform variant ID in the remote store
  remote_sku text,           -- SKU as it appears in the remote store
  last_pushed_quantity integer,   -- Last quantity we pushed (echo cancellation)
  last_pushed_at timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id, variant_id)
);
```

---

## TypeScript Types

```ts
// src/lib/shared/types.ts

export type ConnectionStatus = "pending" | "active" | "disabled_auth_failure" | "error";
export type StorePlatform = "shopify" | "woocommerce" | "squarespace" | "bigcommerce";

export interface ClientStoreConnection {
  id: string;
  workspace_id: string;
  org_id: string;
  platform: StorePlatform;
  store_url: string;
  api_key: string | null;
  api_secret: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  connection_status: ConnectionStatus;
  last_webhook_at: string | null;
  last_poll_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  do_not_fanout: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClientStoreSkuMapping {
  id: string;
  workspace_id: string;
  connection_id: string;
  variant_id: string;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_sku: string | null;
  last_pushed_quantity: number | null;
  last_pushed_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
```

---

## File 1: UI Page — `src/app/admin/settings/store-connections/page.tsx`

Client component. Shows all connections grouped by org. Provides:
- Filter by platform / status
- "Add Connection" dialog (org + platform + store URL)
- "Test" button per connection (live API call)
- "Disable" button

**What it calls:**
- `getUserContext()` → `getStoreConnections({ workspaceId })` → renders table
- `getOrganizationsForWorkspace(workspaceId)` → populates org dropdown in Add dialog
- `createStoreConnection({ orgId, platform, storeUrl })` mutation
- `testStoreConnection(connectionId)` mutation
- `disableStoreConnection(connectionId)` mutation

---

## File 2: Server Actions — `src/actions/store-connections.ts`

```ts
"use server";

// === Types ===
export type ConnectionFilters = {
  workspaceId?: string;
  orgId?: string;
  platform?: StorePlatform;
  status?: ConnectionStatus;
};

// List all connections with org name + sku mapping count
export async function getStoreConnections(rawFilters?: ConnectionFilters): Promise<{
  connections: Array<ClientStoreConnection & { org_name: string; sku_mapping_count: number }>;
}> { ... }

// Create pending connection (no credentials yet)
export async function createStoreConnection(rawData: {
  orgId: string;
  platform: StorePlatform;
  storeUrl: string;
}): Promise<ClientStoreConnection> { ... }

// Test connection — makes live API call per platform
// Updates last_poll_at on success, last_error on failure
export async function testStoreConnection(
  connectionId: string,
): Promise<{ success: boolean; error?: string }> {
  switch (conn.platform) {
    case "squarespace":
      // calls squarespace-client.getInventory()
    case "woocommerce":
      // calls woocommerce-client.getOrders()
    case "shopify":
      // GET {store_url}/admin/api/2024-01/shop.json  with X-Shopify-Access-Token header
      // ✅ This works — just a simple REST check
    default:
      throw new Error(`Test not supported for platform: ${conn.platform}`);
  }
}

// Disable — sets do_not_fanout=true, status="error"
export async function disableStoreConnection(connectionId: string): Promise<{ success: true }> { ... }

// Get SKU mappings for a connection
export async function getSkuMappings(connectionId: string): Promise<...> { ... }

// Auto-discover remote SKUs and match to warehouse variants
// ⚠️ Only implemented for squarespace and woocommerce
// ❌ Shopify: throws "Auto-discover not supported for platform: shopify"
export async function autoDiscoverSkus(
  connectionId: string,
): Promise<{ matched: number; unmatched: number }> {
  switch (conn.platform) {
    case "squarespace":
      // calls squarespace-client.getInventory() → matches SKUs
    case "woocommerce":
      // fetches /wp-json/wc/v3/products → matches SKUs
    default:
      throw new Error(`Auto-discover not supported for platform: ${conn.platform}`);
  }
}
```

---

## File 3: Credential Submission — `src/actions/client-store-credentials.ts`

Allows client users (not just staff) to enter their own API credentials.  
Enforces org ownership — a client can only update a connection that belongs to their org.  
Uses `createServiceRoleClient()` to bypass the staff-only RLS write policy.

```ts
"use server";

export async function submitClientStoreCredentials(
  connectionId: string,
  credentials: { apiKey: string; apiSecret?: string },
): Promise<{ success: true }> {
  // 1. Auth check — must be authenticated
  // 2. Look up connection.org_id via service role
  // 3. Look up user's org_id via service role
  // 4. Assert connection.org_id === user.org_id
  // 5. Write api_key + api_secret via service role
  // Credentials stored in client_store_connections.api_key / api_secret
}
```

---

## File 4: Webhook Route — `src/app/api/webhooks/client-store/route.ts`

**URL pattern:** `POST /api/webhooks/client-store?connection_id={uuid}&platform={platform}`

This is the URL you register in Shopify/WooCommerce as your webhook endpoint.

```ts
export async function POST(request: NextRequest) {
  // 1. Read raw body text (never parse JSON first — needed for HMAC)
  const rawBody = await readWebhookBody(request);

  // 2. Extract connection_id from query params
  const connectionId = request.nextUrl.searchParams.get("connection_id");

  // 3. Look up connection to get webhook_secret and platform
  const { data: connection } = await supabase
    .from("client_store_connections")
    .select("id, workspace_id, platform, webhook_secret")
    .eq("id", connectionId)
    .single();

  // 4. HMAC verification per platform:
  //    - Shopify: X-Shopify-Hmac-SHA256 header, SHA-256
  //    - WooCommerce: X-WC-Webhook-Signature header, SHA-256
  //    ⚠️ Squarespace: No HMAC verification implemented

  // 5. Dedup: INSERT into webhook_events with external_webhook_id
  //    (unique constraint → duplicate returns 200 immediately)

  // 6. Trigger process-client-store-webhook task with webhookEventId

  // 7. Return 200 immediately (heavy processing in Trigger)
}
```

---

## File 5: Webhook Processing Task — `src/trigger/tasks/process-client-store-webhook.ts`

Trigger.dev task `id: "process-client-store-webhook"`.  
Fires on every valid incoming webhook. `maxDuration: 60s`.

```ts
export const processClientStoreWebhookTask = task({
  id: "process-client-store-webhook",
  run: async ({ webhookEventId }) => {
    // Fetches webhook_event row
    // Routes by topic:

    // topic contains "inventory" or "stock":
    //   → handleInventoryUpdate()
    //   → reads webhook payload for sku + quantity
    //   → echo cancellation via client_store_sku_mappings.last_pushed_quantity
    //   → computes delta vs warehouse_inventory_levels
    //   → calls recordInventoryChange() — same atomic RPC used everywhere
    //   → marks webhook_event.status = "processed"

    // topic contains "order":
    //   → handleOrderCreated()
    //   → checks for duplicate in warehouse_orders
    //   → looks up org_id from connection
    //   → inserts warehouse_orders + warehouse_order_items
    //   → marks webhook_event.status = "processed"
  }
});
```

**Webhook topic field**: The task reads `event.topic` which comes from:
- Shopify: `X-Shopify-Topic` header (e.g. `inventory_levels/update`, `orders/create`)
- WooCommerce: `X-WC-Webhook-Topic` header (e.g. `order.created`, `product.updated`)

---

## File 6: Inventory Push Cron — `src/trigger/tasks/multi-store-inventory-push.ts`

Trigger.dev task `id: "multi-store-inventory-push"`, runs every 5 minutes.

```ts
export const multiStoreInventoryPushTask = schedules.task({
  cron: "*/5 * * * *",
  maxDuration: 180,
  run: async () => {
    // For each workspace:
    //   For each active connection with do_not_fanout=false:
    //     1. Get sku_mappings for connection
    //     2. Get warehouse_inventory_levels for mapped variant_ids
    //     3. For each mapping where quantity changed since last push:
    //        → client.pushInventory(sku, quantity, idempotencyKey)
    //        → update last_pushed_quantity + last_pushed_at
    //     4. Circuit breaker: 5 auth failures → auto-disable + review queue item

    // ✅ Squarespace: pushInventory uses DELTA adjustment via /commerce/inventory/adjustments
    // ✅ WooCommerce: pushInventory uses ABSOLUTE quantity via PUT /products/{id}
    // ❌ Shopify: pushInventory throws "not yet implemented"
    // ❌ BigCommerce: throws "not yet implemented"
  }
});
```

**Circuit breaker:** After 5 consecutive auth failures, connection is set to `connection_status: "disabled_auth_failure"` and a review queue item is created.

---

## File 7: Order Poll Cron — `src/trigger/tasks/client-store-order-detect.ts`

Trigger.dev task `id: "client-store-order-detect"`, runs every 10 minutes.

```ts
export const clientStoreOrderDetectTask = schedules.task({
  cron: "*/10 * * * *",
  maxDuration: 180,
  run: async () => {
    // For each workspace:
    //   For each active connection:
    //     1. Get orders since last_poll_at (or last 24h if never polled)
    //     2. Echo cancellation: skip orders where all line items match last_pushed_quantity
    //     3. Dedup: skip if warehouse_orders already has this remoteOrderId + platform
    //     4. Insert warehouse_orders + warehouse_order_items
    //     5. Update last_poll_at

    // ✅ Squarespace: getOrders via /api/1.0/commerce/orders?modifiedAfter=
    // ✅ WooCommerce: getOrders via /wp-json/wc/v3/orders?after=
    // ❌ Shopify: getOrders throws "not yet implemented"
    // ❌ BigCommerce: throws "not yet implemented"
  }
});
```

---

## File 8: Platform Dispatch — `src/lib/clients/store-sync-client.ts`

**This is the critical file with the gaps.** Routes push/pull calls to platform-specific implementations.

```ts
export interface StoreSyncClient {
  pushInventory(sku: string, quantity: number, idempotencyKey: string): Promise<void>;
  getRemoteQuantity(sku: string): Promise<number | null>;
  getOrders(since: string): Promise<RemoteOrder[]>;
}

export function createStoreSyncClient(
  connection: ClientStoreConnection,
  skuMappings?: Map<string, SkuMappingContext>,
): StoreSyncClient {
  switch (connection.platform) {
    case "shopify":
      return createShopifySync(connection);      // ❌ ALL methods throw
    case "squarespace":
      return createSquarespaceSync(connection);  // ✅ fully implemented
    case "woocommerce":
      return createWooCommerceSync(connection, skuMappings); // ✅ fully implemented
    case "bigcommerce":
      throw new Error("BigCommerce sync not yet implemented"); // ❌
  }
}

// ❌ SHOPIFY — STUBBED OUT:
function createShopifySync(_connection: ClientStoreConnection): StoreSyncClient {
  return {
    async pushInventory(_sku, _quantity, _idempotencyKey) {
      throw new Error("Shopify client store push not yet implemented — use Trigger task");
    },
    async getRemoteQuantity(_sku) {
      throw new Error("Shopify client store read not yet implemented — use Trigger task");
    },
    async getOrders(_since) {
      throw new Error("Shopify client store orders not yet implemented — use Trigger task");
    },
  };
}

// ✅ SQUARESPACE — FULLY IMPLEMENTED:
function createSquarespaceSync(connection: ClientStoreConnection): StoreSyncClient {
  // pushInventory: reads current inventory → computes delta → POST /commerce/inventory/adjustments
  // getRemoteQuantity: GET /commerce/inventory → finds by SKU
  // getOrders: GET /commerce/orders?modifiedAfter=
}

// ✅ WOOCOMMERCE — FULLY IMPLEMENTED:
function createWooCommerceSync(connection, skuMappings): StoreSyncClient {
  // pushInventory: looks up productId by SKU → PUT /products/{id} with absolute quantity
  // getRemoteQuantity: GET /products?sku={sku}
  // getOrders: GET /orders?after={since}
}
```

---

## File 9: Squarespace API Client — `src/lib/clients/squarespace-client.ts`

Shows the pattern to follow for Shopify implementation.

```ts
// Auth: Bearer token in Authorization header
// Base URL: {storeUrl}/api/1.0

async function sqspFetch(apiKey, storeUrl, path, options): Promise<Response> {
  // fetch(`${storeUrl}/api/1.0${path}`, { Authorization: `Bearer ${apiKey}` })
}

export async function getInventory(apiKey, storeUrl): Promise<SquarespaceInventoryItem[]> {
  // GET /commerce/inventory
  // Returns: Array<{ variantId, sku, quantity, isUnlimited }>
}

export async function adjustInventory(apiKey, storeUrl, variantId, quantity, idempotencyKey): Promise<void> {
  // POST /commerce/inventory/adjustments
  // Body: { incrementOperations: [{ variantId, quantity }] }
  // Note: DELTA adjustment, not absolute
  // Idempotency-Key header prevents duplicate adjustments
}

export async function getOrders(apiKey, storeUrl, params?): Promise<{ orders, nextCursor }> {
  // GET /commerce/orders?modifiedAfter={iso}
  // Returns paginated order list with lineItems
}
```

---

## File 10: WooCommerce API Client — `src/lib/clients/woocommerce-client.ts`

```ts
// Auth: Basic Auth (consumerKey:consumerSecret)
// Base URL: {siteUrl}/wp-json/wc/v3

export async function getProductBySku(credentials, sku): Promise<WooProduct | null> {
  // GET /products?sku={sku}
}

export async function updateStockQuantity(credentials, productId, quantity): Promise<WooProduct> {
  // PUT /products/{id}
  // Body: { stock_quantity: quantity, manage_stock: true }
  // Note: ABSOLUTE quantity (not delta) — Rule #44
}

export async function getOrders(credentials, params?): Promise<WooOrder[]> {
  // GET /orders?after={iso}&per_page=N
}
```

---

## File 11: `autoDiscoverSkus` in `store-connections.ts`

Maps remote store SKUs to warehouse variants. Must be run after connecting credentials to enable sync.

```ts
export async function autoDiscoverSkus(connectionId): Promise<{ matched: number; unmatched: number }> {
  // 1. Load connection
  // 2. Fetch remote SKUs by platform:
  //    Squarespace: getInventory() → extract sku fields
  //    WooCommerce: GET /products?per_page=100 → extract sku fields
  //    ❌ Shopify: throws "Auto-discover not supported for platform: shopify"
  // 3. Query warehouse_product_variants.sku where sku IN (remote_skus)
  //    AND warehouse_products.org_id = connection.org_id
  // 4. Upsert client_store_sku_mappings (connection_id, variant_id) — conflict ignored
  // Returns count of matched/unmatched
}
```

---

## What Needs to Be Built for Shopify Client Stores

Everything below goes in `src/lib/clients/store-sync-client.ts` inside `createShopifySync()`.

### Shopify API reference

- **Auth:** `X-Shopify-Access-Token: {api_key}` header on all requests
- **Base URL:** `{store_url}/admin/api/2024-01/`
- **Store URL format:** `https://storename.myshopify.com`

### 1. `pushInventory(sku, quantity, idempotencyKey)`

Shopify requires you know the `inventory_item_id` and `location_id` for a variant. Steps:
1. `GET /admin/api/2024-01/variants.json?sku={sku}` → get `inventory_item_id`
2. `GET /admin/api/2024-01/inventory_levels.json?inventory_item_ids={id}` → get `location_id`
3. `POST /admin/api/2024-01/inventory_levels/set.json` with `{ location_id, inventory_item_id, available: quantity }`

Note: Shopify uses **absolute quantities** (same as WooCommerce, different from Squarespace which uses deltas).

```ts
async pushInventory(sku: string, quantity: number, _idempotencyKey: string) {
  const shopifyUrl = connection.store_url.replace(/\/$/, "");
  const headers = { "X-Shopify-Access-Token": connection.api_key!, "Content-Type": "application/json" };

  // 1. Find variant by SKU
  const variantsRes = await fetch(`${shopifyUrl}/admin/api/2024-01/variants.json?sku=${encodeURIComponent(sku)}`, { headers });
  if (!variantsRes.ok) throw new Error(`Shopify variants lookup failed: ${variantsRes.status}`);
  const { variants } = await variantsRes.json();
  if (!variants?.length) throw new Error(`SKU ${sku} not found in Shopify`);
  const inventoryItemId = variants[0].inventory_item_id;

  // 2. Get location_id
  const levelsRes = await fetch(`${shopifyUrl}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${inventoryItemId}`, { headers });
  if (!levelsRes.ok) throw new Error(`Shopify inventory levels lookup failed: ${levelsRes.status}`);
  const { inventory_levels } = await levelsRes.json();
  if (!inventory_levels?.length) throw new Error(`No inventory level found for SKU ${sku}`);
  const locationId = inventory_levels[0].location_id;

  // 3. Set absolute quantity
  const setRes = await fetch(`${shopifyUrl}/admin/api/2024-01/inventory_levels/set.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantity }),
  });
  if (!setRes.ok) throw new Error(`Shopify inventory set failed: ${setRes.status}`);
}
```

### 2. `getRemoteQuantity(sku)`

```ts
async getRemoteQuantity(sku: string) {
  const shopifyUrl = connection.store_url.replace(/\/$/, "");
  const headers = { "X-Shopify-Access-Token": connection.api_key! };
  const res = await fetch(`${shopifyUrl}/admin/api/2024-01/variants.json?sku=${encodeURIComponent(sku)}`, { headers });
  if (!res.ok) return null;
  const { variants } = await res.json();
  // Would need to cross-reference inventory_levels to get available quantity
  return variants?.[0]?.inventory_quantity ?? null;
}
```

### 3. `getOrders(since)`

```ts
async getOrders(since: string) {
  const shopifyUrl = connection.store_url.replace(/\/$/, "");
  const headers = { "X-Shopify-Access-Token": connection.api_key! };
  const res = await fetch(
    `${shopifyUrl}/admin/api/2024-01/orders.json?created_at_min=${encodeURIComponent(since)}&status=any&limit=50`,
    { headers }
  );
  if (!res.ok) throw new Error(`Shopify orders fetch failed: ${res.status}`);
  const { orders } = await res.json();
  return orders.map((o: ShopifyOrder) => ({
    remoteOrderId: String(o.id),
    orderNumber: o.order_number ? String(o.order_number) : o.name,
    createdAt: o.created_at,
    lineItems: (o.line_items ?? []).map((li: ShopifyLineItem) => ({
      sku: li.sku ?? "",
      quantity: li.quantity,
      remoteProductId: String(li.product_id),
      remoteVariantId: li.variant_id ? String(li.variant_id) : null,
    })),
  }));
}
```

### 4. `autoDiscoverSkus` for Shopify

In `src/actions/store-connections.ts`, add a `case "shopify":` block:

```ts
case "shopify": {
  if (!conn.api_key) throw new Error("Missing API key");
  const shopifyUrl = conn.store_url.replace(/\/$/, "");
  const headers = { "X-Shopify-Access-Token": conn.api_key };

  // Paginate through all products
  let url = `${shopifyUrl}/admin/api/2024-01/products.json?limit=250&fields=id,variants`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const { products } = await res.json();
    for (const product of products) {
      for (const variant of product.variants ?? []) {
        if (variant.sku) {
          remoteSkus.push({
            sku: variant.sku,
            remoteProductId: String(product.id),
            remoteVariantId: String(variant.id),
          });
        }
      }
    }
    // Handle pagination via Link header
    const link = res.headers.get("Link");
    const nextMatch = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch?.[1] ?? "";
  }
  break;
}
```

### 5. Squarespace HMAC verification (missing)

In `src/app/api/webhooks/client-store/route.ts`:

```ts
// Currently only Shopify and WooCommerce have HMAC verification.
// Squarespace webhooks include an HMAC-SHA256 signature in the
// "X-Squarespace-Signature" header. Add:
} else if (connection.platform === "squarespace") {
  signature = request.headers.get("X-Squarespace-Signature");
}
```

---

## Credentials Required Per Platform

| Platform | `api_key` field | `api_secret` field | Webhook secret |
|---|---|---|---|
| **Shopify** | Private app Access Token (not API key) | Not used | Optional: Shopify webhook signing secret |
| **WooCommerce** | Consumer Key (from WooCommerce → Settings → Advanced → REST API) | Consumer Secret | Optional: WooCommerce webhook secret |
| **Squarespace** | API Key (from Squarespace Developer Console → API Keys) | Not used | Not currently verified |

**Getting Shopify credentials:**
1. Shopify Admin → Settings → Apps and sales channels → Develop apps
2. Create a private app with scopes: `read_inventory`, `write_inventory`, `read_orders`, `read_products`
3. Install app → copy "Admin API access token"
4. Use full store URL: `https://yourstore.myshopify.com`

**Webhook URL to register in Shopify:**
```
https://cpanel.clandestinedistro.com/api/webhooks/client-store?connection_id={uuid}&platform=shopify
```
Events to subscribe: `orders/create`, `inventory_levels/update`

---

## Connection Status State Machine

```
pending → (credentials entered + test passes) → active
active → (5 consecutive auth failures in push) → disabled_auth_failure
active → (manual disable) → error
disabled_auth_failure → (manual re-enable + re-test) → active
```

`do_not_fanout = true` blocks inventory push even if status is `active`.  
New connections are created with `do_not_fanout = true` and must be manually enabled after credentials/SKUs are set.

---

## SKU Mapping is Required for Sync to Work

The `client_store_sku_mappings` table is the bridge between warehouse variants and remote store products.  
**Without mappings, `multi-store-inventory-push` pushes 0 items and `client-store-order-detect` still polls but cannot map orders to org.**

The `autoDiscoverSkus()` function tries to auto-create these by matching SKUs.  
It requires that the SKUs in the remote store exactly match the `sku` field in `warehouse_product_variants` for that org.  
If SKUs differ between systems, mappings must be created manually.

---

## Files Summary

| File | Purpose | Status |
|---|---|---|
| `src/app/admin/settings/store-connections/page.tsx` | Admin UI — create, test, disable connections | ✅ Works |
| `src/actions/store-connections.ts` | CRUD + test + auto-discover SKUs | ⚠️ Shopify auto-discover not implemented |
| `src/actions/client-store-credentials.ts` | Client-side credential submission | ✅ Works |
| `src/app/api/webhooks/client-store/route.ts` | Webhook ingest endpoint | ⚠️ Squarespace HMAC missing |
| `src/trigger/tasks/process-client-store-webhook.ts` | Webhook → inventory/order processing | ✅ Logic correct |
| `src/trigger/tasks/multi-store-inventory-push.ts` | Cron: push inventory every 5min | ❌ Shopify throws |
| `src/trigger/tasks/client-store-order-detect.ts` | Cron: poll orders every 10min | ❌ Shopify throws |
| `src/lib/clients/store-sync-client.ts` | **Platform dispatch — THE GAP IS HERE** | ❌ Shopify/BigCommerce stub only |
| `src/lib/clients/squarespace-client.ts` | Squarespace REST API client | ✅ Full implementation |
| `src/lib/clients/woocommerce-client.ts` | WooCommerce REST API v3 client | ✅ Full implementation |
| `supabase/migrations/20260316000011_store_connections.sql` | DB schema for connections + mappings | ✅ Complete |
| `src/lib/shared/types.ts` | `ClientStoreConnection`, `ClientStoreSkuMapping` types | ✅ Complete |
