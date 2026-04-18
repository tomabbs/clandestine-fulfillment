import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const mockRequireStaff = vi.fn(async () => ({ userId: "user-1", workspaceId: "ws-1" }));
const mockCreateInventoryLocation = vi.fn();
const mockUpdateInventoryLocation = vi.fn();
const mockListInventoryLocations = vi.fn();
const mockTasksTrigger = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: () => mockRequireStaff(),
}));

vi.mock("@/lib/clients/shipstation-inventory-v2", () => ({
  createInventoryLocation: (...args: unknown[]) => mockCreateInventoryLocation(...args),
  updateInventoryLocation: (...args: unknown[]) => mockUpdateInventoryLocation(...args),
  listInventoryLocations: (...args: unknown[]) => mockListInventoryLocations(...args),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: (...args: unknown[]) => mockTasksTrigger(...args) },
}));

// ─── Supabase mock harness (per-table primed responses) ─────────────────────

type ChainResponse = { data?: unknown; error?: unknown; count?: number };

interface TableState {
  selectResponse?: ChainResponse;
  insertResponse?: ChainResponse;
  updateResponse?: ChainResponse;
  countResponse?: ChainResponse;
}

const tableState: Record<string, TableState> = {};
const updateCalls: Array<{ table: string; payload: unknown }> = [];
const insertCalls: Array<{ table: string; payload: unknown }> = [];

function makeChain(table: string, mode: "select" | "insert" | "update" | "count") {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  const respond = (key: keyof TableState, fallback: ChainResponse): ChainResponse =>
    tableState[table]?.[key] ?? fallback;
  const terminal = (): Promise<ChainResponse> => {
    if (mode === "insert")
      return Promise.resolve(respond("insertResponse", { data: null, error: null }));
    if (mode === "update")
      return Promise.resolve(respond("updateResponse", { data: null, error: null }));
    if (mode === "count")
      return Promise.resolve(respond("countResponse", { count: 0, error: null }));
    return Promise.resolve(respond("selectResponse", { data: null, error: null }));
  };
  chain.select = (_cols?: string, _opts?: { count?: string; head?: boolean }) => {
    if (_opts?.count === "exact" && _opts?.head === true) {
      // .select(_, { count: "exact", head: true }) is itself a terminal-ish
      // call when followed by .eq().gt(); we route through count mode via .gt()
      return chainCount();
    }
    return chain;
  };
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return chain;
  };
  chain.ilike = (_col: string, _pat: string) => chain;
  chain.gte = (col: string, val: unknown) => {
    filters[`${col}_gte`] = val;
    return chain;
  };
  chain.gt = (col: string, val: unknown) => {
    filters[`${col}_gt`] = val;
    return chain;
  };
  chain.order = (_col: string) => chain;
  chain.maybeSingle = () => terminal();
  chain.single = () => terminal();
  // biome-ignore lint/suspicious/noThenProperty: Supabase client builder is an intentional thenable
  (chain as { then?: unknown }).then = (
    onFulfilled: (v: ChainResponse) => unknown,
    onRejected?: (err: unknown) => unknown,
  ) => terminal().then(onFulfilled, onRejected);

  function chainCount() {
    const c: Record<string, unknown> = {};
    c.eq = (_col: string, _val: unknown) => c;
    c.gt = (_col: string, _val: unknown) => c;
    // biome-ignore lint/suspicious/noThenProperty: Supabase client builder is an intentional thenable
    c.then = (onFulfilled: (v: ChainResponse) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(respond("countResponse", { count: 0, error: null })).then(
        onFulfilled,
        onRejected,
      );
    return c;
  }

  return chain;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => ({
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
        const chain = makeChain(table, opts?.count === "exact" ? "count" : "select") as Record<
          string,
          unknown
        > & {
          select: (c?: string, o?: { count?: string; head?: boolean }) => unknown;
        };
        return chain.select(cols, opts);
      },
      insert: (payload: unknown) => {
        insertCalls.push({ table, payload });
        return makeChain(table, "insert");
      },
      update: (payload: unknown) => {
        updateCalls.push({ table, payload });
        return makeChain(table, "update");
      },
    }),
  }),
  createServiceRoleClient: () => ({}),
}));

import {
  createLocation,
  createLocationRange,
  deactivateLocation,
  retryShipstationLocationSync,
  updateLocation,
} from "@/actions/locations";

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(tableState)) delete tableState[k];
  updateCalls.length = 0;
  insertCalls.length = 0;
});

// ─── createLocation ─────────────────────────────────────────────────────────

describe("createLocation", () => {
  it("inserts local + mirrors to ShipStation v2 (happy path)", async () => {
    tableState.warehouse_locations = {
      insertResponse: {
        data: {
          id: "loc-1",
          workspace_id: "ws-1",
          name: "A-1",
          barcode: null,
          location_type: "shelf",
          is_active: true,
          shipstation_inventory_location_id: null,
          shipstation_synced_at: null,
          shipstation_sync_error: null,
          created_at: "2026-04-18T10:00:00Z",
        },
        error: null,
      },
    };
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: "wh-1" }, error: null },
    };
    mockCreateInventoryLocation.mockResolvedValueOnce({
      inventory_location_id: "ss-loc-1",
      inventory_warehouse_id: "wh-1",
      name: "A-1",
    });

    const result = await createLocation({ name: "A-1", locationType: "shelf" });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.row.shipstation_inventory_location_id).toBe("ss-loc-1");

    expect(mockCreateInventoryLocation).toHaveBeenCalledWith({
      inventory_warehouse_id: "wh-1",
      name: "A-1",
    });
  });

  it("returns no_v2_warehouse_configured when workspace lacks the v2 warehouse id", async () => {
    tableState.warehouse_locations = {
      insertResponse: {
        data: {
          id: "loc-1",
          workspace_id: "ws-1",
          name: "B-1",
          barcode: null,
          location_type: "bin",
          is_active: true,
          shipstation_inventory_location_id: null,
          shipstation_synced_at: null,
          shipstation_sync_error: null,
          created_at: "2026-04-18T10:00:00Z",
        },
        error: null,
      },
    };
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: null }, error: null },
    };

    const result = await createLocation({ name: "B-1", locationType: "bin" });
    expect(result.ok).toBe(true);
    expect(result.warning).toBe("no_v2_warehouse_configured");
    expect(mockCreateInventoryLocation).not.toHaveBeenCalled();
  });

  it("on 409 conflict resolves to existing ShipStation location id (R-22)", async () => {
    tableState.warehouse_locations = {
      insertResponse: {
        data: {
          id: "loc-1",
          workspace_id: "ws-1",
          name: "DUP",
          barcode: null,
          location_type: "shelf",
          is_active: true,
          shipstation_inventory_location_id: null,
          shipstation_synced_at: null,
          shipstation_sync_error: null,
          created_at: "2026-04-18T10:00:00Z",
        },
        error: null,
      },
    };
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: "wh-1" }, error: null },
    };
    mockCreateInventoryLocation.mockRejectedValueOnce(
      new Error("ShipStation v2 409 /v2/inventory_locations: name already exists"),
    );
    mockListInventoryLocations.mockResolvedValueOnce([
      { inventory_location_id: "ss-existing", inventory_warehouse_id: "wh-1", name: "DUP" },
    ]);

    const result = await createLocation({ name: "DUP", locationType: "shelf" });
    expect(result.warning).toBe("shipstation_mirror_resolved_existing");
    expect(result.row.shipstation_inventory_location_id).toBe("ss-existing");
  });

  it("on non-409 mirror failure stores error and returns shipstation_mirror_failed", async () => {
    tableState.warehouse_locations = {
      insertResponse: {
        data: {
          id: "loc-1",
          workspace_id: "ws-1",
          name: "C-1",
          barcode: null,
          location_type: "bin",
          is_active: true,
          shipstation_inventory_location_id: null,
          shipstation_synced_at: null,
          shipstation_sync_error: null,
          created_at: "2026-04-18T10:00:00Z",
        },
        error: null,
      },
    };
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: "wh-1" }, error: null },
    };
    mockCreateInventoryLocation.mockRejectedValueOnce(new Error("ShipStation v2 502 upstream"));

    const result = await createLocation({ name: "C-1", locationType: "bin" });
    expect(result.warning).toBe("shipstation_mirror_failed");
    expect(result.error).toMatch(/502/);

    const errorUpdate = updateCalls.find(
      (c) =>
        c.table === "warehouse_locations" &&
        (c.payload as Record<string, unknown>).shipstation_sync_error,
    );
    expect(errorUpdate).toBeDefined();
  });

  it("rejects unknown location_type at the boundary", async () => {
    await expect(
      createLocation({ name: "X-1", locationType: "freezer" as unknown as string }),
    ).rejects.toThrow(/INVALID_LOCATION_TYPE/);
    expect(insertCalls.length).toBe(0);
  });

  it("translates Postgres unique-violation 23505 to LOCATION_ALREADY_EXISTS", async () => {
    tableState.warehouse_locations = {
      insertResponse: {
        data: null,
        error: { code: "23505", message: "duplicate" },
      },
    };
    await expect(createLocation({ name: "A-1", locationType: "shelf" })).rejects.toThrow(
      "LOCATION_ALREADY_EXISTS",
    );
  });
});

// ─── createLocationRange ────────────────────────────────────────────────────

describe("createLocationRange", () => {
  it("size > 30 routes to bulk-create-locations Trigger task and returns task run id", async () => {
    mockTasksTrigger.mockResolvedValueOnce({ id: "run-bulk-1" });

    const result = await createLocationRange({
      prefix: "A-",
      fromIndex: 1,
      toIndex: 50,
      locationType: "shelf",
    });

    expect(result.mode).toBe("trigger");
    if (result.mode === "trigger") {
      expect(result.taskRunId).toBe("run-bulk-1");
      expect(result.size).toBe(50);
    }
    expect(mockTasksTrigger).toHaveBeenCalledWith(
      "bulk-create-locations",
      expect.objectContaining({
        workspaceId: "ws-1",
        actorUserId: "user-1",
        prefix: "A-",
        fromIndex: 1,
        toIndex: 50,
        locationType: "shelf",
        throttleMs: 300,
      }),
    );
  });

  it("size === 30 stays inline (boundary lower)", async () => {
    // For inline path, createLocation is called per iteration. To avoid
    // setting up 30 successful primings we mock by making insertResponse
    // a thunk-equivalent: the mock harness re-reads tableState every call.
    let insertCount = 0;
    tableState.warehouse_locations = {
      get insertResponse() {
        insertCount++;
        return {
          data: {
            id: `loc-${insertCount}`,
            workspace_id: "ws-1",
            name: `A-${insertCount}`,
            barcode: null,
            location_type: "shelf",
            is_active: true,
            shipstation_inventory_location_id: null,
            shipstation_synced_at: null,
            shipstation_sync_error: null,
            created_at: "2026-04-18T10:00:00Z",
          },
          error: null,
        };
      },
    } as TableState;
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: null }, error: null },
    };

    const result = await createLocationRange({
      prefix: "A-",
      fromIndex: 1,
      toIndex: 30,
      locationType: "shelf",
      throttleMs: 0, // skip the 300ms sleep for test speed
    });

    expect(result.mode).toBe("inline");
    if (result.mode === "inline") {
      expect(result.size).toBe(30);
      expect(result.results).toHaveLength(30);
    }
    expect(mockTasksTrigger).not.toHaveBeenCalled();
  });

  it("rejects empty range", async () => {
    await expect(
      createLocationRange({ prefix: "A-", fromIndex: 5, toIndex: 4, locationType: "shelf" }),
    ).rejects.toThrow("EMPTY_RANGE");
  });
});

// ─── updateLocation ─────────────────────────────────────────────────────────

describe("updateLocation", () => {
  it("rename WITH mirror calls ShipStation FIRST (v4 hardening); local row stays unchanged on v2 failure", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { id: "loc-1", name: "OLD", shipstation_inventory_location_id: "ss-loc-1" },
        error: null,
      },
    };
    mockUpdateInventoryLocation.mockRejectedValueOnce(new Error("ShipStation v2 502 upstream"));

    const result = await updateLocation("loc-1", { name: "NEW" });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe("shipstation_mirror_failed");

    // No local rename should have been issued — but a sync_error stamp is OK.
    const renameUpdate = updateCalls.find(
      (c) =>
        c.table === "warehouse_locations" && (c.payload as Record<string, unknown>).name === "NEW",
    );
    expect(renameUpdate).toBeUndefined();
    const errStamp = updateCalls.find(
      (c) =>
        c.table === "warehouse_locations" &&
        (c.payload as Record<string, unknown>).shipstation_sync_error,
    );
    expect(errStamp).toBeDefined();
  });

  it("rename WITH mirror succeeds → local update fires with synced_at + cleared error", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { id: "loc-1", name: "OLD", shipstation_inventory_location_id: "ss-loc-1" },
        error: null,
      },
      updateResponse: { data: null, error: null },
    };
    mockUpdateInventoryLocation.mockResolvedValueOnce({
      inventory_location_id: "ss-loc-1",
      inventory_warehouse_id: "wh-1",
      name: "NEW",
    });

    const result = await updateLocation("loc-1", { name: "NEW" });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeNull();
    const renameUpdate = updateCalls.find(
      (c) =>
        c.table === "warehouse_locations" && (c.payload as Record<string, unknown>).name === "NEW",
    );
    expect(renameUpdate).toBeDefined();
    expect((renameUpdate?.payload as Record<string, unknown>).shipstation_sync_error).toBeNull();
  });

  it("rename WITHOUT mirror skips ShipStation call entirely", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { id: "loc-1", name: "OLD", shipstation_inventory_location_id: null },
        error: null,
      },
      updateResponse: { data: null, error: null },
    };
    const result = await updateLocation("loc-1", { name: "NEW" });
    expect(result.ok).toBe(true);
    expect(mockUpdateInventoryLocation).not.toHaveBeenCalled();
  });

  it("returns no_changes when patch is empty", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { id: "loc-1", name: "OLD", shipstation_inventory_location_id: null },
        error: null,
      },
    };
    const result = await updateLocation("loc-1", {});
    expect(result.warning).toBe("no_changes");
  });
});

// ─── deactivateLocation ─────────────────────────────────────────────────────

describe("deactivateLocation", () => {
  it("blocks deactivation when any per-location row has positive quantity", async () => {
    tableState.warehouse_locations = {
      selectResponse: { data: { id: "loc-1" }, error: null },
    };
    tableState.warehouse_variant_locations = {
      countResponse: { count: 3, error: null },
    };

    await expect(deactivateLocation("loc-1")).rejects.toThrow("LOCATION_HAS_INVENTORY");
  });

  it("flips is_active=false when no positive quantity rows reference it", async () => {
    tableState.warehouse_locations = {
      selectResponse: { data: { id: "loc-1" }, error: null },
      updateResponse: { data: null, error: null },
    };
    tableState.warehouse_variant_locations = {
      countResponse: { count: 0, error: null },
    };
    const result = await deactivateLocation("loc-1");
    expect(result.ok).toBe(true);
    const flip = updateCalls.find(
      (c) =>
        c.table === "warehouse_locations" &&
        (c.payload as Record<string, unknown>).is_active === false,
    );
    expect(flip).toBeDefined();
  });
});

// ─── retryShipstationLocationSync ───────────────────────────────────────────

describe("retryShipstationLocationSync", () => {
  it("returns alreadySynced when row already has a ShipStation id", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { name: "A-1", shipstation_inventory_location_id: "ss-loc-1" },
        error: null,
      },
    };
    const result = await retryShipstationLocationSync("loc-1");
    expect(result.ok).toBe(true);
    expect(result.alreadySynced).toBe(true);
    expect(mockCreateInventoryLocation).not.toHaveBeenCalled();
  });

  it("creates the missing mirror and clears any prior sync_error", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { name: "A-1", shipstation_inventory_location_id: null },
        error: null,
      },
      updateResponse: { data: null, error: null },
    };
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: "wh-1" }, error: null },
    };
    mockCreateInventoryLocation.mockResolvedValueOnce({
      inventory_location_id: "ss-loc-new",
      inventory_warehouse_id: "wh-1",
      name: "A-1",
    });

    const result = await retryShipstationLocationSync("loc-1");
    expect(result.ok).toBe(true);
    expect(result.alreadySynced).toBe(false);
    const stamp = updateCalls.find(
      (c) =>
        c.table === "warehouse_locations" &&
        (c.payload as Record<string, unknown>).shipstation_inventory_location_id === "ss-loc-new",
    );
    expect(stamp).toBeDefined();
    expect((stamp?.payload as Record<string, unknown>).shipstation_sync_error).toBeNull();
  });

  it("on 409 conflict resolves to existing ShipStation id via list lookup", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { name: "DUP", shipstation_inventory_location_id: null },
        error: null,
      },
      updateResponse: { data: null, error: null },
    };
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: "wh-1" }, error: null },
    };
    mockCreateInventoryLocation.mockRejectedValueOnce(
      new Error("ShipStation v2 409 /v2/inventory_locations: name already exists"),
    );
    mockListInventoryLocations.mockResolvedValueOnce([
      { inventory_location_id: "ss-existing", inventory_warehouse_id: "wh-1", name: "DUP" },
    ]);

    const result = await retryShipstationLocationSync("loc-1");
    expect(result.ok).toBe(true);
    expect(result.alreadySynced).toBe(false);
    const stamp = updateCalls.find(
      (c) =>
        c.table === "warehouse_locations" &&
        (c.payload as Record<string, unknown>).shipstation_inventory_location_id === "ss-existing",
    );
    expect(stamp).toBeDefined();
  });

  it("throws NO_V2_WAREHOUSE when workspace lacks the v2 warehouse id", async () => {
    tableState.warehouse_locations = {
      selectResponse: {
        data: { name: "A-1", shipstation_inventory_location_id: null },
        error: null,
      },
    };
    tableState.workspaces = {
      selectResponse: { data: { shipstation_v2_inventory_warehouse_id: null }, error: null },
    };
    await expect(retryShipstationLocationSync("loc-1")).rejects.toThrow("NO_V2_WAREHOUSE");
  });
});
