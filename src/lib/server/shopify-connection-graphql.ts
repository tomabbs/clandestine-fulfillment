/**
 * Per-connection Shopify Admin GraphQL client.
 *
 * Mirrors the env-singleton helper in `src/lib/clients/shopify-client.ts` but
 * takes (storeUrl, token) as explicit args so HRD-35 client-store connections
 * can call Shopify with their own per-connection access token. Never reads
 * env-singleton state — DO NOT collapse this back into the main shopify-client
 * file or the per-connection token will silently leak the env-singleton's
 * scopes/store URL.
 *
 * Throttle handling matches the env helper (max 3 retries, exponential, honors
 * the Retry-After header from 429/503). GraphQL `THROTTLED` errors are also
 * retried.
 *
 * Read-only-safe: this module exposes the raw GraphQL transport plus a few
 * read-only convenience helpers. Mutations (e.g. webhookSubscriptionCreate)
 * live with their callers and consume `connectionShopifyGraphQL` directly so
 * the call sites stay greppable.
 */

import { SHOPIFY_CLIENT_API_VERSION } from "@/lib/shared/constants";

const MAX_RETRIES = 3;
const THROTTLE_WAIT_MS = 2000;

// Phase 1 Pass 2 — alias for legibility at call sites in this file. The real
// truth lives in `SHOPIFY_CLIENT_API_VERSION` (Rule #58 single owner).
const SHOPIFY_API_VERSION = SHOPIFY_CLIENT_API_VERSION;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code: string } }>;
  extensions?: { cost: { throttleStatus: { currentlyAvailable: number; restoreRate: number } } };
}

export interface ConnectionShopifyContext {
  /** myshopify.com store URL (with or without trailing slash) */
  storeUrl: string;
  /** offline access token (X-Shopify-Access-Token) */
  accessToken: string;
}

export class ShopifyScopeError extends Error {
  constructor(
    public readonly missingScope: string | null,
    public readonly httpStatus: number,
    public readonly responseBody: string,
  ) {
    super(
      missingScope
        ? `Shopify rejected the request — missing scope: ${missingScope}. Re-install the app to grant updated scopes.`
        : `Shopify rejected the request (HTTP ${httpStatus}).`,
    );
    this.name = "ShopifyScopeError";
  }
}

function endpoint(storeUrl: string): string {
  return `${storeUrl.replace(/\/$/, "")}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferMissingScope(body: string): string | null {
  const match = body.match(/requires? merchant approval for ([a-z_]+) scope/i);
  if (match) return match[1];
  return null;
}

export async function connectionShopifyGraphQL<T>(
  ctx: ConnectionShopifyContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(endpoint(ctx.storeUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ctx.accessToken,
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

    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      throw new ShopifyScopeError(inferMissingScope(body), res.status, body.slice(0, 500));
    }

    let json: GraphQLResponse<T>;
    try {
      json = (await res.json()) as GraphQLResponse<T>;
    } catch (parseErr) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(
        `Shopify GraphQL: non-JSON response (HTTP ${res.status}) | ${body.slice(0, 300)} | ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
    }

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

// ─── Read-only convenience helpers ────────────────────────────────────────────

/**
 * Walk every product/variant in the connected Shopify store. Yields one chunk
 * per page; cursor handling is internal. The generator stops when Shopify says
 * `hasNextPage = false`.
 *
 * Bounded to 50 products per page × 100 variants per product (Shopify default
 * page size cap). Caller decides what to DO with the variants.
 *
 * Pinned to `SHOPIFY_CLIENT_API_VERSION` (currently 2026-04 — see
 * `src/lib/shared/constants.ts`) to match the OAuth route's scope set.
 * HRD-09.2 ApiVersion-pinning happens at the webhook subscription layer,
 * not here.
 */
export async function* iterateAllVariants(
  ctx: ConnectionShopifyContext,
  options?: { pageSize?: number },
): AsyncGenerator<
  Array<{
    productId: string;
    productHandle: string | null;
    productTitle: string;
    productStatus: string;
    productType: string | null;
    variantId: string;
    variantTitle: string | null;
    sku: string | null;
    barcode: string | null;
    price: number | null;
    inventoryItemId: string | null;
    inventoryTracked: boolean | null;
  }>
> {
  const pageSize = options?.pageSize ?? 50;
  let cursor: string | null = null;

  const PRODUCTS_QUERY = `
    query AutoDiscoverWalk($first: Int!, $after: String) {
      products(first: $first, after: $after, sortKey: UPDATED_AT) {
        edges {
          node {
            id
            handle
            title
            status
            productType
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  price
                  inventoryItem {
                    id
                    tracked
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  type WalkPage = {
    products: {
      edges: Array<{
        node: {
          id: string;
          handle: string | null;
          title: string;
          status: string;
          productType: string | null;
          variants: {
            edges: Array<{
              node: {
                id: string;
                title: string | null;
                sku: string | null;
                barcode: string | null;
                price: string | null;
                inventoryItem: { id: string; tracked: boolean | null } | null;
              };
            }>;
          };
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };

  while (true) {
    const data: WalkPage = await connectionShopifyGraphQL<WalkPage>(ctx, PRODUCTS_QUERY, {
      first: pageSize,
      after: cursor,
    });

    const flat: Array<{
      productId: string;
      productHandle: string | null;
      productTitle: string;
      productStatus: string;
      productType: string | null;
      variantId: string;
      variantTitle: string | null;
      sku: string | null;
      barcode: string | null;
      price: number | null;
      inventoryItemId: string | null;
      inventoryTracked: boolean | null;
    }> = [];

    for (const { node: product } of data.products.edges) {
      for (const { node: variant } of product.variants.edges) {
        flat.push({
          productId: product.id,
          productHandle: product.handle?.trim() || null,
          productTitle: product.title,
          productStatus: product.status,
          productType: product.productType ?? null,
          variantId: variant.id,
          variantTitle: variant.title?.trim() || null,
          sku: variant.sku?.trim() || null,
          barcode: variant.barcode?.trim() || null,
          price:
            variant.price != null && !Number.isNaN(Number(variant.price))
              ? Number(variant.price)
              : null,
          inventoryItemId: variant.inventoryItem?.id ?? null,
          inventoryTracked: variant.inventoryItem?.tracked ?? null,
        });
      }
    }

    yield flat;

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
    if (!cursor) break;
  }
}

/**
 * HRD-04 — fetch the `available` quantity for a list of inventory item GIDs at
 * a single Shopify location. Returns a Map<inventoryItemId, available | null>
 * keyed on the input GID. `null` means Shopify returned the node but it has
 * no inventoryLevel at this location (i.e. the item is not stocked there —
 * the same condition HRD-26 catches lazily on push).
 *
 * Items not returned by Shopify (deleted between mapping discovery and
 * dry-run) are simply absent from the Map. Caller decides how to surface
 * those — typically as warnings.
 *
 * Bounded to 25 items per `nodes()` call to keep the GraphQL cost <50 (each
 * inventoryLevel costs ~2; budget per Shopify is 50/sec point cost). Larger
 * inputs are batched transparently.
 */
export async function getInventoryLevelsAtLocation(
  ctx: ConnectionShopifyContext,
  inventoryItemIds: string[],
  locationId: string,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (inventoryItemIds.length === 0) return result;

  const BATCH = 25;
  const QUERY = `
    query DryRunInventoryLevels($ids: [ID!]!, $locationId: ID!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }
  `;

  type LevelsResponse = {
    nodes: Array<{
      id: string;
      inventoryLevel: {
        quantities: Array<{ name: string; quantity: number }>;
      } | null;
    } | null>;
  };

  for (let i = 0; i < inventoryItemIds.length; i += BATCH) {
    const ids = inventoryItemIds.slice(i, i + BATCH);
    const data = await connectionShopifyGraphQL<LevelsResponse>(ctx, QUERY, { ids, locationId });
    for (const node of data.nodes) {
      if (!node?.id) continue;
      const available = node.inventoryLevel?.quantities.find(
        (q) => q.name === "available",
      )?.quantity;
      result.set(node.id, typeof available === "number" ? available : null);
    }
  }

  return result;
}

/**
 * HRD-18 — bandwidth estimate for the dry-run report. Uses the cheap
 * `ordersCount` query (introduced in 2024-10) instead of paginating actual
 * orders. Returns the last-30-day order count + derived per-day / per-hour
 * webhook rate estimates. The recommendation threshold (1000 webhooks/day =
 * roughly 500 orders/day) matches the plan's HRD-18 wording.
 *
 * Caller may pass a custom window via `daysBack` for testing; defaults to 30.
 */
export async function estimateOrderVolume(
  ctx: ConnectionShopifyContext,
  daysBack = 30,
): Promise<{
  windowDays: number;
  ordersInWindow: number;
  avgDailyOrders: number;
  estimatedDailyWebhooks: number;
  peakHourlyRate: number;
  recommendation: "safe_to_proceed" | "gradual_rollout";
}> {
  const sinceIso = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const QUERY = `
    query DryRunOrdersCount($query: String!) {
      ordersCount(query: $query) {
        count
      }
    }
  `;
  type CountResponse = { ordersCount: { count: number } };
  const data = await connectionShopifyGraphQL<CountResponse>(ctx, QUERY, {
    query: `created_at:>=${sinceIso}`,
  });

  const ordersInWindow = data.ordersCount.count ?? 0;
  const avgDailyOrders = ordersInWindow / daysBack;
  // Rough: 1 orders/create + 1 inventory_levels/update per order.
  const estimatedDailyWebhooks = avgDailyOrders * 2;
  // Peak burst factor: assume traffic concentrates ~3x in 1h around release windows.
  const peakHourlyRate = (estimatedDailyWebhooks / 24) * 3;
  const recommendation: "safe_to_proceed" | "gradual_rollout" =
    estimatedDailyWebhooks > 1000 ? "gradual_rollout" : "safe_to_proceed";

  return {
    windowDays: daysBack,
    ordersInWindow,
    avgDailyOrders,
    estimatedDailyWebhooks,
    peakHourlyRate,
    recommendation,
  };
}
