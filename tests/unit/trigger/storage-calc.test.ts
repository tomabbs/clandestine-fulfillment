import { describe, expect, it } from "vitest";
import { computeActiveStock, shouldSkipOrg } from "@/trigger/tasks/storage-calc";

describe("storage-calc", () => {
  describe("computeActiveStock", () => {
    it("computes billable units = inventory - active stock", () => {
      const salesBySku = new Map([
        ["LP-001", 50], // sold 50 in 6 months
        ["LP-002", 20],
      ]);
      const inventoryBySku = new Map([
        ["LP-001", 100], // 100 in stock, 50 active → 50 billable
        ["LP-002", 15], // 15 in stock, 20 active → 0 billable (capped at 0)
      ]);

      const results = computeActiveStock(salesBySku, inventoryBySku);

      expect(results).toHaveLength(2);

      const lp001 = results.find((r) => r.sku === "LP-001");
      expect(lp001?.totalInventory).toBe(100);
      expect(lp001?.activeStock).toBe(50);
      expect(lp001?.billableUnits).toBe(50);

      const lp002 = results.find((r) => r.sku === "LP-002");
      expect(lp002?.totalInventory).toBe(15);
      expect(lp002?.activeStock).toBe(20);
      expect(lp002?.billableUnits).toBe(0); // max(0, 15 - 20)
    });

    it("treats SKUs with no sales as fully billable", () => {
      const salesBySku = new Map<string, number>(); // no sales
      const inventoryBySku = new Map([["LP-001", 200]]);

      const results = computeActiveStock(salesBySku, inventoryBySku);

      expect(results[0].activeStock).toBe(0);
      expect(results[0].billableUnits).toBe(200);
    });

    it("skips SKUs with zero or negative inventory", () => {
      const salesBySku = new Map([["LP-001", 10]]);
      const inventoryBySku = new Map([
        ["LP-001", 0],
        ["LP-002", -5],
      ]);

      const results = computeActiveStock(salesBySku, inventoryBySku);

      expect(results).toHaveLength(0);
    });

    it("handles empty inventory map", () => {
      const salesBySku = new Map([["LP-001", 10]]);
      const inventoryBySku = new Map<string, number>();

      const results = computeActiveStock(salesBySku, inventoryBySku);

      expect(results).toHaveLength(0);
    });
  });

  describe("shouldSkipOrg", () => {
    it("skips orgs with storage_fee_waived=true", () => {
      expect(
        shouldSkipOrg({
          storage_fee_waived: true,
          warehouse_grace_period_ends_at: null,
        }),
      ).toBe(true);
    });

    it("skips orgs within grace period", () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      expect(
        shouldSkipOrg({
          storage_fee_waived: false,
          warehouse_grace_period_ends_at: futureDate.toISOString(),
        }),
      ).toBe(true);
    });

    it("does NOT skip orgs past grace period", () => {
      expect(
        shouldSkipOrg({
          storage_fee_waived: false,
          warehouse_grace_period_ends_at: "2020-01-01T00:00:00Z",
        }),
      ).toBe(false);
    });

    it("does NOT skip normal orgs", () => {
      expect(
        shouldSkipOrg({
          storage_fee_waived: false,
          warehouse_grace_period_ends_at: null,
        }),
      ).toBe(false);
    });

    it("handles null storage_fee_waived", () => {
      expect(
        shouldSkipOrg({
          storage_fee_waived: null,
          warehouse_grace_period_ends_at: null,
        }),
      ).toBe(false);
    });
  });
});
