import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(async () => ({ from: mockFrom })),
  createServiceRoleClient: vi.fn(() => ({ from: mockServiceFrom })),
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireClient: vi.fn(async () => ({ userId: "u-1", orgId: "org-1", workspaceId: "ws-1" })),
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

function _makePayoutChain(result: { data: unknown[]; error: null }, orgScoped: boolean) {
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
    it("returns results scoped to authenticated org", async () => {
      const rows = [{ id: "o1", order_number: "200" }];
      const promise = Promise.resolve({ data: rows, count: 1, error: null });
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockReturnValue(promise),
        ilike: vi.fn(),
      };
      mockServiceFrom.mockReturnValue(chain);

      const result = await getClientMailOrders();

      expect(mockServiceFrom).toHaveBeenCalledWith("mailorder_orders");
      expect(chain.eq).toHaveBeenCalledWith("org_id", "org-1");
      expect(result.orders).toEqual(rows);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
    });
  });

  describe("getMailOrderPayoutSummary", () => {
    it("aggregates pending vs included payout amounts scoped to org", async () => {
      const promise = Promise.resolve({
        data: [
          { client_payout_amount: 10, client_payout_status: "pending" },
          { client_payout_amount: 5, client_payout_status: "pending" },
          { client_payout_amount: 100, client_payout_status: "included_in_snapshot" },
        ],
        error: null,
      });
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnValue(promise),
      };
      mockServiceFrom.mockReturnValue(chain);

      const result = await getMailOrderPayoutSummary();

      expect(mockServiceFrom).toHaveBeenCalledWith("mailorder_orders");
      expect(chain.eq).toHaveBeenCalledWith("org_id", "org-1");
      expect(result.totalPendingPayout).toBe(15);
      expect(result.totalIncludedPayout).toBe(100);
      expect(result.pendingOrderCount).toBe(2);
    });

    it("returns zero when no orders", async () => {
      const promise = Promise.resolve({ data: [], error: null });
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnValue(promise),
      };
      mockServiceFrom.mockReturnValue(chain);

      const result = await getMailOrderPayoutSummary();

      expect(result.totalPendingPayout).toBe(0);
      expect(result.totalIncludedPayout).toBe(0);
      expect(result.pendingOrderCount).toBe(0);
    });
  });
});
