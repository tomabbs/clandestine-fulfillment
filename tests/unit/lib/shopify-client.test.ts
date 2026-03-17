import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock env to avoid validation at import time
vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    SHOPIFY_STORE_URL: "https://test-store.myshopify.com",
    SHOPIFY_ADMIN_API_TOKEN: "shpat_test_token",
    SHOPIFY_API_VERSION: "2024-01",
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocks — use beforeAll to avoid top-level await
type ShopifyClientModule = typeof import("@/lib/clients/shopify-client");
let shopifyGraphQL: ShopifyClientModule["shopifyGraphQL"];
let makeIdempotencyKey: ShopifyClientModule["makeIdempotencyKey"];
let fetchProducts: ShopifyClientModule["fetchProducts"];

beforeAll(async () => {
  const mod = await import("@/lib/clients/shopify-client");
  shopifyGraphQL = mod.shopifyGraphQL;
  makeIdempotencyKey = mod.makeIdempotencyKey;
  fetchProducts = mod.fetchProducts;
});

describe("shopifyGraphQL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends correct headers and body", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ data: { shop: { name: "Test" } } }),
    });

    await shopifyGraphQL("{ shop { name } }");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://test-store.myshopify.com/admin/api/2024-01/graphql.json");
    expect(options.method).toBe("POST");
    expect(options.headers["X-Shopify-Access-Token"]).toBe("shpat_test_token");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.query).toBe("{ shop { name } }");
  });

  it("passes variables in the request body", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ data: { product: { id: "1" } } }),
    });

    await shopifyGraphQL("query ($id: ID!) { product(id: $id) { id } }", { id: "123" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.variables).toEqual({ id: "123" });
  });

  it("retries on 429 rate limit response", async () => {
    mockFetch
      .mockResolvedValueOnce({
        status: 429,
        headers: new Headers({ "Retry-After": "1" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ data: { ok: true } }),
      });

    const result = await shopifyGraphQL("{ ok }");
    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on THROTTLED GraphQL error", async () => {
    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ data: { ok: true } }),
      });

    const result = await shopifyGraphQL("{ ok }");
    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on non-throttle GraphQL errors after retries", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        errors: [{ message: "Invalid query" }],
      }),
    });

    await expect(shopifyGraphQL("{ invalid }")).rejects.toThrow("Invalid query");
  });

  it("throws on empty data response", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ data: null }),
    });

    await expect(shopifyGraphQL("{ shop { name } }")).rejects.toThrow("empty response data");
  });
});

describe("makeIdempotencyKey", () => {
  it("generates stable key from task run ID and SKU (Rule #15)", () => {
    const key = makeIdempotencyKey("run_abc123", "VINYL-LP-001");
    expect(key).toBe("run_abc123:VINYL-LP-001");
  });

  it("is deterministic — same inputs produce same key", () => {
    const key1 = makeIdempotencyKey("run_xyz", "SKU-A");
    const key2 = makeIdempotencyKey("run_xyz", "SKU-A");
    expect(key1).toBe(key2);
  });

  it("different inputs produce different keys", () => {
    const key1 = makeIdempotencyKey("run_1", "SKU-A");
    const key2 = makeIdempotencyKey("run_2", "SKU-A");
    const key3 = makeIdempotencyKey("run_1", "SKU-B");
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });
});

describe("fetchProducts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns products and pageInfo from GraphQL response", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        data: {
          products: {
            edges: [
              {
                node: {
                  id: "gid://shopify/Product/1",
                  title: "Test LP",
                  handle: "test-lp",
                  vendor: "Label",
                  productType: "Vinyl",
                  status: "ACTIVE",
                  tags: ["vinyl"],
                  updatedAt: "2026-01-01T00:00:00Z",
                  variants: { edges: [] },
                  images: { edges: [] },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });

    const result = await fetchProducts({ first: 10 });
    expect(result.products).toHaveLength(1);
    expect(result.products[0].title).toBe("Test LP");
    expect(result.pageInfo.hasNextPage).toBe(false);
  });
});
