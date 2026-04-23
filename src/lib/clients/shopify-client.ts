/**
 * Shopify Admin API GraphQL client.
 *
 * Rules enforced:
 * - Rule #1: NEVER use productSet for EDITS. productSet deletes list-field entries
 *   not in payload. Use productUpdate + productVariantsBulkUpdate for edits.
 *   productSet is for CREATE only with complete payloads.
 * - Rule #8: One Shopify product per SKU.
 * - Rule #15: Idempotency keys must be stable per logical adjustment.
 *   Use {task_run_id}:{sku}, NOT random UUID.
 */

import { env } from "@/lib/shared/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  status: string;
  tags: string[];
  updatedAt: string;
  variants: { edges: Array<{ node: ShopifyVariant }> };
  images: { edges: Array<{ node: ShopifyImage }> };
}

export interface ShopifyVariant {
  id: string;
  sku: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  barcode: string | null;
  inventoryItem: {
    id: string;
    measurement?: {
      weight?: { value: number; unit: string } | null;
    } | null;
  } | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface ShopifyImage {
  id: string;
  url: string;
  altText: string | null;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  email: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  tags: string[];
  lineItems: { edges: Array<{ node: ShopifyLineItem }> };
  shippingAddress: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShopifyLineItem {
  id: string;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: number;
  originalUnitPriceSet: { shopMoney: { amount: string } };
}

export interface ShopifyPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code: string } }>;
  extensions?: { cost: { throttleStatus: { currentlyAvailable: number; restoreRate: number } } };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const THROTTLE_WAIT_MS = 2000;

function getConfig() {
  const { SHOPIFY_STORE_URL, SHOPIFY_ADMIN_API_TOKEN, SHOPIFY_API_VERSION } = env();
  return {
    endpoint: `${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    token: SHOPIFY_ADMIN_API_TOKEN,
  };
}

export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { endpoint, token } = getConfig();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429 || res.status === 503) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter
        ? Number.parseInt(retryAfter, 10) * 1000
        : THROTTLE_WAIT_MS * (attempt + 1);
      await sleep(waitMs);
      continue;
    }

    const json = (await res.json()) as GraphQLResponse<T>;

    if (json.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
      await sleep(THROTTLE_WAIT_MS * (attempt + 1));
      continue;
    }

    if (json.errors?.length) {
      lastError = new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }

    if (!json.data) {
      throw new Error("Shopify GraphQL: empty response data");
    }

    return json.data;
  }

  throw lastError ?? new Error("Shopify GraphQL: max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Stable idempotency key (Rule #15)
// ---------------------------------------------------------------------------

export function makeIdempotencyKey(taskRunId: string, sku: string): string {
  return `${taskRunId}:${sku}`;
}

// ---------------------------------------------------------------------------
// Product queries
// ---------------------------------------------------------------------------

const PRODUCTS_QUERY = `
  query FetchProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        node {
          id title handle vendor productType status tags updatedAt
          variants(first: 100) {
            edges {
              node {
                id sku title price compareAtPrice barcode
                inventoryItem {
                  id
                  measurement { weight { value unit } }
                }
                selectedOptions { name value }
              }
            }
          }
          images(first: 20) {
            edges { node { id url altText } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function fetchProducts(options: {
  first?: number;
  after?: string | null;
  updatedAtMin?: string | null;
}): Promise<{
  products: ShopifyProduct[];
  pageInfo: ShopifyPageInfo;
}> {
  const queryFilter = options.updatedAtMin ? `updated_at:>='${options.updatedAtMin}'` : undefined;

  const data = await shopifyGraphQL<{
    products: {
      edges: Array<{ node: ShopifyProduct }>;
      pageInfo: ShopifyPageInfo;
    };
  }>(PRODUCTS_QUERY, {
    first: options.first ?? 50,
    after: options.after ?? null,
    query: queryFilter,
  });

  return {
    products: data.products.edges.map((e) => e.node),
    pageInfo: data.products.pageInfo,
  };
}

// ---------------------------------------------------------------------------
// Inventory queries
// ---------------------------------------------------------------------------

const INVENTORY_LEVELS_QUERY = `
  query FetchInventoryLevels($inventoryItemIds: [ID!]!) {
    nodes(ids: $inventoryItemIds) {
      ... on InventoryItem {
        id
        inventoryLevels(first: 10) {
          edges {
            node {
              id
              quantities(names: ["available", "committed", "incoming"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

export async function fetchInventoryLevels(inventoryItemIds: string[]): Promise<
  Array<{
    inventoryItemId: string;
    available: number;
    committed: number;
    incoming: number;
  }>
> {
  if (inventoryItemIds.length === 0) return [];

  const data = await shopifyGraphQL<{
    nodes: Array<{
      id: string;
      inventoryLevels: {
        edges: Array<{
          node: {
            quantities: Array<{ name: string; quantity: number }>;
          };
        }>;
      };
    } | null>;
  }>(INVENTORY_LEVELS_QUERY, { inventoryItemIds });

  return data.nodes
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .map((node) => {
      const levels = node.inventoryLevels.edges[0]?.node.quantities ?? [];
      const find = (name: string) => levels.find((q) => q.name === name)?.quantity ?? 0;
      return {
        inventoryItemId: node.id,
        available: find("available"),
        committed: find("committed"),
        incoming: find("incoming"),
      };
    });
}

// ---------------------------------------------------------------------------
// Order queries
// ---------------------------------------------------------------------------

const ORDERS_QUERY = `
  query FetchOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      edges {
        node {
          id name email displayFinancialStatus displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          tags createdAt updatedAt
          lineItems(first: 50) {
            edges {
              node {
                id sku title variantTitle quantity
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
          shippingAddress {
            address1 address2 city province country zip
            firstName lastName company phone
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function fetchOrders(options: {
  first?: number;
  after?: string | null;
  updatedAtMin?: string | null;
}): Promise<{
  orders: ShopifyOrder[];
  pageInfo: ShopifyPageInfo;
}> {
  const query = options.updatedAtMin ? `updated_at:>='${options.updatedAtMin}'` : undefined;

  const data = await shopifyGraphQL<{
    orders: {
      edges: Array<{ node: ShopifyOrder }>;
      pageInfo: ShopifyPageInfo;
    };
  }>(ORDERS_QUERY, {
    first: options.first ?? 50,
    after: options.after ?? null,
    query,
  });

  return {
    orders: data.orders.edges.map((e) => e.node),
    pageInfo: data.orders.pageInfo,
  };
}

// ---------------------------------------------------------------------------
// Mutations — CREATE via productSet (Rule #1, #13)
// ---------------------------------------------------------------------------

/**
 * NEVER use productSet for EDITS — it deletes list-field entries not in payload.
 * productSet is for CREATE only with complete payloads.
 *
 * Rule #13: productSet requires a "full-shape builder." Never let individual callers
 * assemble productSet payloads. Use this single function that emits COMPLETE list
 * for every list field. Forgetting a list field = silent data deletion.
 */
export async function productSetCreate(input: Record<string, unknown>): Promise<string> {
  const mutation = `
    mutation ProductSet($input: ProductSetInput!) {
      productSet(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    productSet: {
      product: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input });

  if (data.productSet.userErrors.length > 0) {
    throw new Error(
      `productSet errors: ${data.productSet.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  if (!data.productSet.product) {
    throw new Error("productSet returned no product");
  }
  return data.productSet.product.id;
}

/**
 * Fetch the variants of a Shopify product (id, sku, inventoryItem.id).
 * Used after `productSetCreate` to back-fill `shopify_variant_id` and
 * `shopify_inventory_item_id` on every warehouse_product_variants row when
 * creating multi-variant (apparel) products.
 *
 * Read-only — safe to call from any context.
 */
export async function fetchProductVariantsByProductId(
  productId: string,
): Promise<Array<{ id: string; sku: string | null; inventoryItemId: string | null }>> {
  const query = `
    query V($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          nodes {
            id
            sku
            inventoryItem { id }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    product: {
      variants: {
        nodes: Array<{ id: string; sku: string | null; inventoryItem: { id: string } | null }>;
      };
    } | null;
  }>(query, { id: productId });

  const nodes = data?.product?.variants?.nodes ?? [];
  return nodes.map((n) => ({
    id: n.id,
    sku: n.sku ?? null,
    inventoryItemId: n.inventoryItem?.id ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Mutations — EDIT via productUpdate + productVariantsBulkUpdate (Rule #1)
// ---------------------------------------------------------------------------

/**
 * Normalise a Shopify product ID to GID format.
 * Accepts either numeric ("123") or full GID ("gid://shopify/Product/123").
 */
function toProductGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

/**
 * Add media (images) to an existing Shopify product.
 * Use this instead of productUpdate+images — that field was removed in 2024-01.
 *
 * API version: 2026-04+ (env-singleton path uses `SHOPIFY_API_VERSION` from env)
 * Mutation: productCreateMedia
 */
export async function productCreateMedia(
  shopifyProductId: string,
  media: Array<{ originalSource: string; alt?: string | null; mediaContentType?: "IMAGE" }>,
): Promise<void> {
  if (media.length === 0) return;

  const mutation = `
    mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id status }
        mediaUserErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    productCreateMedia: {
      media: Array<{ id: string; status: string }>;
      mediaUserErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, {
    productId: toProductGid(shopifyProductId),
    media: media.map((m) => ({
      originalSource: m.originalSource,
      alt: m.alt ?? "",
      mediaContentType: m.mediaContentType ?? "IMAGE",
    })),
  });

  if (data.productCreateMedia.mediaUserErrors.length > 0) {
    throw new Error(
      `productCreateMedia errors: ${data.productCreateMedia.mediaUserErrors.map((e) => e.message).join(", ")}`,
    );
  }
}

export async function productUpdate(input: Record<string, unknown>): Promise<{ id: string }> {
  const mutation = `
    mutation ProductUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    productUpdate: {
      product: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input });

  if (data.productUpdate.userErrors.length > 0) {
    throw new Error(
      `productUpdate errors: ${data.productUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  return { id: data.productUpdate.product?.id ?? "" };
}

/**
 * Archive an existing product safely.
 * Keeps recoverability in Shopify while removing it from active catalogs.
 */
export async function productArchive(productId: string): Promise<void> {
  await productUpdate({
    id: toProductGid(productId),
    status: "ARCHIVED",
  });
}

/**
 * Hard-delete a Shopify product. IRREVERSIBLE — removes the product, its
 * variants, and inventory rows from Shopify entirely. Caller MUST verify a
 * non-archived twin exists first (or is otherwise certain the product is
 * disposable). Used by `scripts/dedupe-archived-shopify-twins.ts`.
 */
export async function productDelete(productId: string): Promise<void> {
  const mutation = `
    mutation ProductDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    productDelete: {
      deletedProductId: string | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input: { id: toProductGid(productId) } });

  if (data.productDelete.userErrors.length > 0) {
    throw new Error(
      `productDelete errors: ${data.productDelete.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
}

export async function productVariantsBulkUpdate(
  productId: string,
  variants: Array<Record<string, unknown>>,
): Promise<void> {
  const mutation = `
    mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    productVariantsBulkUpdate: {
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { productId, variants });

  if (data.productVariantsBulkUpdate.userErrors.length > 0) {
    throw new Error(
      `productVariantsBulkUpdate errors: ${data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Mutations — Inventory
// ---------------------------------------------------------------------------

export async function inventoryAdjustQuantities(
  inventoryItemId: string,
  locationId: string,
  delta: number,
  idempotencyKey: string,
): Promise<void> {
  const mutation = `
    mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    input: {
      reason: "correction",
      name: "available",
      changes: [
        {
          inventoryItemId,
          locationId,
          delta,
          ledgerDocumentUri: `clandestine://adjustment/${idempotencyKey}`,
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations — Publishing
// ---------------------------------------------------------------------------

export async function publishablePublish(
  resourceId: string,
  publicationIds: string[],
): Promise<void> {
  const mutation = `
    mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    id: resourceId,
    input: publicationIds.map((id) => ({ publicationId: id })),
  });
}

// ---------------------------------------------------------------------------
// Mutations — Tags
// ---------------------------------------------------------------------------

export async function tagsAdd(resourceId: string, tags: string[]): Promise<void> {
  const mutation = `
    mutation TagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id: resourceId, tags });
}

export async function tagsRemove(resourceId: string, tags: string[]): Promise<void> {
  const mutation = `
    mutation TagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id: resourceId, tags });
}

// ---------------------------------------------------------------------------
// Mutations — Selling Plans (Pre-orders)
// ---------------------------------------------------------------------------

export async function sellingPlanGroupCreate(input: Record<string, unknown>): Promise<string> {
  const mutation = `
    mutation SellingPlanGroupCreate($input: SellingPlanGroupInput!) {
      sellingPlanGroupCreate(input: $input) {
        sellingPlanGroup { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    sellingPlanGroupCreate: {
      sellingPlanGroup: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input });

  if (data.sellingPlanGroupCreate.userErrors.length > 0) {
    throw new Error(
      `sellingPlanGroupCreate errors: ${data.sellingPlanGroupCreate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  return data.sellingPlanGroupCreate.sellingPlanGroup?.id ?? "";
}

export async function sellingPlanGroupDelete(id: string): Promise<void> {
  const mutation = `
    mutation SellingPlanGroupDelete($id: ID!) {
      sellingPlanGroupDelete(id: $id) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id });
}

// ---------------------------------------------------------------------------
// Inventory Item Update (tracked, cost)
// ---------------------------------------------------------------------------

export async function inventoryItemUpdate(
  inventoryItemId: string,
  input: {
    tracked?: boolean;
    cost?: number;
    measurement?: { weight: { value: number; unit: string } };
  },
): Promise<void> {
  const mutation = `
    mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id tracked unitCost { amount } measurement { weight { value unit } } }
        userErrors { message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    inventoryItemUpdate: {
      inventoryItem: { id: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(mutation, {
    id: inventoryItemId,
    input: {
      ...(input.tracked != null ? { tracked: input.tracked } : {}),
      ...(input.cost != null ? { cost: input.cost } : {}),
      ...(input.measurement ? { measurement: input.measurement } : {}),
    },
  });

  if (data.inventoryItemUpdate.userErrors.length > 0) {
    throw new Error(
      `inventoryItemUpdate errors: ${data.inventoryItemUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export async function collectionCreate(title: string): Promise<string> {
  const mutation = `
    mutation CollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id title }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    collectionCreate: {
      collection: { id: string; title: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input: { title } });

  if (data.collectionCreate.userErrors.length > 0) {
    throw new Error(
      `collectionCreate errors: ${data.collectionCreate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  if (!data.collectionCreate.collection) {
    throw new Error("collectionCreate returned no collection");
  }
  return data.collectionCreate.collection.id;
}

export async function collectionAddProducts(
  collectionId: string,
  productIds: string[],
): Promise<void> {
  if (productIds.length === 0) return;
  const mutation = `
    mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    collectionAddProducts: {
      collection: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { id: collectionId, productIds });

  const realErrors = (data.collectionAddProducts.userErrors ?? []).filter(
    (e) => !e.message.includes("already"),
  );
  if (realErrors.length > 0) {
    throw new Error(`collectionAddProducts errors: ${realErrors.map((e) => e.message).join(", ")}`);
  }
}

const collectionCache = new Map<string, string>();

export async function findOrCreateCollection(vendorName: string): Promise<string> {
  if (collectionCache.has(vendorName)) return collectionCache.get(vendorName)!;

  const escaped = vendorName.replace(/'/g, "\\\\'");
  const data = await shopifyGraphQL<{
    collections: { edges: Array<{ node: { id: string; title: string } }> };
  }>(`{ collections(first: 10, query: "title:'${escaped}'") { edges { node { id title } } } }`);

  const exactMatch = data.collections.edges.find(
    (e) => e.node.title.toLowerCase() === vendorName.toLowerCase(),
  );
  if (exactMatch) {
    collectionCache.set(vendorName, exactMatch.node.id);
    return exactMatch.node.id;
  }

  const stripped = vendorName.replace(/\s+(Records|Music|Label|Tapes|Sound)$/i, "");
  if (stripped !== vendorName) {
    const fuzzyMatch = data.collections.edges.find(
      (e) => e.node.title.toLowerCase() === stripped.toLowerCase(),
    );
    if (fuzzyMatch) {
      collectionCache.set(vendorName, fuzzyMatch.node.id);
      return fuzzyMatch.node.id;
    }
  }

  const newId = await collectionCreate(vendorName);
  collectionCache.set(vendorName, newId);
  return newId;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

const SAFE_CHANNEL_NAMES = ["Online Store", "Shop"];
let cachedPublications: Array<{ id: string; name: string }> | null = null;

export async function getPublicationIds(): Promise<Array<{ id: string; name: string }>> {
  if (cachedPublications) return cachedPublications;
  const data = await shopifyGraphQL<{
    publications: { edges: Array<{ node: { id: string; name: string } }> };
  }>("{ publications(first: 20) { edges { node { id name } } } }");
  cachedPublications = data.publications.edges.map((e) => ({
    id: e.node.id,
    name: e.node.name,
  }));
  return cachedPublications;
}

export async function publishToSafeChannels(shopifyProductId: string): Promise<void> {
  const allPubs = await getPublicationIds();
  const safePubs = allPubs.filter((p) => SAFE_CHANNEL_NAMES.includes(p.name));
  if (safePubs.length === 0) return;

  const mutation = `
    mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id } }
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    id: toProductGid(shopifyProductId),
    input: safePubs.map((p) => ({ publicationId: p.id })),
  });
}
