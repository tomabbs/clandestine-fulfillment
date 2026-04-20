// Phase 9 — bulk-orders server-action unit tests.
//
// Focus: caps, success accounting, partial-failure surfacing, and the
// v1_features_enabled gate. We mock supabase + the ShipStation client so
// these run hermetically; integration coverage for the actual SS round-trip
// stays in scripts/shipstation-precheck.ts and the prod cron.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tagCalls, holdCalls, dbState, flagsState } = vi.hoisted(() => ({
  tagCalls: { add: [] as Array<[number, number]>, remove: [] as Array<[number, number]> },
  holdCalls: [] as Array<[number, string]>,
  dbState: {
    shipstation_orders: [] as Array<Record<string, unknown>>,
    sensor_readings: [] as Array<Record<string, unknown>>,
  },
  flagsState: { v1_features_enabled: true } as Record<string, unknown>,
}));

vi.mock("@/lib/clients/shipstation", () => ({
  addOrderTag: vi.fn(async (orderId: number, tagId: number) => {
    tagCalls.add.push([orderId, tagId]);
    return { ok: true };
  }),
  removeOrderTag: vi.fn(async (orderId: number, tagId: number) => {
    tagCalls.remove.push([orderId, tagId]);
    return { ok: true };
  }),
  holdOrderUntil: vi.fn(async (orderId: number, date: string) => {
    holdCalls.push([orderId, date]);
    return { ok: true };
  }),
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: async () => ({ workspaceId: "ws_1", userId: "user_1" }),
}));

vi.mock("@/lib/server/workspace-flags", () => ({
  getWorkspaceFlags: async () => flagsState,
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn().mockResolvedValue({ id: "run_1" }) },
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => makeMockClient(),
}));

function makeMockClient() {
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      let _ins: unknown = null;
      let _upd: Record<string, unknown> | null = null;
      let _vals: readonly unknown[] | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        single: async () => {
          if (table === "print_batch_jobs" && _ins) {
            const row = { id: "batch_1", ..._ins as object };
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        eq: (col: string, val: unknown) => {
          eqs.push([col, val]);
          return builder;
        },
        in: (_col: string, vals: readonly unknown[]) => {
          _vals = vals;
          return builder;
        },
        update: (payload: Record<string, unknown>, _opts?: unknown) => {
          _upd = payload;
          return builder;
        },
        insert: (payload: unknown) => {
          _ins = payload;
          if (table === "sensor_readings") {
            dbState.sensor_readings.push(payload as Record<string, unknown>);
          }
          return builder;
        },
        then(onFulfilled: (v: unknown) => unknown) {
          if (table === "shipstation_orders") {
            const matches = dbState.shipstation_orders.filter(
              (r) =>
                (_vals == null || _vals.includes(r.id)) &&
                eqs.every(([col, val]) => r[col] === val),
            );
            if (_upd) {
              for (const r of matches) Object.assign(r, _upd);
              return Promise.resolve({ data: null, error: null, count: matches.length }).then(
                onFulfilled,
              );
            }
            return Promise.resolve({ data: matches, error: null }).then(onFulfilled);
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

import {
  assignOrders,
  bulkAddOrdersTag,
  bulkBuyLabels,
  bulkRemoveOrdersTag,
  bulkSetOrdersHoldUntil,
} from "@/actions/bulk-orders";

beforeEach(() => {
  tagCalls.add.length = 0;
  tagCalls.remove.length = 0;
  holdCalls.length = 0;
  dbState.shipstation_orders.length = 0;
  dbState.sensor_readings.length = 0;
  flagsState.v1_features_enabled = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("assignOrders (Phase 9.3)", () => {
  it("rejects empty input", async () => {
    await expect(assignOrders({ shipstationOrderUuids: [], assignedUserId: null })).rejects.toThrow(
      /no order ids/,
    );
  });

  it("clears assignment when assignedUserId=null", async () => {
    dbState.shipstation_orders.push({
      id: "o1",
      workspace_id: "ws_1",
      assigned_user_id: "u_x",
      assigned_at: "2026-01-01",
    });
    const r = await assignOrders({
      shipstationOrderUuids: ["o1"],
      assignedUserId: null,
    });
    expect(r.updated).toBe(1);
    expect(dbState.shipstation_orders[0]?.assigned_user_id).toBeNull();
    expect(dbState.shipstation_orders[0]?.assigned_at).toBeNull();
    // Audit-trail sensor reading written
    const audit = dbState.sensor_readings.find((s) => s.sensor_name === "cockpit.bulk_assign");
    expect(audit).toBeDefined();
  });

  it("sets assignment to a specific user", async () => {
    dbState.shipstation_orders.push(
      { id: "o1", workspace_id: "ws_1" },
      { id: "o2", workspace_id: "ws_1" },
    );
    const r = await assignOrders({
      shipstationOrderUuids: ["o1", "o2"],
      assignedUserId: "u_alice",
    });
    expect(r.updated).toBe(2);
    expect(dbState.shipstation_orders[0]?.assigned_user_id).toBe("u_alice");
  });
});

describe("bulkAddOrdersTag / bulkRemoveOrdersTag (Phase 9.5)", () => {
  it("throws when v1_features_enabled is false", async () => {
    flagsState.v1_features_enabled = false;
    await expect(
      bulkAddOrdersTag({ shipstationOrderUuids: ["o1"], tagId: 1 }),
    ).rejects.toThrow(/v1_features_enabled/);
  });

  it("calls SS once per order needing the tag and updates local tag_ids", async () => {
    dbState.shipstation_orders.push(
      { id: "o1", workspace_id: "ws_1", shipstation_order_id: 100, tag_ids: [] },
      { id: "o2", workspace_id: "ws_1", shipstation_order_id: 200, tag_ids: [42] },
      { id: "o3", workspace_id: "ws_1", shipstation_order_id: 300, tag_ids: [] },
    );
    const r = await bulkAddOrdersTag({
      shipstationOrderUuids: ["o1", "o2", "o3"],
      tagId: 42,
    });
    expect(r.succeeded).toBe(3);
    // o2 already had tag 42 → idempotent, no SS call
    expect(tagCalls.add.length).toBe(2);
    expect(tagCalls.add.map(([oid]) => oid).sort()).toEqual([100, 300]);
    // Local tag_ids updated
    expect(dbState.shipstation_orders.find((r) => r.id === "o1")?.tag_ids).toEqual([42]);
  });

  it("removes tag with idempotent semantics", async () => {
    dbState.shipstation_orders.push(
      { id: "o1", workspace_id: "ws_1", shipstation_order_id: 100, tag_ids: [42] },
      { id: "o2", workspace_id: "ws_1", shipstation_order_id: 200, tag_ids: [] },
    );
    const r = await bulkRemoveOrdersTag({
      shipstationOrderUuids: ["o1", "o2"],
      tagId: 42,
    });
    expect(r.succeeded).toBe(2);
    expect(tagCalls.remove.length).toBe(1);
    expect(dbState.shipstation_orders.find((r) => r.id === "o1")?.tag_ids).toEqual([]);
  });

  it("hard-caps oversize batches", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `o${i}`);
    await expect(
      bulkAddOrdersTag({ shipstationOrderUuids: ids, tagId: 1 }),
    ).rejects.toThrow(/exceeds hard cap of 100/);
  });
});

describe("bulkSetOrdersHoldUntil (Phase 9.5)", () => {
  it("calls SS holdOrderUntil per order and updates local row", async () => {
    dbState.shipstation_orders.push(
      { id: "o1", workspace_id: "ws_1", shipstation_order_id: 100 },
      { id: "o2", workspace_id: "ws_1", shipstation_order_id: 200 },
    );
    const r = await bulkSetOrdersHoldUntil({
      shipstationOrderUuids: ["o1", "o2"],
      holdUntilDate: "2026-05-01",
    });
    expect(r.succeeded).toBe(2);
    expect(holdCalls.map(([oid, d]) => `${oid}:${d}`).sort()).toEqual([
      "100:2026-05-01",
      "200:2026-05-01",
    ]);
    expect(dbState.shipstation_orders[0]?.order_status).toBe("on_hold");
  });
});

describe("bulkBuyLabels (Phase 9.1)", () => {
  it("rejects when no buys supplied", async () => {
    await expect(bulkBuyLabels({ buys: [] })).rejects.toThrow(/no order ids/);
  });

  it("hard-caps oversize batches at 200", async () => {
    const buys = Array.from({ length: 201 }, (_, i) => ({
      shipstationOrderUuid: `o${i}`,
      selectedRate: { carrier: "USPS", service: "First", rate: 5 },
    }));
    await expect(bulkBuyLabels({ buys })).rejects.toThrow(/exceeds hard cap of 200/);
  });
});
