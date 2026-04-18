# Shopify Hardening — Code Reference 03: Server Actions & UI

Part 3 of 6. Server actions for store connections, portal/admin UI pages, and inventory fanout.

Related: [01 OAuth & Webhooks](01-oauth-webhooks.md) · [02 Trigger Tasks](02-trigger-tasks-existing.md) · [04 Bandcamp Chain](04-bandcamp-shopify-chain.md) · [05 New Code](05-new-code-skeletons.md) · [06 Migrations & Config](06-migrations-config-tests.md)

---

## Table of Contents

1. [`src/actions/store-connections.ts`](#1-store-connections-admin-actions) — 459 lines
2. [`src/actions/portal-stores.ts`](#2-portal-stores-actions) — 110 lines
3. [`src/actions/client-store-credentials.ts`](#3-client-store-credentials) — 85 lines
4. [`src/app/portal/stores/page.tsx`](#4-portal-stores-page) — 434 lines
5. [`src/app/admin/settings/store-connections/page.tsx`](#5-admin-store-connections-page) — 371 lines
6. [`src/lib/server/inventory-fanout.ts`](#6-inventory-fanout) — 149 lines
7. [`src/lib/clients/store-sync-client.ts`](#7-store-sync-client) — 278 lines

---

## 1. Store Connections Admin Actions

### File: `src/actions/store-connections.ts`

**Role**: Admin-facing server actions for listing/creating/updating/testing store connections and discovering SKUs.

**Plan modifications (Phase 2)**:
- Extend `autoDiscoverSkus` with multi-signal matching (exact → barcode → title fuzzy)
- Add WooCommerce variations fetch at `/products/{id}/variations`
- Fetch Shopify products with `fields=id,title,product_type,vendor,variants` (include barcode)
- Write `match_confidence`, `match_status`, `match_score`, `remote_title`, `remote_barcode`, `remote_inventory_item_id` columns
- New actions: `approveSkuMapping`, `rejectSkuMapping`, `manuallyMapSku`, `pushRemoteSku`

```typescript
"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type {
  ClientStoreConnection,
  ClientStoreSkuMapping,
  ConnectionStatus,
  StorePlatform,
} from "@/lib/shared/types";

// === Zod schemas (Rule #5) ===

const connectionFiltersSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  orgId: z.string().optional(),
  platform: z.enum(["shopify", "woocommerce", "squarespace", "bigcommerce", "discogs"]).optional(),
  status: z.enum(["pending", "active", "disabled_auth_failure", "error"]).optional(),
});

export type ConnectionFilters = z.infer<typeof connectionFiltersSchema>;

const createConnectionSchema = z.object({
  orgId: z.string().min(1),
  platform: z.enum(["shopify", "woocommerce", "squarespace", "bigcommerce", "discogs"]),
  storeUrl: z.string().url(),
});

const updateConnectionSchema = z.object({
  storeUrl: z.string().url().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().nullable().optional(),
});

// === Server Actions ===

/**
 * List store connections with health status columns (Rule #28).
 */
export async function getStoreConnections(rawFilters?: ConnectionFilters): Promise<{
  connections: Array<ClientStoreConnection & { org_name: string; sku_mapping_count: number }>;
}> {
  await requireAuth();
  const filters = connectionFiltersSchema.parse(rawFilters ?? {});
  const serviceClient = createServiceRoleClient();

  let query = serviceClient
    .from("client_store_connections")
    .select("*, organizations!inner(name)")
    .order("created_at", { ascending: false });

  if (filters.workspaceId) query = query.eq("workspace_id", filters.workspaceId);
  if (filters.orgId) query = query.eq("org_id", filters.orgId);
  if (filters.platform) query = query.eq("platform", filters.platform);
  if (filters.status) query = query.eq("connection_status", filters.status);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch store connections: ${error.message}`);

  const connections = data ?? [];

  // Fetch SKU mapping counts per connection
  const connectionIds = connections.map((c) => c.id);
  const mappingCounts: Record<string, number> = {};

  if (connectionIds.length > 0) {
    const { data: countData } = await serviceClient
      .from("client_store_sku_mappings")
      .select("connection_id", { count: "exact", head: false })
      .in("connection_id", connectionIds)
      .eq("is_active", true);

    if (countData) {
      for (const row of countData) {
        const cid = row.connection_id as string;
        mappingCounts[cid] = (mappingCounts[cid] ?? 0) + 1;
      }
    }
  }

  return {
    connections: connections.map((c) => {
      const org = c.organizations as unknown as { name: string };
      return {
        ...c,
        organizations: undefined,
        org_name: org?.name ?? "",
        sku_mapping_count: mappingCounts[c.id] ?? 0,
      } as ClientStoreConnection & { org_name: string; sku_mapping_count: number };
    }),
  };
}

/**
 * Create a new pending store connection.
 */
export async function createStoreConnection(rawData: {
  orgId: string;
  platform: StorePlatform;
  storeUrl: string;
}): Promise<ClientStoreConnection> {
  await requireAuth();
  const data = createConnectionSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Derive workspace_id from org
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .select("workspace_id")
    .eq("id", data.orgId)
    .single();

  if (orgError || !org) throw new Error("Organization not found");

  const { data: connection, error } = await serviceClient
    .from("client_store_connections")
    .insert({
      workspace_id: org.workspace_id,
      org_id: data.orgId,
      platform: data.platform,
      store_url: data.storeUrl,
      connection_status: "pending" as ConnectionStatus,
      do_not_fanout: true,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create connection: ${error.message}`);

  return connection as ClientStoreConnection;
}

/**
 * Edit connection details.
 */
export async function updateStoreConnection(
  connectionId: string,
  rawData: { storeUrl?: string; webhookUrl?: string | null; webhookSecret?: string | null },
): Promise<{ success: true }> {
  await requireAuth();
  const data = updateConnectionSchema.parse(rawData);

  const serviceClient = createServiceRoleClient();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.storeUrl !== undefined) update.store_url = data.storeUrl;
  if (data.webhookUrl !== undefined) update.webhook_url = data.webhookUrl;
  if (data.webhookSecret !== undefined) update.webhook_secret = data.webhookSecret;

  const { error } = await serviceClient
    .from("client_store_connections")
    .update(update)
    .eq("id", connectionId);

  if (error) throw new Error(`Failed to update connection: ${error.message}`);

  return { success: true };
}

/**
 * Disable a connection — sets status to error and stops fanout.
 * Rule #53: do_not_fanout stops inventory pushes to degraded connections.
 */
export async function disableStoreConnection(connectionId: string): Promise<{ success: true }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { error } = await serviceClient
    .from("client_store_connections")
    .update({
      connection_status: "error" as ConnectionStatus,
      do_not_fanout: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId);

  if (error) throw new Error(`Failed to disable connection: ${error.message}`);

  return { success: true };
}

/**
 * Test a store connection by attempting an API call.
 * Updates last_poll_at on success, last_error on failure.
 * Rule #52: typed health states.
 */
export async function testStoreConnection(
  connectionId: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: connection, error: fetchError } = await serviceClient
    .from("client_store_connections")
    .select("*")
    .eq("id", connectionId)
    .single();

  if (fetchError || !connection) throw new Error("Connection not found");

  const conn = connection as ClientStoreConnection;
  const now = new Date().toISOString();

  try {
    switch (conn.platform) {
      case "squarespace": {
        if (!conn.api_key) throw new Error("Missing API key");
        const { getInventory } = await import("@/lib/clients/squarespace-client");
        await getInventory(conn.api_key, conn.store_url);
        break;
      }
      case "woocommerce": {
        if (!conn.api_key || !conn.api_secret) throw new Error("Missing credentials");
        const { getOrders } = await import("@/lib/clients/woocommerce-client");
        await getOrders(
          { consumerKey: conn.api_key, consumerSecret: conn.api_secret, siteUrl: conn.store_url },
          { perPage: 1 },
        );
        break;
      }
      case "shopify": {
        // Shopify client store test — simple REST call
        if (!conn.api_key) throw new Error("Missing API key");
        const res = await fetch(`${conn.store_url}/admin/api/2026-01/shop.json`, {
          headers: { "X-Shopify-Access-Token": conn.api_key },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        break;
      }
      default:
        throw new Error(`Test not supported for platform: ${conn.platform}`);
    }

    // Success — update health columns
    await serviceClient
      .from("client_store_connections")
      .update({
        last_poll_at: now,
        connection_status: "active" as ConnectionStatus,
        last_error: null,
        last_error_at: null,
        updated_at: now,
      })
      .eq("id", connectionId);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    await serviceClient
      .from("client_store_connections")
      .update({
        last_error: message,
        last_error_at: now,
        updated_at: now,
      })
      .eq("id", connectionId);

    return { success: false, error: message };
  }
}

/**
 * Get SKU mappings for a connection.
 * Rule #44: includes last_pushed_quantity and last_pushed_at.
 */
export async function getSkuMappings(
  connectionId: string,
): Promise<Array<ClientStoreSkuMapping & { variant_sku: string; variant_title: string | null }>> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("client_store_sku_mappings")
    .select("*, warehouse_product_variants(sku, title)")
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch SKU mappings: ${error.message}`);

  return (data ?? []).map((m) => {
    const variant = m.warehouse_product_variants as unknown as {
      sku: string;
      title: string | null;
    } | null;
    return {
      ...m,
      variant_sku: variant?.sku ?? "",
      variant_title: variant?.title ?? null,
      warehouse_product_variants: undefined,
    } as ClientStoreSkuMapping & { variant_sku: string; variant_title: string | null };
  });
}

/**
 * Auto-discover remote SKUs and match to warehouse variants.
 * Creates client_store_sku_mappings for matches.
 *
 * CURRENT: exact-SKU-only matching.
 * PLAN (Phase 2): Multi-signal cascade (exact → barcode → fuzzy title).
 */
export async function autoDiscoverSkus(
  connectionId: string,
): Promise<{ matched: number; unmatched: number }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: connection, error: connError } = await serviceClient
    .from("client_store_connections")
    .select("*")
    .eq("id", connectionId)
    .single();

  if (connError || !connection) throw new Error("Connection not found");

  const conn = connection as ClientStoreConnection;

  // Fetch remote products/inventory to get SKUs
  let remoteSkus: Array<{
    sku: string;
    remoteProductId: string;
    remoteVariantId: string | null;
  }> = [];

  switch (conn.platform) {
    case "squarespace": {
      if (!conn.api_key) throw new Error("Missing API key");
      const { getInventory } = await import("@/lib/clients/squarespace-client"); 
      const inventory = await getInventory(conn.api_key, conn.store_url);
      remoteSkus = inventory
        .filter((i) => i.sku)
        .map((i) => ({
          sku: i.sku as string,
          remoteProductId: i.variantId,
          remoteVariantId: i.variantId,
        }));
      break;
    }
    case "woocommerce": {
      if (!conn.api_key || !conn.api_secret) throw new Error("Missing credentials");
      const credentials = {
        consumerKey: conn.api_key,
        consumerSecret: conn.api_secret,
        siteUrl: conn.store_url,
      };
      const res = await fetch(
        `${conn.store_url.replace(/\/$/, "")}/wp-json/wc/v3/products?per_page=100`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64")}`,
          },
        },
      );
      if (!res.ok) throw new Error(`WooCommerce fetch error: ${res.status}`);
      const products = (await res.json()) as Array<{ id: number; sku: string }>;
      remoteSkus = products
        .filter((p) => p.sku)
        .map((p) => ({
          sku: p.sku,
          remoteProductId: String(p.id),
          remoteVariantId: null,
        }));
      break;
    }
    case "shopify": {
      if (!conn.api_key) throw new Error("Missing API key");
      const shopifyUrl = conn.store_url.replace(/\/$/, "");
      const shopifyHeaders = { "X-Shopify-Access-Token": conn.api_key };

      let pageUrl: string | null =
        `${shopifyUrl}/admin/api/2026-01/products.json?limit=250&fields=id,variants`;
      while (pageUrl) {
        const res: Response = await fetch(pageUrl, { headers: shopifyHeaders });
        if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
        const { products } = (await res.json()) as {
          products: Array<{
            id: number;
            variants: Array<{ id: number; sku: string }>;
          }>;
        };

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

        const linkHeader: string | null = res.headers.get("Link");
        const nextMatch: RegExpMatchArray | null | undefined =
          linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
        pageUrl = nextMatch?.[1] ?? null;
      }
      break;
    }
    default:
      throw new Error(`Auto-discover not supported for platform: ${conn.platform}`);
  }

  if (remoteSkus.length === 0) {
    return { matched: 0, unmatched: 0 };
  }

  const { data: variants } = await serviceClient
    .from("warehouse_product_variants")
    .select("id, sku, warehouse_products!inner(org_id)")
    .in(
      "sku",
      remoteSkus.map((r) => r.sku),
    );

  const variantsBysku = new Map<string, string>();
  for (const v of variants ?? []) {
    const product = v.warehouse_products as unknown as { org_id: string };
    if (product?.org_id === conn.org_id) {
      variantsBysku.set(v.sku, v.id);
    }
  }

  let matched = 0;
  let unmatched = 0;

  for (const remote of remoteSkus) {
    const variantId = variantsBysku.get(remote.sku);
    if (variantId) {
      await serviceClient.from("client_store_sku_mappings").upsert(
        {
          workspace_id: conn.workspace_id,
          connection_id: connectionId,
          variant_id: variantId,
          remote_product_id: remote.remoteProductId,
          remote_variant_id: remote.remoteVariantId,
          remote_sku: remote.sku,
          is_active: true,
        },
        { onConflict: "connection_id,variant_id" },
      );
      matched++;
    } else {
      unmatched++;
    }
  }

  return { matched, unmatched };
}
```

**Silent bugs and gaps in this file**:
- Empty-SKU variants dropped silently (M8)
- WooCommerce variations missed entirely (H6)
- No barcode/fuzzy matching (plan Phase 2)
- `onConflict: "connection_id,variant_id"` requires unique constraint (M3 — added in new migration)
- Unmatched count surfaced but never shown to staff in UI

---

## 2. Portal Stores Actions

### File: `src/actions/portal-stores.ts` (110 lines)

Client-facing actions. Full file content:

```typescript
"use server";

import { z } from "zod/v4";
import { requireClient } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

/** Return store connections for the logged-in client's org. */
export async function getMyStoreConnections() {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("client_store_connections")
    .select(
      "id, platform, store_url, connection_status, last_poll_at, last_webhook_at, last_error, last_error_at, created_at",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch store connections: ${error.message}`);

  return {
    connections: data ?? [],
    orgId,
  };
}

const wooSchema = z.object({
  storeUrl: z.string().url(),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
});

export async function submitWooCommerceCredentials(rawData: {
  storeUrl: string;
  apiKey: string;
  apiSecret: string;
}): Promise<{ success: boolean; error?: string }> {
  const { orgId } = await requireClient();
  const data = wooSchema.parse(rawData);

  const appUrl = env().NEXT_PUBLIC_APP_URL;

  const res = await fetch(`${appUrl}/api/oauth/woocommerce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      org_id: orgId,
      store_url: data.storeUrl,
      api_key: data.apiKey,
      api_secret: data.apiSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    return { success: false, error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
  }

  return { success: true };
}

export async function getWooCommerceAuthUrl(storeUrl: string): Promise<{ url: string }> {
  const { orgId } = await requireClient();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  const baseStore = storeUrl.replace(/\/$/, "");

  const callbackUrl = `${appUrl}/api/oauth/woocommerce/callback?org_id=${encodeURIComponent(orgId)}&store_url=${encodeURIComponent(baseStore)}`;
  const returnUrl = `${appUrl}/portal/stores?connected=woocommerce`;

  const wcAuthParams = new URLSearchParams({
    app_name: "Clandestine Fulfillment",
    scope: "read_write",
    user_id: orgId,
    return_url: returnUrl,
    callback_url: callbackUrl,
  });

  const wcAuthUrl = `${baseStore}/wc-auth/v1/authorize?${wcAuthParams}`;
  const loginUrl = `${baseStore}/wp-login.php?redirect_to=${encodeURIComponent(wcAuthUrl)}`;

  return { url: loginUrl };
}

export async function deleteStoreConnection(connectionId: string): Promise<{ success: boolean }> {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { error } = await supabase
    .from("client_store_connections")
    .delete()
    .eq("id", connectionId)
    .eq("org_id", orgId);

  if (error) throw new Error(`Failed to delete connection: ${error.message}`);
  return { success: true };
}
```

---

## 3. Client Store Credentials

### File: `src/actions/client-store-credentials.ts` (85 lines)

Rule #19 compliant — service-role write after org_id validation.

```typescript
"use server";

import { z } from "zod";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

const credentialsSchema = z
  .object({
    apiKey: z.string().min(1, "API key is required"),
    apiSecret: z.string().optional(),
  })
  .strict();

/**
 * Rule #19: Client credential submission uses service_role.
 * Validates the authenticated user's org_id matches the target connection,
 * then writes credentials via service_role client (bypassing staff-only RLS).
 */
export async function submitClientStoreCredentials(
  connectionId: string,
  credentials: { apiKey: string; apiSecret?: string },
) {
  if (!connectionId) {
    throw new Error("Connection ID is required");
  }

  const parsed = credentialsSchema.parse(credentials);

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();

  const { data: connection } = await serviceClient
    .from("client_store_connections")
    .select("org_id")
    .eq("id", connectionId)
    .single();

  if (!connection) throw new Error("Connection not found");

  const { data: userRecord } = await serviceClient
    .from("users")
    .select("org_id")
    .eq("auth_user_id", user.id)
    .single();

  if (!userRecord) throw new Error("User record not found");

  if (userRecord.org_id !== connection.org_id) {
    throw new Error("You do not have permission to modify this connection");
  }

  const updateData: Record<string, string> = {
    api_key: parsed.apiKey,
  };

  if (parsed.apiSecret) {
    updateData.api_secret = parsed.apiSecret;
  }

  const { error } = await serviceClient
    .from("client_store_connections")
    .update(updateData)
    .eq("id", connectionId);

  if (error) {
    throw new Error(`Failed to update credentials: ${error.message}`);
  }

  return { success: true };
}
```

---

## 4. Portal Stores Page

### File: `src/app/portal/stores/page.tsx` (434 lines)

Client-facing UI. Adds post-connection progress + freshness card in Phase 7. The full file is preserved in the repo; key Shopify section (lines 325-345):

```tsx
function ShopifyOAuthFlow({ orgId }: { orgId: string }) {
  const [shopDomain, setShopDomain] = useState("");

  const handleConnect = () => {
    if (!shopDomain) return;
    const shop = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    window.open(
      `/api/oauth/shopify?shop=${encodeURIComponent(shop)}&org_id=${encodeURIComponent(orgId)}`,
      "_blank",
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="shop-domain" className="text-sm font-medium block mb-1">
          Your Shopify domain
        </label>
        <Input
          id="shop-domain"
          placeholder="yourstore.myshopify.com"
          value={shopDomain}
          onChange={(e) => setShopDomain(e.target.value)}
          className="font-mono"
        />
      </div>
      <Button onClick={handleConnect} disabled={!shopDomain.trim()} className="w-full">
        Connect with Shopify →
      </Button>
    </div>
  );
}
```

**Plan additions in Phase 7**:
- Poll `/api/portal/stores/connection-progress?id=X` after `?connected=shopify` redirect
- Show stepped progress: "Registering webhooks" → "Discovering products" → "X of Y matched, Z need review"
- Per-connection card: freshness badge (fresh/delayed/stale), last sync, any pending issues

---

## 5. Admin Store Connections Page

### File: `src/app/admin/settings/store-connections/page.tsx` (371 lines)

Staff-facing UI. Table of connections with filters, test/disable buttons, add dialog.

**Plan additions in Phase 5**:
- "Pending Mappings (N)" subview per connection showing fuzzy-matched SKUs awaiting staff approval
- Side-by-side compare: warehouse product vs remote product with approve/reject/manual-map buttons
- Drift alerts from the new reconcile task
- Per-connection freshness badges
- Re-sync button that triggers `auto-discover-skus`

(Full current file preserved in repo; new mapping review subview is in [05 New Code](05-new-code-skeletons.md).)

---

## 6. Inventory Fanout

### File: `src/lib/server/inventory-fanout.ts` (149 lines)

Orchestrates inventory change propagation to warehouse Shopify + Bandcamp + client stores.

```typescript
/**
 * Inventory fanout — Rule #43 step (4).
 *
 * Called after recordInventoryChange succeeds.
 * Pushes inventory changes to all downstream systems:
 * - Clandestine Shopify (direct API, not client_store_connections)
 * - Bandcamp (via bandcamp-inventory-push task)
 * - Client stores (via multi-store-inventory-push task)
 */

import { tasks } from "@trigger.dev/sdk";
import { inventoryAdjustQuantities } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const SHOPIFY_LOCATION_ID = "gid://shopify/Location/104066613563";

export interface FanoutResult {
  storeConnectionsPushed: number;
  bandcampPushed: boolean;
  shopifyPushed: boolean;
}

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
  delta?: number,
  correlationId?: string,
): Promise<FanoutResult> {
  const supabase = createServiceRoleClient();

  const { data: ws } = await supabase
    .from("workspaces")
    .select("inventory_sync_paused")
    .eq("id", workspaceId)
    .single();

  if (ws?.inventory_sync_paused) {
    return { storeConnectionsPushed: 0, bandcampPushed: false, shopifyPushed: false };
  }

  let storeConnectionsPushed = 0;
  let bandcampPushed = false;
  let shopifyPushed = false;

  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id, shopify_inventory_item_id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .single();

  if (variant?.shopify_inventory_item_id && delta != null && delta !== 0) {
    try {
      await inventoryAdjustQuantities(
        variant.shopify_inventory_item_id,
        SHOPIFY_LOCATION_ID,
        delta,
        correlationId ?? `fanout:${sku}:${Date.now()}`,
      );
      shopifyPushed = true;
    } catch (err) {
      console.error(
        `[fanout] Shopify push failed for SKU=${sku}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const { data: skuMappings } = await supabase
    .from("client_store_sku_mappings")
    .select("connection_id")
    .eq("is_active", true)
    .eq("remote_sku", sku);

  const { data: bandcampMappings } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, variant_id")
    .eq("workspace_id", workspaceId);

  const hasBandcampMapping =
    variant &&
    (bandcampMappings ?? []).some((m) => (m as Record<string, unknown>).variant_id === variant.id);

  const targets = determineFanoutTargets((skuMappings ?? []).length > 0, !!hasBandcampMapping);

  if (targets.pushToStores) {
    try {
      await tasks.trigger("multi-store-inventory-push", {});
      storeConnectionsPushed = (skuMappings ?? []).length;
    } catch {
      /* non-critical */
    }
  }

  if (targets.pushToBandcamp) {
    try {
      await tasks.trigger("bandcamp-inventory-push", {});
      bandcampPushed = true;
    } catch {
      /* non-critical */
    }
  }

  if (variant) {
    const { data: parentBundles } = await supabase
      .from("bundle_components")
      .select("bundle_variant_id")
      .eq("workspace_id", workspaceId)
      .eq("component_variant_id", variant.id)
      .limit(1);

    if (parentBundles?.length) {
      if (!targets.pushToBandcamp) {
        try {
          await tasks.trigger("bandcamp-inventory-push", {});
        } catch {
          /* */
        }
      }
      if (!targets.pushToStores) {
        try {
          await tasks.trigger("multi-store-inventory-push", {});
        } catch {
          /* */
        }
      }
    }
  }

  return { storeConnectionsPushed, bandcampPushed, shopifyPushed };
}
```

**Plan modifications**: Filter `client_store_sku_mappings` by `match_status = 'confirmed'` (Phase 2.5) so pending/rejected mappings don't trigger pushes.

---

## 7. Store Sync Client

### File: `src/lib/clients/store-sync-client.ts` (278 lines)

REST client for merchant stores. Dispatches to platform-specific implementations.

**Plan modifications (Phase 0.5, 3.1, 3.3)**:
- **C5 fix**: Replace `inventory_levels[0]` with stored `primary_location_id` (from connection metadata)
- **H1**: Wrap every fetch in rate limiter with 429 retry
- **H2**: Replace `console.warn` + skip with typed errors (`SkuNotFoundError`, `NoInventoryLevelError`) that bubble up for review queue

```typescript
import type { ClientStoreConnection } from "@/lib/shared/types";

export interface StoreSyncClient {
  pushInventory(sku: string, quantity: number, idempotencyKey: string): Promise<void>;
  getRemoteQuantity(sku: string): Promise<number | null>;
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
      `${baseUrl}/admin/api/2026-01/variants.json?sku=${encodeURIComponent(sku)}`,
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
      `${baseUrl}/admin/api/2026-01/inventory_levels.json?inventory_item_ids=${inventoryItemId}`,
      { headers },
    );
    if (!res.ok) throw new Error(`Shopify inventory levels fetch failed: HTTP ${res.status}`);
    const { inventory_levels } = (await res.json()) as {
      inventory_levels: Array<{ location_id: number; available: number }>;
    };
    const level = inventory_levels[0];  // BUG C5: picks arbitrary first location
    if (!level) return null;
    return { locationId: level.location_id, available: level.available };
  }

  return {
    async pushInventory(sku, quantity, _idempotencyKey) {
      const variant = await findVariantBySku(sku);
      if (!variant) {
        console.warn(`[ShopifySync] SKU ${sku} not found in client store — skipping push`);
        return;  // BUG H2: silent skip
      }

      const level = await getLocationAndQuantity(variant.inventoryItemId);
      if (!level) {
        console.warn(`[ShopifySync] No inventory level for SKU ${sku} — skipping push`);
        return;  // BUG H2: silent skip
      }

      const res = await fetch(`${baseUrl}/admin/api/2026-01/inventory_levels/set.json`, {
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
        `${baseUrl}/admin/api/2026-01/orders.json?created_at_min=${encodeURIComponent(since)}&status=any&limit=50`,
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

// Squarespace + WooCommerce implementations follow same pattern (278 lines total).
// See repo for full content.
```

**Silent bugs in this file**:
- Line 90: `inventory_levels[0]` multi-location bug (C5)
- Lines 99, 105: `console.warn` + `return` silent skip (H2)
- No rate limiting anywhere (H1)

---

**Next**: [04 Bandcamp Chain](04-bandcamp-shopify-chain.md) for `bandcamp-inventory-push`, `bandcamp-sale-poll`, `record-inventory-change`.
