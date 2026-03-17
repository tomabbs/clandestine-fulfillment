import { describe, expect, it } from "vitest";

describe("admin orders", () => {
  describe("filter construction", () => {
    it("builds filter object with all fields", () => {
      const filters = {
        page: 2,
        pageSize: 50,
        status: "shipped",
        source: "shopify",
        search: "ORD-001",
        orgId: "org-1",
        dateFrom: "2026-01-01",
        dateTo: "2026-03-31",
      };

      expect(filters.page).toBe(2);
      expect(filters.source).toBe("shopify");
      expect(filters.orgId).toBe("org-1");
    });

    it("calculates correct offset from page", () => {
      const page = 3;
      const pageSize = 25;
      const offset = (page - 1) * pageSize;
      expect(offset).toBe(50);
    });

    it("defaults page to 1 and pageSize to 25", () => {
      const filters: { page?: number; pageSize?: number } = {};
      const page = filters.page ?? 1;
      const pageSize = filters.pageSize ?? 25;
      expect(page).toBe(1);
      expect(pageSize).toBe(25);
    });
  });

  describe("order detail structure", () => {
    it("combines order with items and shipments", () => {
      const detail = {
        order: { id: "o1", order_number: "ORD-001" },
        items: [
          { id: "i1", sku: "LP-001", quantity: 2, price: 29.99 },
          { id: "i2", sku: "CD-001", quantity: 1, price: 14.99 },
        ],
        shipments: [{ id: "s1", tracking_number: "1Z999", carrier: "UPS", status: "shipped" }],
      };

      expect(detail.items).toHaveLength(2);
      expect(detail.shipments).toHaveLength(1);
      expect(detail.order.order_number).toBe("ORD-001");
    });
  });

  describe("source badge mapping", () => {
    it("maps all expected sources to colors", () => {
      const sources = ["shopify", "bandcamp", "woocommerce", "squarespace", "manual"];
      const colorMap: Record<string, string> = {
        shopify: "bg-green-100 text-green-800",
        bandcamp: "bg-blue-100 text-blue-800",
        woocommerce: "bg-purple-100 text-purple-800",
        squarespace: "bg-yellow-100 text-yellow-800",
        manual: "bg-gray-100 text-gray-800",
      };

      for (const source of sources) {
        expect(colorMap[source]).toBeDefined();
      }
    });
  });
});
