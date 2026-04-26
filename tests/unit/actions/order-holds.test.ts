import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 Slice 6.C — tests for the order-holds Server Actions
// (listOrderHolds, releaseOrderHold, releaseOrderHoldsBulk). Covers:
//   * requireStaff gate
//   * workspace-scoping defense
//   * reason + connection filters, pagination, grouped-by-reason summary
//   * single-release: non-existent, out-of-workspace, not-on-hold, RPC failure
//   * bulk-release: partial success, staff_override note rule
//   * resolution-code whitelist enforced server-side

const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ from: mockFrom, rpc: mockRpc }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { listOrderHolds, releaseOrderHold, releaseOrderHoldsBulk } from "@/actions/order-holds";
import { requireStaff } from "@/lib/server/auth-context";

// ─────────────────────────────────────────────────────────────────────────────
// Fake supabase query-builder chain. Supports the methods the actions call:
// select / eq / in / gte / lte / order / range / maybeSingle. Every method
// records its call for assertion, and terminal methods return the programmed
// result.
// ─────────────────────────────────────────────────────────────────────────────

type TerminalShape = {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
};

function makeQueryBuilder(terminal: TerminalShape) {
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
    in: rec("in"),
    gte: rec("gte"),
    lte: rec("lte"),
    order: rec("order"),
    range: (from: number, to: number) => {
      calls.push({ method: "range", args: [from, to] });
      return resolved;
    },
    maybeSingle: () => {
      calls.push({ method: "maybeSingle", args: [] });
      return resolved;
    },
  };

  // Some reads terminate at `.eq()` (the bulk pre-fetch). Make the builder
  // awaitable so those cases resolve to the programmed shape. Supabase's
  // real PostgrestBuilder is itself a thenable, so this mirrors reality;
  // the Biome rule against `then` on plain objects does not apply to an
  // intentional thenable like this.
  // biome-ignore lint/suspicious/noThenProperty: Supabase PostgrestBuilder is a thenable by design
  builder.then = resolved.then.bind(resolved);

  return { builder, calls };
}

describe("listOrderHolds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("returns paginated on_hold rows and computes per-reason grouping", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: [
        {
          id: "o-1",
          workspace_id: "ws-1",
          connection_id: "c-1",
          external_order_id: "ext-1",
          order_number: "1001",
          fulfillment_hold: "on_hold",
          fulfillment_hold_reason: "unknown_remote_sku",
          fulfillment_hold_at: "2026-04-26T10:00:00Z",
          fulfillment_hold_cycle_id: "cycle-1",
          fulfillment_hold_metadata: {},
          fulfillment_hold_client_alerted_at: null,
          created_at: "2026-04-26T09:00:00Z",
        },
        {
          id: "o-2",
          workspace_id: "ws-1",
          connection_id: "c-1",
          external_order_id: "ext-2",
          order_number: "1002",
          fulfillment_hold: "on_hold",
          fulfillment_hold_reason: "unknown_remote_sku",
          fulfillment_hold_at: "2026-04-26T09:30:00Z",
          fulfillment_hold_cycle_id: "cycle-2",
          fulfillment_hold_metadata: {},
          fulfillment_hold_client_alerted_at: null,
          created_at: "2026-04-26T09:00:00Z",
        },
        {
          id: "o-3",
          workspace_id: "ws-1",
          connection_id: "c-2",
          external_order_id: "ext-3",
          order_number: "1003",
          fulfillment_hold: "on_hold",
          fulfillment_hold_reason: "placeholder_remote_sku",
          fulfillment_hold_at: "2026-04-26T09:15:00Z",
          fulfillment_hold_cycle_id: "cycle-3",
          fulfillment_hold_metadata: {},
          fulfillment_hold_client_alerted_at: null,
          created_at: "2026-04-26T09:00:00Z",
        },
      ],
      count: 3,
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);

    const result = await listOrderHolds({
      reason: "unknown_remote_sku",
      connectionId: "8eb6eccc-2bcb-4d8f-8e21-8ee27d6d7e10",
      limit: 10,
      offset: 0,
    });

    expect(requireStaff).toHaveBeenCalledOnce();
    expect(mockFrom).toHaveBeenCalledWith("warehouse_orders");

    const expectedEqCalls = [
      ["workspace_id", "ws-1"],
      ["fulfillment_hold", "on_hold"],
      ["fulfillment_hold_reason", "unknown_remote_sku"],
      ["connection_id", "8eb6eccc-2bcb-4d8f-8e21-8ee27d6d7e10"],
    ];
    for (const args of expectedEqCalls) {
      expect(
        calls.find((c) => c.method === "eq" && JSON.stringify(c.args) === JSON.stringify(args)),
      ).toBeTruthy();
    }
    expect(calls.find((c) => c.method === "range")).toMatchObject({ args: [0, 9] });

    expect(result.rows).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.groupedByReason).toEqual({
      unknown_remote_sku: 2,
      placeholder_remote_sku: 1,
    });
  });

  it("requires staff to call", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("Staff access required"));
    await expect(listOrderHolds()).rejects.toThrow(/Staff access required/);
  });

  it("caps limit at 200", async () => {
    await expect(listOrderHolds({ limit: 500 })).rejects.toThrow();
  });

  it("propagates Supabase errors", async () => {
    const { builder } = makeQueryBuilder({ data: null, count: 0, error: { message: "db-boom" } });
    mockFrom.mockReturnValueOnce(builder);
    await expect(listOrderHolds()).rejects.toThrow(/listOrderHolds failed: db-boom/);
  });
});

describe("releaseOrderHold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("rejects out-of-workspace orders without calling the RPC", async () => {
    const { builder } = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(builder);

    const result = await releaseOrderHold({
      orderId: "11111111-1111-4111-8111-111111111111",
      resolutionCode: "alias_learned",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("order_not_in_workspace");
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects orders not in on_hold state without calling the RPC", async () => {
    const { builder } = makeQueryBuilder({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        workspace_id: "ws-1",
        fulfillment_hold: "released",
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);

    const result = await releaseOrderHold({
      orderId: "22222222-2222-4222-8222-222222222222",
      resolutionCode: "alias_learned",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("order_not_on_hold");
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls release_order_fulfillment_hold and returns the event id", async () => {
    const { builder } = makeQueryBuilder({
      data: {
        id: "33333333-3333-4333-8333-333333333333",
        workspace_id: "ws-1",
        fulfillment_hold: "on_hold",
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);
    mockRpc.mockResolvedValueOnce({ data: "event-42", error: null });

    const result = await releaseOrderHold({
      orderId: "33333333-3333-4333-8333-333333333333",
      resolutionCode: "alias_learned",
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "release_order_fulfillment_hold",
      expect.objectContaining({
        p_order_id: "33333333-3333-4333-8333-333333333333",
        p_resolution_code: "alias_learned",
        p_actor_kind: "user",
        p_actor_id: "user-1",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.holdEventId).toBe("event-42");
    }
  });

  it("rejects staff_override without a note", async () => {
    await expect(
      releaseOrderHold({
        orderId: "44444444-4444-4444-8444-444444444444",
        resolutionCode: "staff_override",
        note: "   ",
      }),
    ).rejects.toThrow();
  });

  it("accepts staff_override with a non-empty note", async () => {
    const { builder } = makeQueryBuilder({
      data: {
        id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "ws-1",
        fulfillment_hold: "on_hold",
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);
    mockRpc.mockResolvedValueOnce({ data: "event-51", error: null });

    const result = await releaseOrderHold({
      orderId: "55555555-5555-4555-8555-555555555555",
      resolutionCode: "staff_override",
      note: "manual: customer confirmed address",
    });

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith(
      "release_order_fulfillment_hold",
      expect.objectContaining({
        p_resolution_code: "staff_override",
        p_note: "manual: customer confirmed address",
      }),
    );
  });

  it("propagates RPC errors as typed reasons", async () => {
    const { builder } = makeQueryBuilder({
      data: {
        id: "66666666-6666-4666-8666-666666666666",
        workspace_id: "ws-1",
        fulfillment_hold: "on_hold",
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "invalid resolution_code: ???" },
    });

    const result = await releaseOrderHold({
      orderId: "66666666-6666-4666-8666-666666666666",
      resolutionCode: "alias_learned",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_resolution_code");
    }
  });
});

describe("releaseOrderHoldsBulk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("filters out out-of-workspace + non-on-hold rows and processes the rest sequentially", async () => {
    // Pre-fetch returns only 2 of the 3 requested orders (one is out-of-workspace),
    // and the one returned has fulfillment_hold='released'.
    const { builder: prefetch } = makeQueryBuilder({
      data: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspace_id: "ws-1",
          fulfillment_hold: "on_hold",
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          workspace_id: "ws-1",
          fulfillment_hold: "released",
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(prefetch);
    mockRpc.mockResolvedValueOnce({ data: "event-bulk-1", error: null });

    const result = await releaseOrderHoldsBulk({
      orderIds: [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ],
      resolutionCode: "alias_learned",
    });

    expect(result.succeeded).toEqual([
      {
        orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        holdEventId: "event-bulk-1",
        idempotent: false,
      },
    ]);
    expect(result.failed).toHaveLength(2);
    const failedA = result.failed.find((r) => r.orderId === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const failedB = result.failed.find((r) => r.orderId === "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(failedA?.reason).toBe("order_not_on_hold");
    expect(failedB?.reason).toBe("order_not_in_workspace");

    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("rejects staff_override bulk call without a note", async () => {
    await expect(
      releaseOrderHoldsBulk({
        orderIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        resolutionCode: "staff_override",
      }),
    ).rejects.toThrow();
  });

  it("caps orderIds at 100", async () => {
    const manyIds = Array.from(
      { length: 101 },
      (_, i) => `1${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`,
    );
    await expect(
      releaseOrderHoldsBulk({
        orderIds: manyIds,
        resolutionCode: "alias_learned",
      }),
    ).rejects.toThrow();
  });

  it("throws if the pre-fetch read fails", async () => {
    const { builder: prefetch } = makeQueryBuilder({
      data: null,
      error: { message: "prefetch-boom" },
    });
    mockFrom.mockReturnValueOnce(prefetch);

    await expect(
      releaseOrderHoldsBulk({
        orderIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        resolutionCode: "alias_learned",
      }),
    ).rejects.toThrow(/releaseOrderHoldsBulk read failed: prefetch-boom/);
  });

  it("routes RPC failures into the `failed` bucket without aborting the loop", async () => {
    const { builder: prefetch } = makeQueryBuilder({
      data: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspace_id: "ws-1",
          fulfillment_hold: "on_hold",
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          workspace_id: "ws-1",
          fulfillment_hold: "on_hold",
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(prefetch);

    // First RPC succeeds, second fails.
    mockRpc.mockResolvedValueOnce({ data: "event-A", error: null }).mockResolvedValueOnce({
      data: null,
      error: { message: "cannot release: order not on hold" },
    });

    const result = await releaseOrderHoldsBulk({
      orderIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      resolutionCode: "alias_learned",
    });

    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toBe("order_not_on_hold");
  });
});
