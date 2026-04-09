import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(async () => ({ from: mockFrom })),
}));

import {
  getClientMailOrders,
  getMailOrderPayoutSummary,
  getMailOrders,
} from "@/actions/mail-orders";

function makeListChain(
  result: { data: unknown[]; count: number; error: null },
  opts: { extendWithIlike?: boolean } = {},
) {
  const promise = Promise.resolve(result);
  const chain = {
    select: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    ilike: vi.fn(),
    eq: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  if (opts.extendWithIlike) {
    chain.range.mockReturnValue(chain);
    chain.ilike.mockReturnValue(promise);
  } else {
    chain.range.mockReturnValue(promise);
  }
  chain.eq.mockReturnValue(promise);
  mockFrom.mockReturnValue(chain);
  return chain;
}

function makePayoutChain(result: { data: unknown[]; error: null }, orgScoped: boolean) {
  const promise = Promise.resolve(result);
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
  };
  chain.eq.mockReturnValue(promise);
  chain.select.mockReturnValue(orgScoped ? chain : promise);
  mockFrom.mockReturnValue(chain);
  return chain;
}

describe("mail-orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getMailOrders", () => {
    it("returns paginated results with defaults", async () => {
      const rows = [{ id: "o1", order_number: "100" }];
      const chain = makeListChain({ data: rows, count: 1, error: null });

      const result = await getMailOrders();

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
      expect(result.orders).toEqual(rows);
      expect(result.total).toBe(1);
      expect(chain.range).toHaveBeenCalledWith(0, 49);
    });

    it("applies search filter on order_number", async () => {
      const chain = makeListChain({ data: [], count: 0, error: null }, { extendWithIlike: true });

      await getMailOrders({ search: "ABC" });

      expect(chain.ilike).toHaveBeenCalledWith("order_number", "%ABC%");
    });
  });

  describe("getClientMailOrders", () => {
    it("returns results with org-scoped RLS", async () => {
      const rows = [{ id: "o1", order_number: "200" }];
      makeListChain({ data: rows, count: 1, error: null });

      const result = await getClientMailOrders();

      expect(mockFrom).toHaveBeenCalledWith("mailorder_orders");
      expect(result.orders).toEqual(rows);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
    });
  });

  describe("getMailOrderPayoutSummary", () => {
    it("aggregates pending vs included payout amounts", async () => {
      const chain = makePayoutChain(
        {
          data: [
            { client_payout_amount: 10, client_payout_status: "pending" },
            { client_payout_amount: 5, client_payout_status: "pending" },
            { client_payout_amount: 100, client_payout_status: "included_in_snapshot" },
          ],
          error: null,
        },
        true,
      );

      const result = await getMailOrderPayoutSummary("org-1");

      expect(chain.eq).toHaveBeenCalledWith("org_id", "org-1");
      expect(result.totalPendingPayout).toBe(15);
      expect(result.totalIncludedPayout).toBe(100);
      expect(result.pendingOrderCount).toBe(2);
    });

    it("returns zero when no orders", async () => {
      makePayoutChain({ data: [], error: null }, false);

      const result = await getMailOrderPayoutSummary();

      expect(result.totalPendingPayout).toBe(0);
      expect(result.totalIncludedPayout).toBe(0);
      expect(result.pendingOrderCount).toBe(0);
    });
  });
});
