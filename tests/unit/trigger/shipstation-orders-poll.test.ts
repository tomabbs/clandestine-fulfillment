/**
 * Phase 1.2 — shipstation-orders-poll cron task tests.
 *
 * The task body is heavily Supabase-coupled. We test the behavior an external
 * reviewer would care about most:
 *
 *   1. Cursor advancement: a cursor written before the run is preserved with
 *      the new timestamp (we don't lose modify-since position on retry).
 *   2. First-ever run uses the FIRST_POLL_LOOKBACK_DAYS fallback when no
 *      cursor exists (no infinite-history pull).
 *   3. Webhook-triggered window run uses windowMinutes instead of cursor.
 *   4. Unmatched orders still upsert (org_id NULL) — they are not silently
 *      dropped on the floor.
 *
 * The full SS API + Supabase paths are covered by integration tests; here we
 * stub fetchOrders and a thin Supabase mock to assert the contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchOrdersMock = vi.fn();
vi.mock("@/lib/clients/shipstation", () => ({
  fetchOrders: (...args: unknown[]) => fetchOrdersMock(...args),
}));

const matchShipmentOrgMock = vi.fn();
vi.mock("@/trigger/lib/match-shipment-org", () => ({
  matchShipmentOrg: (...args: unknown[]) => matchShipmentOrgMock(...args),
}));

// In-memory Supabase mock — reused across tests with reset.
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  workspaces: [{ id: "ws_1" }],
  warehouse_sync_state: [],
  shipstation_orders: [],
  shipstation_order_items: [],
  sensor_readings: [],
};

function makeChain(tableName: string) {
  let _eqs: Array<[string, unknown]> = [];
  let _select: string | null = null;
  let _limit = 1000;
  let _insertPayload: Row | Row[] | null = null;
  let _updatePayload: Row | null = null;
  let _upsertPayload: Row | null = null;
  let _conflict: string | null = null;
  let _isDelete = false;
  const matchByEqs = () =>
    tables[tableName].filter((r) =>
      _eqs.every(([col, val]) => r[col] === val),
    );
  const chain: Record<string, unknown> = {
    select(s: string) {
      _select = s;
      return chain;
    },
    eq(col: string, val: unknown) {
      _eqs.push([col, val]);
      return chain;
    },
    not(_col: string, _op: string, _val: unknown) {
      return chain;
    },
    in(_col: string, _vals: readonly unknown[]) {
      // Phase 5.2 — preorder variant lookup uses .in("sku", skus). The mock
      // doesn't have a warehouse_product_variants table, so it just returns
      // empty (the helper handles missing variants as not-preorder).
      return chain;
    },
    limit(n: number) {
      _limit = n;
      return chain;
    },
    insert(payload: Row | Row[]) {
      _insertPayload = payload;
      return chain;
    },
    upsert(payload: Row, opts?: { onConflict?: string }) {
      _upsertPayload = payload;
      _conflict = opts?.onConflict ?? null;
      return chain;
    },
    update(payload: Row) {
      _updatePayload = payload;
      return chain;
    },
    delete() {
      _isDelete = true;
      return chain;
    },
    async maybeSingle() {
      const results = matchByEqs();
      return { data: results[0] ?? null, error: null };
    },
    async single() {
      // Insert path — return inserted row id.
      if (_insertPayload && !Array.isArray(_insertPayload)) {
        const row = { id: `id_${tables[tableName].length + 1}`, ..._insertPayload };
        tables[tableName].push(row);
        return { data: { id: row.id }, error: null };
      }
      // Upsert path — replace by conflict cols, otherwise insert.
      if (_upsertPayload && _conflict) {
        const conflictCols = _conflict.split(",");
        const idx = tables[tableName].findIndex((r) =>
          conflictCols.every((c) => r[c.trim()] === (_upsertPayload as Row)[c.trim()]),
        );
        if (idx >= 0) {
          tables[tableName][idx] = { ...tables[tableName][idx], ..._upsertPayload };
          return { data: { id: tables[tableName][idx]?.id }, error: null };
        }
        const row = { id: `id_${tables[tableName].length + 1}`, ..._upsertPayload };
        tables[tableName].push(row);
        return { data: { id: row.id }, error: null };
      }
      // Plain select.single
      const results = matchByEqs().slice(0, _limit);
      return { data: results[0] ?? null, error: null };
    },
    then(onFulfilled: (v: { data: null; error: null }) => unknown) {
      // Update / delete / array-insert all settle here.
      if (_isDelete) {
        const remaining = tables[tableName].filter(
          (r) => !_eqs.every(([col, val]) => r[col] === val),
        );
        tables[tableName] = remaining;
      } else if (_updatePayload && _eqs.length > 0) {
        for (const r of tables[tableName]) {
          if (_eqs.every(([col, val]) => r[col] === val)) {
            Object.assign(r, _updatePayload);
          }
        }
      } else if (_insertPayload && Array.isArray(_insertPayload)) {
        for (const row of _insertPayload as Row[]) {
          tables[tableName].push({ id: `id_${tables[tableName].length + 1}`, ...row });
        }
      } else if (_insertPayload && !Array.isArray(_insertPayload)) {
        tables[tableName].push({
          id: `id_${tables[tableName].length + 1}`,
          ...(_insertPayload as Row),
        });
      }
      return Promise.resolve({ data: null, error: null }).then(onFulfilled);
    },
  };
  return chain;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => makeChain(table),
  }),
}));

import { runPoll } from "@/trigger/tasks/shipstation-orders-poll";

beforeEach(() => {
  for (const k of Object.keys(tables)) tables[k] = [];
  tables.workspaces = [{ id: "ws_1" }];
  fetchOrdersMock.mockReset();
  matchShipmentOrgMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shipstation-orders-poll (Phase 1.2)", () => {
  it("first-ever run with no cursor pulls last 7 days, advances cursor to run-start", async () => {
    fetchOrdersMock.mockResolvedValue({
      orders: [],
      total: 0,
      page: 1,
      pages: 1,
    });
    const before = Date.now();
    const res = await runPoll({});
    expect(res.upserted).toBe(0);

    const call = fetchOrdersMock.mock.calls[0]?.[0];
    expect(call.modifyDateStart).toBeDefined();
    const lookback = before - new Date(call.modifyDateStart).getTime();
    // 7 days ± a tolerance for test execution time.
    expect(lookback).toBeGreaterThan(6.5 * 24 * 60 * 60 * 1000);
    expect(lookback).toBeLessThan(7.5 * 24 * 60 * 60 * 1000);

    expect(tables.warehouse_sync_state).toHaveLength(1);
    expect(tables.warehouse_sync_state[0]?.last_sync_cursor).toBeDefined();
  });

  it("subsequent run uses cursor with 5-min safety overlap", async () => {
    const cursor = new Date("2026-04-19T10:00:00Z").toISOString();
    tables.warehouse_sync_state.push({
      id: "ss_1",
      workspace_id: "ws_1",
      sync_type: "shipstation_orders_poll",
      last_sync_cursor: cursor,
    });
    fetchOrdersMock.mockResolvedValue({ orders: [], total: 0, page: 1, pages: 1 });
    await runPoll({});

    const passed = fetchOrdersMock.mock.calls[0]?.[0]?.modifyDateStart;
    const passedMs = new Date(passed).getTime();
    const cursorMs = new Date(cursor).getTime();
    expect(cursorMs - passedMs).toBe(5 * 60 * 1000);
  });

  it("webhook windowMinutes overrides cursor and ignores last_sync_cursor", async () => {
    tables.warehouse_sync_state.push({
      id: "ss_1",
      workspace_id: "ws_1",
      sync_type: "shipstation_orders_poll",
      last_sync_cursor: "2020-01-01T00:00:00Z", // ancient — must be ignored
    });
    fetchOrdersMock.mockResolvedValue({ orders: [], total: 0, page: 1, pages: 1 });
    const before = Date.now();
    await runPoll({ windowMinutes: 10 });
    const passed = fetchOrdersMock.mock.calls[0]?.[0]?.modifyDateStart;
    const passedMs = new Date(passed).getTime();
    expect(before - passedMs).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
    expect(before - passedMs).toBeLessThan(10 * 60 * 1000 + 5000);
  });

  it("upserts orders + items when org matches", async () => {
    fetchOrdersMock.mockResolvedValue({
      orders: [
        {
          orderId: 9001,
          orderNumber: "BC-9001",
          orderStatus: "awaiting_shipment",
          customerEmail: "buyer@example.com",
          customerUsername: "buyer",
          shipTo: { country: "US" },
          items: [
            { sku: "LP-001", name: "Album", quantity: 1, unitPrice: 25 },
            { sku: "CD-001", name: "Single", quantity: 2, unitPrice: 12 },
          ],
          amountPaid: 49,
          shippingAmount: 7,
          modifyDate: "2026-04-19 12:00:00",
          storeId: 99,
          advancedOptions: { storeId: 99 },
        },
      ],
      total: 1,
      page: 1,
      pages: 1,
    });
    matchShipmentOrgMock.mockResolvedValue({
      orgId: "org_1",
      method: "store_mapping",
      isDropShip: false,
    });

    const res = await runPoll({});
    expect(res.upserted).toBe(1);
    expect(res.unmatched).toBe(0);

    expect(tables.shipstation_orders).toHaveLength(1);
    expect(tables.shipstation_orders[0]).toMatchObject({
      shipstation_order_id: 9001,
      org_id: "org_1",
      order_status: "awaiting_shipment",
      customer_email: "buyer@example.com",
    });
    expect(tables.shipstation_order_items).toHaveLength(2);
    expect(tables.shipstation_order_items[0]).toMatchObject({ sku: "LP-001", item_index: 0 });
    expect(tables.shipstation_order_items[1]).toMatchObject({ sku: "CD-001", item_index: 1 });
  });

  it("unmatched orders still upsert with org_id null and increment unmatched counter", async () => {
    fetchOrdersMock.mockResolvedValue({
      orders: [
        {
          orderId: 9002,
          orderNumber: "MYSTERY-9002",
          orderStatus: "awaiting_shipment",
          shipTo: null,
          items: [],
          modifyDate: "2026-04-19 12:00:00",
          storeId: 999,
          advancedOptions: null,
        },
      ],
      total: 1,
      page: 1,
      pages: 1,
    });
    matchShipmentOrgMock.mockResolvedValue(null);

    const res = await runPoll({});
    expect(res.upserted).toBe(0);
    expect(res.unmatched).toBe(1);

    expect(tables.shipstation_orders).toHaveLength(1);
    expect(tables.shipstation_orders[0]?.org_id).toBeNull();
  });

  it("upsert by (workspace_id, shipstation_order_id) — second poll updates same row", async () => {
    matchShipmentOrgMock.mockResolvedValue({
      orgId: "org_1",
      method: "store_mapping",
      isDropShip: false,
    });
    fetchOrdersMock.mockResolvedValue({
      orders: [
        {
          orderId: 9003,
          orderNumber: "BC-9003",
          orderStatus: "awaiting_shipment",
          shipTo: null,
          items: [],
          amountPaid: 25,
          modifyDate: "2026-04-19 12:00:00",
          storeId: 99,
          advancedOptions: { storeId: 99 },
        },
      ],
      total: 1,
      page: 1,
      pages: 1,
    });
    await runPoll({});
    expect(tables.shipstation_orders).toHaveLength(1);

    fetchOrdersMock.mockResolvedValue({
      orders: [
        {
          orderId: 9003,
          orderNumber: "BC-9003",
          orderStatus: "shipped",
          shipTo: null,
          items: [],
          amountPaid: 25,
          modifyDate: "2026-04-19 13:00:00",
          storeId: 99,
          advancedOptions: { storeId: 99 },
        },
      ],
      total: 1,
      page: 1,
      pages: 1,
    });
    await runPoll({});
    expect(tables.shipstation_orders).toHaveLength(1);
    expect(tables.shipstation_orders[0]?.order_status).toBe("shipped");
  });
});
