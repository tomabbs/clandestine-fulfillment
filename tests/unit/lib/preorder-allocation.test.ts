import { describe, expect, it } from "vitest";
import type { PreorderOrder } from "@/trigger/lib/preorder-allocation";
import { allocatePreorders } from "@/trigger/lib/preorder-allocation";

function makeOrder(id: string, created_at: string, quantity = 1): PreorderOrder {
  return { id, created_at, quantity };
}

describe("allocatePreorders (Rule #69: FIFO)", () => {
  it("allocates orders in FIFO order (oldest first)", () => {
    const orders = [
      makeOrder("order-3", "2026-03-03T00:00:00Z"),
      makeOrder("order-1", "2026-03-01T00:00:00Z"),
      makeOrder("order-2", "2026-03-02T00:00:00Z"),
    ];

    const result = allocatePreorders(orders, 10);

    expect(result.allocated).toHaveLength(3);
    // Should be sorted by created_at: order-1, order-2, order-3
    expect(result.allocated[0].orderId).toBe("order-1");
    expect(result.allocated[1].orderId).toBe("order-2");
    expect(result.allocated[2].orderId).toBe("order-3");
    expect(result.isShortShipment).toBe(false);
  });

  it("handles short shipment — more orders than stock", () => {
    const orders = [
      makeOrder("order-1", "2026-03-01T00:00:00Z", 100),
      makeOrder("order-2", "2026-03-02T00:00:00Z", 100),
      makeOrder("order-3", "2026-03-03T00:00:00Z", 100),
      makeOrder("order-4", "2026-03-04T00:00:00Z", 100),
      makeOrder("order-5", "2026-03-05T00:00:00Z", 100),
    ];

    const result = allocatePreorders(orders, 300);

    expect(result.allocated).toHaveLength(3);
    expect(result.allocated[0].orderId).toBe("order-1");
    expect(result.allocated[1].orderId).toBe("order-2");
    expect(result.allocated[2].orderId).toBe("order-3");
    expect(result.unallocated).toHaveLength(2);
    expect(result.unallocated[0].orderId).toBe("order-4");
    expect(result.unallocated[1].orderId).toBe("order-5");
    expect(result.totalAllocated).toBe(300);
    expect(result.totalUnallocated).toBe(200);
    expect(result.isShortShipment).toBe(true);
  });

  it("handles zero available stock — all orders unallocated", () => {
    const orders = [
      makeOrder("order-1", "2026-03-01T00:00:00Z", 5),
      makeOrder("order-2", "2026-03-02T00:00:00Z", 3),
    ];

    const result = allocatePreorders(orders, 0);

    expect(result.allocated).toHaveLength(0);
    expect(result.unallocated).toHaveLength(2);
    expect(result.totalAllocated).toBe(0);
    expect(result.totalUnallocated).toBe(8);
    expect(result.isShortShipment).toBe(true);
  });

  it("skips already-allocated order IDs (idempotency)", () => {
    const orders = [
      makeOrder("order-1", "2026-03-01T00:00:00Z", 2),
      makeOrder("order-2", "2026-03-02T00:00:00Z", 2),
      makeOrder("order-3", "2026-03-03T00:00:00Z", 2),
    ];

    // First run
    const firstRun = allocatePreorders(orders, 4);
    expect(firstRun.allocated).toHaveLength(2);
    expect(firstRun.allocated[0].orderId).toBe("order-1");
    expect(firstRun.allocated[1].orderId).toBe("order-2");

    // Second run with already-allocated IDs — should not double-allocate
    const alreadyAllocated = new Set(firstRun.allocated.map((a) => a.orderId));
    const secondRun = allocatePreorders(orders, 4, alreadyAllocated);

    expect(secondRun.allocated).toHaveLength(1);
    expect(secondRun.allocated[0].orderId).toBe("order-3");
    // order-1 and order-2 are skipped
  });

  it("returns empty allocation for empty orders list", () => {
    const result = allocatePreorders([], 100);

    expect(result.allocated).toHaveLength(0);
    expect(result.unallocated).toHaveLength(0);
    expect(result.totalAllocated).toBe(0);
    expect(result.isShortShipment).toBe(false);
  });

  it("handles single order with exact stock", () => {
    const orders = [makeOrder("order-1", "2026-03-01T00:00:00Z", 50)];

    const result = allocatePreorders(orders, 50);

    expect(result.allocated).toHaveLength(1);
    expect(result.unallocated).toHaveLength(0);
    expect(result.totalAllocated).toBe(50);
    expect(result.isShortShipment).toBe(false);
  });

  it("order quantity > stock means that order is unallocated", () => {
    const orders = [
      makeOrder("order-1", "2026-03-01T00:00:00Z", 10),
      makeOrder("order-2", "2026-03-02T00:00:00Z", 50),
    ];

    // 10 stock: order-1 (10 units) fits, order-2 (50 units) doesn't
    const result = allocatePreorders(orders, 10);

    expect(result.allocated).toHaveLength(1);
    expect(result.allocated[0].orderId).toBe("order-1");
    expect(result.unallocated).toHaveLength(1);
    expect(result.unallocated[0].orderId).toBe("order-2");
    expect(result.isShortShipment).toBe(true);
  });
});
