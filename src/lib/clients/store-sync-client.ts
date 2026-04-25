import { shouldFanoutToConnection } from "@/lib/server/client-store-fanout-gate";
import { SHOPIFY_CLIENT_API_VERSION } from "@/lib/shared/constants";
import type { ClientStoreConnection } from "@/lib/shared/types";

// Unified store sync interface — dispatches to platform-specific clients.
// Rule #44: WooCommerce uses absolute quantities via updateStockQuantity.
// Rule #15: Idempotency keys must be stable per logical adjustment.
//
// Phase 0.8 — last-line dormancy defense. Callers SHOULD consult
// `shouldFanoutToConnection()` from src/lib/server/client-store-fanout-gate.ts
// BEFORE calling createStoreSyncClient(). The constructor enforces it again
// to catch any new caller that forgets — a dormant connection can never be
// wrapped in a sync client. See plan §12.4 (single dormancy gate).

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

export class DormantConnectionError extends Error {
  constructor(connection: ClientStoreConnection, reason: string | undefined) {
    super(
      `[fanout-gate] Refusing to wrap dormant ${connection.platform} connection ${connection.id} (reason=${reason ?? "unknown"})`,
    );
    this.name = "DormantConnectionError";
  }
}

export function createStoreSyncClient(
  connection: ClientStoreConnection,
  skuMappings?: Map<string, SkuMappingContext>,
): StoreSyncClient {
  // Phase 0.8 last-line defense. Callers should pre-check, but this throws
  // loudly so a forgotten gate becomes a CI failure (test asserts throw),
  // not a silent push to a dormant store.
  const decision = shouldFanoutToConnection(connection);
  if (!decision.allow) throw new DormantConnectionError(connection, decision.reason);

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

/**
 * Extract the numeric Shopify location ID from either a GID
 * ("gid://shopify/Location/123456") or a bare numeric string ("123456").
 * Returns null if the input is not parseable.
 */
export function extractNumericShopifyLocationId(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/(\d+)\s*$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * HRD-26 — detect Shopify "inventory item is not stocked at this location"
 * errors. These come back as HTTP 422 with a body that mentions the inventory
 * item is not stocked / not connected at the target location. The exact
 * wording has shifted across API versions; match defensively against the
 * stable substrings.
 */
export function isInventoryNotActiveAtLocationError(httpStatus: number, body: string): boolean {
  if (httpStatus !== 422) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("not stocked at") ||
    lower.includes("inventory item is not stocked") ||
    lower.includes("inventory item does not have inventory tracked") ||
    lower.includes("inventory_item not connected") ||
    lower.includes("location not active") ||
    lower.includes("not active at this location")
  );
}

export async function activateShopifyInventoryAtLocation(input: {
  connection: ClientStoreConnection;
  inventoryItemId: number;
  locationId: number;
  sku?: string | null;
}): Promise<void> {
  if (!input.connection.api_key) throw new Error("Shopify connection missing api_key");
  const baseUrl = input.connection.store_url.replace(/\/$/, "");
  const res = await fetch(
    `${baseUrl}/admin/api/${SHOPIFY_CLIENT_API_VERSION}/inventory_levels/connect.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": input.connection.api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location_id: input.locationId,
        inventory_item_id: input.inventoryItemId,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Shopify inventoryActivate (REST connect) failed: HTTP ${res.status} — ${body}`,
    );
  }

  if (input.sku) {
    try {
      const { createServiceRoleClient } = await import("@/lib/server/supabase-server");
      const supabase = createServiceRoleClient();
      const correlationId = `inv-activate:${input.connection.id}:${input.locationId}:${input.inventoryItemId}:${Date.now()}`;
      await supabase.from("warehouse_inventory_activity").insert({
        workspace_id: input.connection.workspace_id,
        sku: input.sku,
        delta: 0,
        source: "inventory_activate",
        correlation_id: correlationId,
        metadata: {
          connection_id: input.connection.id,
          platform: input.connection.platform,
          shopify_inventory_item_id: String(input.inventoryItemId),
          shopify_location_id: String(input.locationId),
          activated_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.warn(
        `[ShopifySync] inventory_activate audit row insert failed (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
    }
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
      `${baseUrl}/admin/api/${SHOPIFY_CLIENT_API_VERSION}/variants.json?sku=${encodeURIComponent(sku)}`,
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
      `${baseUrl}/admin/api/${SHOPIFY_CLIENT_API_VERSION}/inventory_levels.json?inventory_item_ids=${inventoryItemId}`,
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

      // HRD-26: prefer the staff-selected default_location_id (HRD-05). Fall
      // back to whichever location the item is currently activated at — this
      // preserves pre-cutover behavior for connections that haven't picked a
      // default yet.
      let targetLocationId: number | null = extractNumericShopifyLocationId(
        connection.default_location_id,
      );
      if (targetLocationId == null) {
        const level = await getLocationAndQuantity(variant.inventoryItemId);
        if (!level) {
          console.warn(`[ShopifySync] No inventory level for SKU ${sku} — skipping push`);
          return;
        }
        targetLocationId = level.locationId;
      }

      const inventoryItemId = variant.inventoryItemId;
      async function attemptSet(): Promise<
        { ok: true } | { ok: false; status: number; body: string }
      > {
        const res = await fetch(
          `${baseUrl}/admin/api/${SHOPIFY_CLIENT_API_VERSION}/inventory_levels/set.json`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              location_id: targetLocationId,
              inventory_item_id: inventoryItemId,
              available: quantity,
            }),
          },
        );
        if (res.ok) return { ok: true };
        const body = await res.text();
        return { ok: false, status: res.status, body };
      }

      const first = await attemptSet();
      if (first.ok) return;

      // HRD-26: if Shopify rejected because the item isn't stocked at the
      // target location, lazily connect+retry once. This is the common case
      // when a merchant adds a new location after initial discovery (or when
      // the staff-selected default_location_id differs from the location the
      // item was originally created at).
      if (isInventoryNotActiveAtLocationError(first.status, first.body)) {
        try {
          await activateShopifyInventoryAtLocation({
            connection,
            inventoryItemId: variant.inventoryItemId,
            locationId: targetLocationId,
            sku,
          });
        } catch (activateErr) {
          throw new Error(
            `Shopify inventory set failed (location not active) and inventoryActivate also failed: HTTP ${first.status} — ${first.body}; activateErr=${activateErr instanceof Error ? activateErr.message : String(activateErr)}`,
          );
        }
        const retry = await attemptSet();
        if (retry.ok) return;
        throw new Error(
          `Shopify inventory set retry-after-activate failed: HTTP ${retry.status} — ${retry.body}`,
        );
      }

      throw new Error(`Shopify inventory set failed: HTTP ${first.status} — ${first.body}`);
    },

    async getRemoteQuantity(sku) {
      const variant = await findVariantBySku(sku);
      if (!variant) return null;

      const level = await getLocationAndQuantity(variant.inventoryItemId);
      return level?.available ?? null;
    },

    async getOrders(since) {
      const res = await fetch(
        `${baseUrl}/admin/api/${SHOPIFY_CLIENT_API_VERSION}/orders.json?created_at_min=${encodeURIComponent(since)}&status=any&limit=50`,
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
      let variationId: number | null = null;

      if (mapping?.remoteProductId && mapping.remoteVariantId) {
        productId = Number(mapping.remoteProductId);
        variationId = Number(mapping.remoteVariantId);
      } else if (mapping?.remoteProductId) {
        productId = Number(mapping.remoteProductId);
      } else {
        const product = await getProductBySku(credentials, sku);
        if (!product) throw new Error(`SKU ${sku} not found in WooCommerce`);
        productId = product.productId;
        variationId = product.variationId;
      }

      // Rule #44: absolute quantity, not delta
      await updateStockQuantity(credentials, productId, quantity, variationId);
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
