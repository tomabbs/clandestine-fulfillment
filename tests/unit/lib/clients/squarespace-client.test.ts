import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  adjustInventory,
  getInventory,
  getOrders,
  getProductsByIds,
  listCatalogItems,
  listProductsPage,
} from "@/lib/clients/squarespace-client";

describe("squarespace-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const apiKey = "test-api-key";
  const storeUrl = "https://mystore.squarespace.com";

  describe("getInventory", () => {
    it("fetches inventory with Bearer auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          inventory: [
            { variantId: "v1", sku: "SKU-001", quantity: 10, isUnlimited: false },
            { variantId: "v2", sku: "SKU-002", quantity: 5, isUnlimited: false },
          ],
        }),
      });

      const result = await getInventory(apiKey, storeUrl);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.squarespace.com/1.0/commerce/inventory",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
            "User-Agent": "clandestine-fulfillment/1.0",
          }),
        }),
      );
      expect(result).toHaveLength(2);
      expect(result[0].sku).toBe("SKU-001");
      expect(result[0].quantity).toBe(10);
    });

    it("paginates inventory until nextPageCursor is exhausted", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            inventory: [{ variantId: "v1", sku: "SKU-001", quantity: 10 }],
            pagination: { hasNextPage: true, nextPageCursor: "cursor-1" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            inventory: [{ variantId: "v2", sku: "SKU-002", quantity: 5 }],
            pagination: { hasNextPage: false, nextPageCursor: null },
          }),
        });

      const result = await getInventory(apiKey, storeUrl);

      expect(result).toHaveLength(2);
      expect((mockFetch.mock.calls[1]?.[0] as string) ?? "").toContain("cursor=cursor-1");
    });

    it("throws on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      await expect(getInventory(apiKey, storeUrl)).rejects.toThrow("Squarespace API error 401");
    });
  });

  describe("adjustInventory", () => {
    it("sends POST with Idempotency-Key header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await adjustInventory(apiKey, storeUrl, "var-1", 5, "idem-key-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.squarespace.com/1.0/commerce/inventory/adjustments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            incrementOperations: [{ variantId: "var-1", quantity: 5 }],
          }),
        }),
      );

      // Verify Idempotency-Key header is present
      const call = mockFetch.mock.calls[0];
      const headers = call[1].headers;
      expect(headers["Idempotency-Key"]).toBe("idem-key-123");
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      await expect(adjustInventory(apiKey, storeUrl, "var-1", 5, "key")).rejects.toThrow(
        "Squarespace API error 400",
      );
    });
  });

  describe("getOrders", () => {
    it("fetches orders with pagination", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [
            {
              id: "order-1",
              orderNumber: "1001",
              createdOn: "2026-01-01T00:00:00Z",
              modifiedOn: "2026-01-02T00:00:00Z",
              fulfillmentStatus: "PENDING",
              lineItems: [
                {
                  id: "li-1",
                  variantId: "v1",
                  sku: "SKU-001",
                  productName: "Test Product",
                  quantity: 2,
                  unitPricePaid: { value: "29.99", currency: "USD" },
                },
              ],
            },
          ],
          pagination: { hasNextPage: false, nextPageCursor: null },
        }),
      });

      const result = await getOrders(apiKey, storeUrl, {
        modifiedAfter: "2026-01-01T00:00:00Z",
      });

      expect(result.orders).toHaveLength(1);
      expect(result.orders[0].orderNumber).toBe("1001");
      expect(result.nextCursor).toBeNull();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("modifiedAfter=");
    });

    it("passes cursor for pagination", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [],
          pagination: { hasNextPage: false },
        }),
      });

      await getOrders(apiKey, storeUrl, { cursor: "abc123" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("cursor=abc123");
    });
  });

  describe("product catalog readers", () => {
    it("lists products from the v2 commerce endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          products: [{ id: "p1", name: "Test LP", type: "PHYSICAL", url: "https://store/item" }],
          pagination: { hasNextPage: false, nextPageCursor: null },
        }),
      });

      const result = await listProductsPage(apiKey);

      expect(result.products).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.squarespace.com/v2/commerce/products",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
            "User-Agent": "clandestine-fulfillment/1.0",
          }),
        }),
      );
    });

    it("fetches product details by product ids", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          products: [
            {
              id: "p1",
              name: "Test LP",
              type: "PHYSICAL",
              url: "https://store/item",
              variants: [{ id: "v1", sku: "LP-001", stock: { quantity: 8, unlimited: false } }],
            },
          ],
        }),
      });

      const result = await getProductsByIds(apiKey, ["p1"]);

      expect(result[0]?.variants[0]?.sku).toBe("LP-001");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.squarespace.com/v2/commerce/products/p1",
        expect.anything(),
      );
    });

    it("builds a flat catalog from product pages plus detail batches", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            products: [
              { id: "p1", name: "Test Shirt", type: "PHYSICAL", url: "https://store/shirt" },
            ],
            pagination: { hasNextPage: false, nextPageCursor: null },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            products: [
              {
                id: "p1",
                name: "Test Shirt",
                type: "PHYSICAL",
                url: "https://store/shirt",
                variants: [
                  {
                    id: "v1",
                    sku: "SHIRT-L",
                    stock: { quantity: 4, unlimited: false },
                    attributes: { Size: "Large" },
                  },
                ],
              },
            ],
          }),
        });

      const items = await listCatalogItems(apiKey);

      expect(items).toEqual([
        {
          productId: "p1",
          variantId: "v1",
          productName: "Test Shirt",
          variantName: "Test Shirt - Large",
          sku: "SHIRT-L",
          quantity: 4,
          unlimited: false,
          productUrl: "https://store/shirt",
          productType: "PHYSICAL",
        },
      ]);
    });
  });
});
