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

function createShopifySync(_connection: ClientStoreConnection): StoreSyncClient {
  return {
    async pushInventory(_sku, _quantity, _idempotencyKey) {
      // Shopify inventory is managed via the main shopify.ts client (GraphQL).
      // This path is used for client-owned Shopify stores (not the warehouse Shopify).
      // For now, delegate to the inventory_level/set REST endpoint.
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
