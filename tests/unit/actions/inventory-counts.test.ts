import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock setup — vi.mock factories run before module imports.
const mockRequireStaff = vi.fn(async () => ({ userId: "user-1", workspaceId: "ws-1" }));
const mockRecordInventoryChange = vi.fn(async (_args: Record<string, unknown>) => ({
  success: true as boolean,
  newQuantity: 0 as number | null,
  alreadyProcessed: false,
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: () => mockRequireStaff(),
}));

vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: (args: Record<string, unknown>) => mockRecordInventoryChange(args),
}));

// ─── Supabase mock harness ──────────────────────────────────────────────────
//
// Each describe primes `tableState[table]` with the per-table response shape
// the code path expects. The chain object eats `.select/.eq/.gte/.maybeSingle`
// calls and resolves with the primed shape on the terminal method.

type ChainResponse = { data: unknown; error: unknown };

interface TableState {
  selectResponse?: ChainResponse;
  updateResponse?: ChainResponse;
  upsertResponse?: ChainResponse;
  deleteResponse?: ChainResponse;
}

const tableState: Record<string, TableState> = {};
const updateCalls: Array<{ table: string; payload: unknown }> = [];
const upsertCalls: Array<{ table: string; payload: unknown; conflict: unknown }> = [];
const deleteCalls: Array<{ table: string; filters: Record<string, unknown> }> = [];

function makeChain(table: string, mode: "select" | "update" | "upsert" | "delete") {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  const respond = (key: keyof TableState, fallback: ChainResponse): ChainResponse => {
    return tableState[table]?.[key] ?? fallback;
  };
  const terminal = (): Promise<ChainResponse> => {
    if (mode === "update") {
      return Promise.resolve(respond("updateResponse", { data: { ok: true }, error: null }));
    }
    if (mode === "upsert") {
      return Promise.resolve(respond("upsertResponse", { data: null, error: null }));
    }
    if (mode === "delete") {
      deleteCalls.push({ table, filters: { ...filters } });
      return Promise.resolve(respond("deleteResponse", { data: [], error: null }));
    }
    return Promise.resolve(respond("selectResponse", { data: null, error: null }));
  };
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return chain;
  };
  chain.gte = (col: string, val: unknown) => {
    filters[`${col}_gte`] = val;
    return chain;
  };
  chain.maybeSingle = () => terminal();
  chain.single = () => terminal();
  // delete().eq().select() returns the array on terminal — exposed via .then
  // biome-ignore lint/suspicious/noThenProperty: Supabase client builder is an intentional thenable
  (chain as { then?: unknown }).then = (
    onFulfilled: (v: ChainResponse) => unknown,
    onRejected?: (err: unknown) => unknown,
  ) => terminal().then(onFulfilled, onRejected);
  return chain;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => ({
      select: () => makeChain(table, "select"),
      update: (payload: unknown) => {
        updateCalls.push({ table, payload });
        return makeChain(table, "update");
      },
      upsert: (payload: unknown, options: unknown) => {
        upsertCalls.push({ table, payload, conflict: options });
        return makeChain(table, "upsert");
      },
      delete: () => makeChain(table, "delete"),
    }),
  }),
  createServiceRoleClient: () => ({}),
}));

import {
  cancelCountSession,
  completeCountSession,
  setVariantLocationQuantity,
  startCountSession,
} from "@/actions/inventory-counts";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(tableState)) delete tableState[k];
  updateCalls.length = 0;
  upsertCalls.length = 0;
  deleteCalls.length = 0;
  mockRecordInventoryChange.mockResolvedValue({
    success: true,
    newQuantity: 0,
    alreadyProcessed: false,
  });
});

// ─── startCountSession ──────────────────────────────────────────────────────

describe("startCountSession", () => {
  it("flips status to count_in_progress and snapshots baseline", async () => {
    let callCount = 0;
    tableState.warehouse_inventory_levels = {
      // `.select(...).eq(...).eq(...).maybeSingle()` is hit twice:
      //   call 1 = pre-read (available + count_status)
      //   call 2 = optimistic update returning row
      get selectResponse() {
        callCount++;
        return { data: { available: 42, count_status: "idle" }, error: null };
      },
      updateResponse: {
        data: { count_started_at: "2026-04-18T10:00:00Z", count_baseline_available: 42 },
        error: null,
      },
    } as TableState;

    const result = await startCountSession("SKU-COUNT");
    expect(result.ok).toBe(true);
    expect(result.baselineAvailable).toBe(42);
    expect(result.startedAt).toBe("2026-04-18T10:00:00Z");
    expect(callCount).toBeGreaterThanOrEqual(1);

    const updatePayload = updateCalls[0]?.payload as Record<string, unknown>;
    expect(updatePayload.count_status).toBe("count_in_progress");
    expect(updatePayload.count_started_by).toBe("user-1");
    expect(updatePayload.count_baseline_available).toBe(42);
  });

  it("throws ALREADY_IN_PROGRESS when pre-read already shows in-progress", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { available: 10, count_status: "count_in_progress" },
        error: null,
      },
    };
    tableState.warehouse_product_variants = {
      selectResponse: { data: { id: "v-1" }, error: null },
    };
    // getCountSessionState reads users join; provide a benign no-op
    tableState.warehouse_variant_locations = { selectResponse: { data: [], error: null } };

    await expect(startCountSession("SKU-X")).rejects.toThrow(/ALREADY_IN_PROGRESS/);
  });

  it("throws UNKNOWN_SKU when level row missing", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: { data: null, error: null },
    };
    await expect(startCountSession("SKU-MISSING")).rejects.toThrow("UNKNOWN_SKU");
  });
});

// ─── setVariantLocationQuantity — fanout suppression invariant ──────────────

describe("setVariantLocationQuantity", () => {
  beforeEach(() => {
    tableState.warehouse_product_variants = {
      selectResponse: { data: { id: "v-1" }, error: null },
    };
    tableState.warehouse_locations = {
      selectResponse: { data: { id: "loc-1" }, error: null },
    };
    tableState.warehouse_variant_locations = {
      // `select('quantity')` after upsert returns sum input rows
      selectResponse: { data: [{ quantity: 5 }, { quantity: 3 }], error: null },
      upsertResponse: { data: null, error: null },
    };
  });

  it("FANOUT-SUPPRESSED during count_in_progress: does NOT call recordInventoryChange", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_status: "count_in_progress", available: 99, has_per_location_data: true },
        error: null,
      },
    };

    const result = await setVariantLocationQuantity({
      sku: "SKU-X",
      locationId: "loc-1",
      quantity: 5,
    });

    expect(result.status).toBe("session_partial");
    if (result.status === "session_partial") {
      expect(result.sumOfLocations).toBe(8);
    }
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("idle path with non-zero delta routes through recordInventoryChange", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_status: "idle", available: 5, has_per_location_data: false },
        error: null,
      },
    };

    const result = await setVariantLocationQuantity({
      sku: "SKU-X",
      locationId: "loc-1",
      quantity: 5,
    });

    expect(result.status).toBe("fanned_out");
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    const call = mockRecordInventoryChange.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.source).toBe("manual_inventory_count");
    expect(call.delta).toBe(3); // sum (8) - old (5)
    expect(call.workspaceId).toBe("ws-1");
    expect(call.sku).toBe("SKU-X");
    expect(String(call.correlationId)).toMatch(/^loc-edit:loc-1:SKU-X:/);
  });

  it("idle path with zero delta returns no_change and skips recordInventoryChange", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_status: "idle", available: 8, has_per_location_data: true },
        error: null,
      },
    };

    const result = await setVariantLocationQuantity({
      sku: "SKU-X",
      locationId: "loc-1",
      quantity: 5,
    });

    expect(result.status).toBe("no_change");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("sticky has_per_location_data flips false→true on first non-zero write", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_status: "count_in_progress", available: 99, has_per_location_data: false },
        error: null,
      },
    };

    await setVariantLocationQuantity({ sku: "SKU-X", locationId: "loc-1", quantity: 7 });

    const flagUpdate = updateCalls.find(
      (c) =>
        c.table === "warehouse_inventory_levels" &&
        (c.payload as Record<string, unknown>).has_per_location_data === true,
    );
    expect(flagUpdate).toBeDefined();
  });

  it("does NOT flip the flag for a zero-quantity write", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_status: "count_in_progress", available: 99, has_per_location_data: false },
        error: null,
      },
    };

    await setVariantLocationQuantity({ sku: "SKU-X", locationId: "loc-1", quantity: 0 });

    const flagUpdate = updateCalls.find(
      (c) =>
        c.table === "warehouse_inventory_levels" &&
        (c.payload as Record<string, unknown>).has_per_location_data === true,
    );
    expect(flagUpdate).toBeUndefined();
  });

  it("rejects negative quantity at the boundary", async () => {
    await expect(
      setVariantLocationQuantity({ sku: "SKU-X", locationId: "loc-1", quantity: -1 }),
    ).rejects.toThrow("QUANTITY_INVALID");
  });

  it("rejects unknown location (defence in depth vs stale UI dropdown)", async () => {
    tableState.warehouse_locations = { selectResponse: { data: null, error: null } };
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_status: "idle", available: 5, has_per_location_data: false },
        error: null,
      },
    };
    await expect(
      setVariantLocationQuantity({ sku: "SKU-X", locationId: "loc-bad", quantity: 5 }),
    ).rejects.toThrow("UNKNOWN_LOCATION");
  });
});

// ─── completeCountSession — fanout-once invariant ───────────────────────────

describe("completeCountSession", () => {
  beforeEach(() => {
    tableState.warehouse_product_variants = {
      selectResponse: { data: { id: "v-1" }, error: null },
    };
    tableState.warehouse_variant_locations = {
      selectResponse: { data: [{ quantity: 4 }, { quantity: 4 }], error: null },
    };
  });

  it("Scenario A (count POST-sale): delta=0 => no recordInventoryChange call", async () => {
    // baseline=10, sale brought current to 8, staff counted bins summing to 8
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: {
          available: 8,
          count_status: "count_in_progress",
          count_started_at: "2026-04-18T10:00:00Z",
          count_baseline_available: 10,
        },
        error: null,
      },
    };

    const result = await completeCountSession("SKU-X");
    expect(result.delta).toBe(0);
    expect(result.fanoutEnqueued).toBe(false);
    expect(result.salesDuringSession).toBe(2);
    expect(result.formula).toBe("current_minus_sum");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("Non-zero delta routes through recordInventoryChange exactly ONCE with cycle_count source", async () => {
    // baseline=10, current=10 (no sale), sum=8 → delta=-2 (shrinkage)
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: {
          available: 10,
          count_status: "count_in_progress",
          count_started_at: "2026-04-18T10:00:00Z",
          count_baseline_available: 10,
        },
        error: null,
      },
    };

    const result = await completeCountSession("SKU-X");
    expect(result.delta).toBe(-2);
    expect(result.fanoutEnqueued).toBe(true);
    expect(result.salesDuringSession).toBe(0);

    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    const call = mockRecordInventoryChange.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.source).toBe("cycle_count");
    expect(call.delta).toBe(-2);
    expect(String(call.correlationId)).toBe("count-session:2026-04-18T10:00:00Z:SKU-X");
    const md = call.metadata as Record<string, unknown>;
    expect(md.formula_used).toBe("current_minus_sum");
    expect(md.sum_of_locations).toBe(8);
    expect(md.baseline_available).toBe(10);
    expect(md.current_available_at_complete).toBe(10);
  });

  it("throws NO_ACTIVE_SESSION when SKU is idle", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: {
          available: 8,
          count_status: "idle",
          count_started_at: null,
          count_baseline_available: null,
        },
        error: null,
      },
    };
    await expect(completeCountSession("SKU-X")).rejects.toThrow("NO_ACTIVE_SESSION");
  });

  it("throws when recordInventoryChange returns success: false", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: {
          available: 10,
          count_status: "count_in_progress",
          count_started_at: "2026-04-18T10:00:00Z",
          count_baseline_available: 10,
        },
        error: null,
      },
    };
    mockRecordInventoryChange.mockResolvedValueOnce({
      success: false,
      newQuantity: null,
      alreadyProcessed: false,
    });
    await expect(completeCountSession("SKU-X")).rejects.toThrow("RECORD_INVENTORY_CHANGE_FAILED");
  });
});

// ─── cancelCountSession ──────────────────────────────────────────────────────

describe("cancelCountSession", () => {
  beforeEach(() => {
    tableState.warehouse_product_variants = {
      selectResponse: { data: { id: "v-1" }, error: null },
    };
  });

  it("idempotent when session is already idle (no rollback, no recordInventoryChange)", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_started_at: null, count_status: "idle" },
        error: null,
      },
    };
    const result = await cancelCountSession("SKU-X", { rollbackLocationEntries: true });
    expect(result.alreadyIdle).toBe(true);
    expect(deleteCalls.length).toBe(0);
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("rollbackLocationEntries=true issues a delete scoped to >= count_started_at", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_started_at: "2026-04-18T10:00:00Z", count_status: "count_in_progress" },
        error: null,
      },
    };
    tableState.warehouse_variant_locations = {
      deleteResponse: { data: [{ id: "vl-1" }, { id: "vl-2" }], error: null },
    };
    const result = await cancelCountSession("SKU-X", { rollbackLocationEntries: true });
    expect(result.alreadyIdle).toBe(false);
    expect(result.rolledBackRows).toBe(2);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.table).toBe("warehouse_variant_locations");
    expect(deleteCalls[0]?.filters.updated_at_gte).toBe("2026-04-18T10:00:00Z");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("rollbackLocationEntries=false skips the delete but still flips status to idle", async () => {
    tableState.warehouse_inventory_levels = {
      selectResponse: {
        data: { count_started_at: "2026-04-18T10:00:00Z", count_status: "count_in_progress" },
        error: null,
      },
    };
    const result = await cancelCountSession("SKU-X", { rollbackLocationEntries: false });
    expect(result.alreadyIdle).toBe(false);
    expect(result.rolledBackRows).toBe(0);
    expect(deleteCalls.length).toBe(0);

    const clear = updateCalls.find(
      (c) =>
        c.table === "warehouse_inventory_levels" &&
        (c.payload as Record<string, unknown>).count_status === "idle",
    );
    expect(clear).toBeDefined();
  });
});
