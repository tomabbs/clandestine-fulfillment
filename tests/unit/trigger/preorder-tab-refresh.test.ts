// Phase 5.3 — preorder-tab-refresh cron tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbState = {
  workspaces: [{ id: "ws_1" }] as Array<{ id: string }>,
  shipstationOrders: [] as Array<Record<string, unknown>>,
  shipstationOrderItems: [] as Array<Record<string, unknown>>,
  variants: [] as Array<Record<string, unknown>>,
  sensorReadings: [] as Array<Record<string, unknown>>,
};

vi.mock("@trigger.dev/sdk", () => ({
  schedules: { task: (def: { run: unknown }) => def },
  task: (def: { run: unknown }) => def,
  queue: () => ({ name: "stub", concurrencyLimit: 1 }),
  logger: { log: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/server/auth-context", () => ({
  getAllWorkspaceIds: async () => dbState.workspaces.map((w) => w.id),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => makeMockClient(),
}));

function makeMockClient() {
  return {
    from(table: string) {
      const _eqs: Array<[string, unknown]> = [];
      let _or: string | null = null;
      let _limit = 10000;
      let _updates: Record<string, unknown> | null = null;
      let _insertPayload: Record<string, unknown> | null = null;

      const matchByEqs = (rows: Array<Record<string, unknown>>) =>
        rows.filter((r) => _eqs.every(([col, val]) => r[col] === val));

      const matchByOr = (rows: Array<Record<string, unknown>>) => {
        if (!_or) return rows;
        // Tiny .or() parser — handles "preorder_state.eq.preorder,preorder_state.eq.ready".
        const clauses = _or.split(",").map((c) => c.split("."));
        return rows.filter((r) => clauses.some(([col, _op, val]) => r[col!] === val));
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          _eqs.push([col, val]);
          return builder;
        },
        in: (_col: string, _vals: readonly unknown[]) => builder,
        not: () => builder,
        or: (clause: string) => {
          _or = clause;
          return builder;
        },
        limit: (n: number) => {
          _limit = n;
          return builder;
        },
        update: (payload: Record<string, unknown>) => {
          _updates = payload;
          return builder;
        },
        insert: (payload: Record<string, unknown>) => {
          _insertPayload = payload;
          if (table === "sensor_readings") dbState.sensorReadings.push(payload);
          return builder;
        },
        async maybeSingle() {
          // not used in this test
          return { data: null, error: null };
        },
        // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mimic Supabase PostgREST builder
        then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
          if (_updates && table === "shipstation_orders") {
            const id = _eqs.find((e) => e[0] === "id")?.[1] as string;
            const row = dbState.shipstationOrders.find((r) => r.id === id);
            if (row) Object.assign(row, _updates);
            return Promise.resolve({ data: null, error: null }).then(onFulfilled);
          }
          if (_insertPayload) {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled);
          }
          if (table === "shipstation_orders") {
            const filtered = matchByOr(matchByEqs(dbState.shipstationOrders)).slice(0, _limit);
            return Promise.resolve({ data: filtered, error: null }).then(onFulfilled);
          }
          if (table === "shipstation_order_items") {
            return Promise.resolve({
              data: matchByEqs(dbState.shipstationOrderItems),
              error: null,
            }).then(onFulfilled);
          }
          if (table === "warehouse_product_variants") {
            return Promise.resolve({ data: matchByEqs(dbState.variants), error: null }).then(
              onFulfilled,
            );
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

import { runPreorderTabRefresh } from "@/trigger/tasks/preorder-tab-refresh";

beforeEach(() => {
  dbState.shipstationOrders = [];
  dbState.shipstationOrderItems = [];
  dbState.variants = [];
  dbState.sensorReadings = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runPreorderTabRefresh (Phase 5.3)", () => {
  it("returns scanned=0 when no preorder rows exist", async () => {
    const r = await runPreorderTabRefresh();
    expect(r.scanned).toBe(0);
    expect(r.workspaces).toBe(1);
  });

  it("counts unchanged when re-derive returns the same state", async () => {
    dbState.shipstationOrders.push({
      id: "ord_1",
      workspace_id: "ws_1",
      preorder_state: "preorder",
    });
    dbState.shipstationOrderItems.push({
      shipstation_order_id: "ord_1",
      sku: "LP-A",
    });
    dbState.variants.push({
      sku: "LP-A",
      is_preorder: true,
      // far in the future so today won't push it to "ready" or "none"
      street_date: "2099-01-01",
      workspace_id: "ws_1",
    });
    const r = await runPreorderTabRefresh();
    expect(r.scanned).toBe(1);
    expect(r.unchanged).toBe(1);
    expect(r.promoted_to_ready).toBe(0);
    expect(r.released_to_none).toBe(0);
  });

  it("counts released_to_none when a preorder line has dropped its is_preorder flag (or variant disappeared)", async () => {
    dbState.shipstationOrders.push({
      id: "ord_2",
      workspace_id: "ws_1",
      preorder_state: "ready",
    });
    dbState.shipstationOrderItems.push({
      shipstation_order_id: "ord_2",
      sku: "LP-RELEASED",
    });
    // Variant exists but is_preorder is now false (released).
    dbState.variants.push({
      sku: "LP-RELEASED",
      is_preorder: false,
      street_date: "2026-01-01",
      workspace_id: "ws_1",
    });
    const r = await runPreorderTabRefresh();
    expect(r.scanned).toBe(1);
    expect(r.released_to_none).toBe(1);
  });

  it("emits a sensor reading per workspace with the per-counter breakdown", async () => {
    dbState.shipstationOrders.push({
      id: "ord_3",
      workspace_id: "ws_1",
      preorder_state: "preorder",
    });
    dbState.shipstationOrderItems.push({ shipstation_order_id: "ord_3", sku: "LP-X" });
    dbState.variants.push({
      sku: "LP-X",
      is_preorder: true,
      street_date: "2099-01-01",
      workspace_id: "ws_1",
    });

    await runPreorderTabRefresh();
    const reading = dbState.sensorReadings.find(
      (s) => s.sensor_name === "trigger:preorder-tab-refresh",
    );
    expect(reading).toBeDefined();
    expect((reading as { value: { scanned: number } }).value.scanned).toBe(1);
  });
});
