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

const MAX_RETRIES = 3;
const THROTTLE_WAIT_MS = 2000;

const SHOPIFY_API_VERSION = "2026-01";

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
 * Pinned to API version `2026-01` to match the OAuth route's scope set
 * (HRD-09.2 ApiVersion-pinning happens at the webhook subscription layer,
 * not here).
 */
export async function* iterateAllVariants(
  ctx: ConnectionShopifyContext,
  options?: { pageSize?: number },
): AsyncGenerator<
  Array<{
    productId: string;
    productTitle: string;
    productStatus: string;
    variantId: string;
    sku: string | null;
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
            title
            status
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
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
          title: string;
          status: string;
          variants: {
            edges: Array<{
              node: {
                id: string;
                sku: string | null;
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
      productTitle: string;
      productStatus: string;
      variantId: string;
      sku: string | null;
      inventoryItemId: string | null;
      inventoryTracked: boolean | null;
    }> = [];

    for (const { node: product } of data.products.edges) {
      for (const { node: variant } of product.variants.edges) {
        flat.push({
          productId: product.id,
          productTitle: product.title,
          productStatus: product.status,
          variantId: variant.id,
          sku: variant.sku?.trim() || null,
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
