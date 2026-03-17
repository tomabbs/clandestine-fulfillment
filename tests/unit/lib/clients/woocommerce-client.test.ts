import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import type { WooCommerceCredentials } from "@/lib/clients/woocommerce-client";
import { getOrders, getProductBySku, updateStockQuantity } from "@/lib/clients/woocommerce-client";

describe("woocommerce-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const credentials: WooCommerceCredentials = {
    consumerKey: "ck_test123",
    consumerSecret: "cs_test456",
    siteUrl: "https://shop.example.com",
  };

  const expectedAuthHeader = `Basic ${Buffer.from("ck_test123:cs_test456").toString("base64")}`;

  describe("getProductBySku", () => {
    it("fetches product by SKU with Basic Auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 42,
            name: "Test LP",
            sku: "LP-001",
            stock_quantity: 15,
            stock_status: "instock",
            manage_stock: true,
            price: "29.99",
          },
        ],
      });

      const result = await getProductBySku(credentials, "LP-001");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://shop.example.com/wp-json/wc/v3/products?sku=LP-001",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expectedAuthHeader,
          }),
        }),
      );
      expect(result).not.toBeNull();
      expect(result?.id).toBe(42);
      expect(result?.stock_quantity).toBe(15);
    });

    it("returns null when product not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const result = await getProductBySku(credentials, "NONEXISTENT");
      expect(result).toBeNull();
    });

    it("throws on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Consumer key is invalid",
      });

      await expect(getProductBySku(credentials, "LP-001")).rejects.toThrow(
        "WooCommerce API error 401",
      );
    });
  });

  describe("updateStockQuantity", () => {
    it("sends PUT with absolute stock_quantity (Rule #44)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 42,
          name: "Test LP",
          sku: "LP-001",
          stock_quantity: 20,
          stock_status: "instock",
          manage_stock: true,
          price: "29.99",
        }),
      });

      const result = await updateStockQuantity(credentials, 42, 20);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://shop.example.com/wp-json/wc/v3/products/42",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ stock_quantity: 20, manage_stock: true }),
        }),
      );
      expect(result.stock_quantity).toBe(20);
    });

    it("uses absolute value not delta", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 42,
          name: "Test LP",
          sku: "LP-001",
          stock_quantity: 0,
          stock_status: "outofstock",
          manage_stock: true,
          price: "29.99",
        }),
      });

      await updateStockQuantity(credentials, 42, 0);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Rule #44: absolute quantity, stock_quantity is the value sent
      expect(body.stock_quantity).toBe(0);
      expect(body).not.toHaveProperty("delta");
    });
  });

  describe("getOrders", () => {
    it("fetches orders with filter params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 101,
            number: "101",
            status: "processing",
            date_created: "2026-01-15T10:00:00",
            date_modified: "2026-01-15T11:00:00",
            total: "59.98",
            currency: "USD",
            line_items: [
              {
                id: 1,
                product_id: 42,
                variation_id: 0,
                name: "Test LP",
                sku: "LP-001",
                quantity: 2,
                price: "29.99",
              },
            ],
          },
        ],
      });

      const result = await getOrders(credentials, {
        after: "2026-01-01T00:00:00",
        page: 1,
        perPage: 25,
      });

      expect(result).toHaveLength(1);
      expect(result[0].number).toBe("101");
      expect(result[0].line_items[0].sku).toBe("LP-001");

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("after=");
      expect(url).toContain("page=1");
      expect(url).toContain("per_page=25");
    });

    it("fetches orders without params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const result = await getOrders(credentials);
      expect(result).toEqual([]);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe("https://shop.example.com/wp-json/wc/v3/orders");
    });
  });
});
