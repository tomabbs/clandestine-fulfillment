import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 Slice 6.F — tests for the portal stock-exceptions read surface.
// Covers: requireClient gate, org-scoping defense, outcome-state filter,
// active-only filter, filter pass-through, bounded page sizes.

const mockFrom = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireClient: vi.fn(() =>
    Promise.resolve({ userId: "user-1", orgId: "org-1", workspaceId: "ws-1" }),
  ),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ from: mockFrom }),
}));

import { listClientStockExceptions } from "@/actions/portal-stock-exceptions";
import { requireClient } from "@/lib/server/auth-context";

type TerminalShape = {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
};

function makeQueryBuilder(terminal: TerminalShape | Promise<TerminalShape>) {
  const resolved = Promise.resolve(terminal);
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

  const builder: Record<string, unknown> = {
    select: rec("select"),
    eq: rec("eq"),
    order: rec("order"),
    range: (from: number, to: number) => {
      calls.push({ method: "range", args: [from, to] });
      return resolved;
    },
  };

  return { builder, calls };
}

const CONN_ID = "11111111-1111-4111-8111-111111111111";

describe("listClientStockExceptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireClient).mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      workspaceId: "ws-1",
    });
  });

  it("requires a client and applies org + outcome + active predicates", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          connection_id: CONN_ID,
          platform: "shopify",
          variant_id: "33333333-3333-4333-8333-333333333333",
          remote_product_id: "rp-1",
          remote_variant_id: "rv-1",
          remote_sku: "SKU-1",
          warehouse_stock_at_match: 0,
          remote_stock_at_match: 3,
          remote_stock_listed_at_match: true,
          last_evaluated_at: "2026-04-26T00:00:00Z",
          evaluation_count: 2,
          created_at: "2026-04-20T00:00:00Z",
        },
      ],
      count: 5,
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);

    const result = await listClientStockExceptions({ limit: 25, offset: 0 });

    expect(requireClient).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledWith("client_store_product_identity_matches");

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["org_id", "org-1"] },
        { method: "eq", args: ["outcome_state", "client_stock_exception"] },
        { method: "eq", args: ["is_active", true] },
      ]),
    );
    expect(calls.find((c) => c.method === "order")).toMatchObject({
      args: ["last_evaluated_at", { ascending: false }],
    });
    expect(calls.find((c) => c.method === "range")).toMatchObject({ args: [0, 24] });

    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(5);
  });

  it("applies optional connection + platform filters", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], count: 0, error: null });
    mockFrom.mockReturnValueOnce(builder);

    await listClientStockExceptions({
      connectionId: CONN_ID,
      platform: "shopify",
      limit: 10,
      offset: 30,
    });

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["connection_id", CONN_ID] },
        { method: "eq", args: ["platform", "shopify"] },
      ]),
    );
    expect(calls.find((c) => c.method === "range")).toMatchObject({ args: [30, 39] });
  });

  it("rejects limit > LIST_MAX_LIMIT", async () => {
    await expect(listClientStockExceptions({ limit: 101 })).rejects.toThrow();
  });

  it("propagates supabase errors as thrown", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      count: null,
      error: { message: "db broke" },
    });
    mockFrom.mockReturnValueOnce(builder);

    await expect(listClientStockExceptions({})).rejects.toThrow(
      /listClientStockExceptions failed: db broke/,
    );
  });

  it("surfaces requireClient rejection (non-client user)", async () => {
    vi.mocked(requireClient).mockRejectedValueOnce(new Error("Client access required"));
    await expect(listClientStockExceptions({})).rejects.toThrow(/Client access required/);
  });
});
