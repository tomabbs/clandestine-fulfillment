import { describe, expect, it } from "vitest";
import {
  computeDelta,
  parseShopifyInventoryPayload,
} from "@/trigger/tasks/process-shopify-webhook";

describe("process-shopify-webhook", () => {
  describe("parseShopifyInventoryPayload", () => {
    it("parses a valid Shopify inventory_levels/update payload", () => {
      const payload = {
        inventory_item_id: 808950810,
        location_id: 905684977,
        available: 6,
        updated_at: "2026-03-17T19:00:00-04:00",
      };

      const result = parseShopifyInventoryPayload(payload);

      expect(result).toEqual({
        inventoryItemId: 808950810,
        available: 6,
      });
    });

    it("treats null available as 0", () => {
      const payload = {
        inventory_item_id: 123456,
        location_id: 789,
        available: null,
      };

      const result = parseShopifyInventoryPayload(payload);

      expect(result).toEqual({
        inventoryItemId: 123456,
        available: 0,
      });
    });

    it("returns null for missing inventory_item_id", () => {
      const payload = { available: 5 };
      expect(parseShopifyInventoryPayload(payload)).toBeNull();
    });

    it("returns null for non-numeric inventory_item_id", () => {
      const payload = {
        inventory_item_id: "not-a-number",
        available: 5,
      };
      expect(parseShopifyInventoryPayload(payload)).toBeNull();
    });

    it("returns null for completely invalid data", () => {
      expect(parseShopifyInventoryPayload(null)).toBeNull();
      expect(parseShopifyInventoryPayload(undefined)).toBeNull();
      expect(parseShopifyInventoryPayload("string")).toBeNull();
      expect(parseShopifyInventoryPayload(42)).toBeNull();
    });

    it("ignores extra fields without failing", () => {
      const payload = {
        inventory_item_id: 111,
        available: 10,
        location_id: 222,
        admin_graphql_api_id: "gid://shopify/InventoryLevel/111?inventory_item_id=111",
      };

      const result = parseShopifyInventoryPayload(payload);
      expect(result).toEqual({ inventoryItemId: 111, available: 10 });
    });
  });

  describe("computeDelta", () => {
    it("returns positive delta when webhook quantity is higher", () => {
      expect(computeDelta(10, 7)).toBe(3);
    });

    it("returns negative delta when webhook quantity is lower (sale)", () => {
      expect(computeDelta(5, 8)).toBe(-3);
    });

    it("returns 0 when quantities match", () => {
      expect(computeDelta(4, 4)).toBe(0);
    });

    it("handles zero warehouse quantity", () => {
      expect(computeDelta(5, 0)).toBe(5);
    });

    it("handles zero webhook quantity", () => {
      expect(computeDelta(0, 5)).toBe(-5);
    });

    it("handles both zero", () => {
      expect(computeDelta(0, 0)).toBe(0);
    });

    it("handles large quantities", () => {
      expect(computeDelta(10000, 9995)).toBe(5);
    });
  });
});
