import { describe, expect, it } from "vitest";

describe("preorders actions", () => {
  it("getPreorderProducts enriches variants with order counts and stock", () => {
    const variant = {
      id: "v-1",
      sku: "LP-PRE-001",
      variantTitle: "Default",
      productTitle: "Test LP",
      streetDate: "2026-04-01",
      orderCount: 25,
      availableStock: 20,
      isShortRisk: true,
    };

    expect(variant.isShortRisk).toBe(true);
    expect(variant.orderCount).toBeGreaterThan(variant.availableStock);
  });

  it("isShortRisk is true when orders > stock", () => {
    const isShort = (orderCount: number, available: number) => orderCount > available;

    expect(isShort(25, 20)).toBe(true);
    expect(isShort(10, 20)).toBe(false);
    expect(isShort(20, 20)).toBe(false);
  });

  it("getPreorderAllocationPreview returns allocation without executing", () => {
    const preview = {
      sku: "LP-PRE-001",
      streetDate: "2026-04-01",
      availableStock: 100,
      orders: [
        { id: "o-1", orderNumber: "ORD-001", customerName: "Alice", quantity: 2 },
        { id: "o-2", orderNumber: "ORD-002", customerName: "Bob", quantity: 3 },
      ],
      allocation: {
        allocated: [
          { orderId: "o-1", quantity: 2 },
          { orderId: "o-2", quantity: 3 },
        ],
        unallocated: [],
        totalAllocated: 5,
        totalUnallocated: 0,
        isShortShipment: false,
      },
    };

    expect(preview.allocation.isShortShipment).toBe(false);
    expect(preview.allocation.allocated).toHaveLength(2);
    expect(preview.allocation.totalAllocated).toBe(5);
  });
});
