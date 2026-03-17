import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { adjustInventory, getInventory, getOrders } from "@/lib/clients/squarespace-client";

describe("squarespace-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        "https://mystore.squarespace.com/api/1.0/commerce/inventory",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
          }),
        }),
      );
      expect(result).toHaveLength(2);
      expect(result[0].sku).toBe("SKU-001");
      expect(result[0].quantity).toBe(10);
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
        "https://mystore.squarespace.com/api/1.0/commerce/inventory/adjustments",
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
});
