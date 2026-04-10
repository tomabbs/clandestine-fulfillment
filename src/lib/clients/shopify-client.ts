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
 * API version: 2026-01+
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
