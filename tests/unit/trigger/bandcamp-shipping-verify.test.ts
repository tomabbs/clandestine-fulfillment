// Phase 6.5 — bandcamp-shipping-verify branch tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbState, getOrdersMock, refreshTokenMock, triggerMock } = vi.hoisted(() => ({
  dbState: {
    warehouseShipments: [] as Array<Record<string, unknown>>,
    bandcampConnections: [] as Array<Record<string, unknown>>,
    sensorReadings: [] as Array<Record<string, unknown>>,
  },
  getOrdersMock: vi.fn(),
  refreshTokenMock: vi.fn(),
  triggerMock: vi.fn().mockResolvedValue({ id: "run-fallback-1" }),
}));

vi.mock("@trigger.dev/sdk", () => ({
  schedules: { task: (def: { run: unknown }) => def },
  task: (def: { run: unknown }) => def,
  queue: () => ({ name: "stub", concurrencyLimit: 1 }),
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  tasks: { trigger: triggerMock },
}));
vi.mock("@/trigger/lib/bandcamp-queue", () => ({
  bandcampQueue: { name: "bandcamp", concurrencyLimit: 1 },
}));
vi.mock("@/lib/clients/bandcamp", () => ({
  getOrders: getOrdersMock,
  refreshBandcampToken: refreshTokenMock,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => makeMockClient(),
}));

function makeMockClient() {
  return {
    from(table: string) {
      let _eqs: Array<[string, unknown]> = [];
      let _isNotNull: string[] = [];
      let _isNull: string[] = [];
      let _lte: Array<[string, unknown]> = [];
      let _limit = 10000;
      let _updates: Record<string, unknown> | null = null;
      let _insertPayload: Record<string, unknown> | null = null;

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          _eqs.push([col, val]);
          return builder;
        },
        not: (col: string, op: string, _val: unknown) => {
          if (op === "is") _isNotNull.push(col);
          return builder;
        },
        is: (col: string, val: unknown) => {
          if (val === null) _isNull.push(col);
          return builder;
        },
        lte: (col: string, val: unknown) => {
          _lte.push([col, val]);
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
          return { data: null, error: null };
        },
        then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
          if (table === "warehouse_shipments") {
            if (_updates) {
              const id = _eqs.find((e) => e[0] === "id")?.[1] as string;
              const row = dbState.warehouseShipments.find((r) => r.id === id);
              if (row) Object.assign(row, _updates);
              return Promise.resolve({ data: null, error: null }).then(onFulfilled);
            }
            // SELECT path — apply all filters.
            const matches = dbState.warehouseShipments
              .filter((r) => _eqs.every(([col, val]) => r[col] === val))
              .filter((r) => _isNotNull.every((col) => r[col] != null))
              .filter((r) => _isNull.every((col) => r[col] == null))
              .filter((r) =>
                _lte.every(([col, val]) => {
                  const cv = r[col];
                  return typeof cv === "string" && cv <= String(val);
                }),
              )
              .slice(0, _limit);
            return Promise.resolve({ data: matches, error: null }).then(onFulfilled);
          }
          if (table === "bandcamp_connections") {
            const matches = dbState.bandcampConnections.filter((r) =>
              _eqs.every(([col, val]) => r[col] === val),
            );
            return Promise.resolve({ data: matches.slice(0, _limit), error: null }).then(
              onFulfilled,
            );
          }
          if (_insertPayload) {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled);
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

import { runBandcampShippingVerify } from "@/trigger/tasks/bandcamp-shipping-verify";

beforeEach(() => {
  dbState.warehouseShipments = [];
  dbState.bandcampConnections = [];
  dbState.sensorReadings = [];
  getOrdersMock.mockReset();
  refreshTokenMock.mockReset().mockResolvedValue("token-abc");
  triggerMock.mockReset().mockResolvedValue({ id: "run-1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

const oldEnoughISO = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago — past 30-min cutoff

describe("runBandcampShippingVerify (Phase 6.5)", () => {
  it("returns scanned=0 when no pending shipments", async () => {
    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(0);
    expect(r.ss_connector_succeeded).toBe(0);
    expect(r.fell_back_to_direct_push).toBe(0);
  });

  it("SS connector succeeded path: BC has ship_date → stamp synced + emit success sensor", async () => {
    dbState.warehouseShipments.push({
      id: "ship_1",
      workspace_id: "ws_1",
      org_id: "org_1",
      bandcamp_payment_id: 9001,
      tracking_number: "TRK1",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: null,
    });
    dbState.bandcampConnections.push({
      id: "conn_1",
      workspace_id: "ws_1",
      org_id: "org_1",
      band_id: 12345,
      is_active: true,
    });
    getOrdersMock.mockResolvedValueOnce([
      {
        payment_id: 9001,
        ship_date: "2026-04-19",
        sku: "LP-001",
        quantity: 1,
        sub_total: 25,
      },
    ]);

    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(1);
    expect(r.ss_connector_succeeded).toBe(1);
    expect(r.fell_back_to_direct_push).toBe(0);

    const successSensor = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.connector_success",
    );
    expect(successSensor).toBeDefined();

    const stamped = dbState.warehouseShipments.find((s) => s.id === "ship_1");
    expect(stamped?.bandcamp_synced_at).toBeDefined();
  });

  it("SS connector did NOT push: BC has order but no ship_date → fall back to direct push", async () => {
    dbState.warehouseShipments.push({
      id: "ship_2",
      workspace_id: "ws_1",
      org_id: "org_1",
      bandcamp_payment_id: 9002,
      tracking_number: "TRK2",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: null,
    });
    dbState.bandcampConnections.push({
      id: "conn_1",
      workspace_id: "ws_1",
      org_id: "org_1",
      band_id: 12345,
      is_active: true,
    });
    getOrdersMock.mockResolvedValueOnce([
      {
        payment_id: 9002,
        ship_date: null,
        sku: "LP-001",
        quantity: 1,
        sub_total: 25,
      },
    ]);

    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(1);
    expect(r.ss_connector_succeeded).toBe(0);
    expect(r.fell_back_to_direct_push).toBe(1);

    expect(triggerMock).toHaveBeenCalledWith("bandcamp-mark-shipped", {
      shipmentId: "ship_2",
    });

    const fallbackSensor = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.connector_fallback",
    );
    expect(fallbackSensor).toBeDefined();
  });

  it("no BC connection for org → ALL group shipments fall back to direct push (no_bc_connection reason)", async () => {
    dbState.warehouseShipments.push({
      id: "ship_3",
      workspace_id: "ws_1",
      org_id: "org_unknown",
      bandcamp_payment_id: 9003,
      tracking_number: "TRK3",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: null,
    });
    // no bandcamp_connections row for org_unknown

    const r = await runBandcampShippingVerify();
    expect(r.fell_back_to_direct_push).toBe(1);
    expect(triggerMock).toHaveBeenCalledWith("bandcamp-mark-shipped", {
      shipmentId: "ship_3",
    });
    const sensor = dbState.sensorReadings.find(
      (s) =>
        s.sensor_name === "bandcamp.connector_fallback" &&
        (s.value as { reason?: string })?.reason === "no_bc_connection",
    );
    expect(sensor).toBeDefined();
  });

  it("BC API failure → counts as errors (NO direct-push fallback to avoid cascading API failure)", async () => {
    dbState.warehouseShipments.push({
      id: "ship_4",
      workspace_id: "ws_1",
      org_id: "org_1",
      bandcamp_payment_id: 9004,
      tracking_number: "TRK4",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: null,
    });
    dbState.bandcampConnections.push({
      id: "conn_1",
      workspace_id: "ws_1",
      org_id: "org_1",
      band_id: 12345,
      is_active: true,
    });
    getOrdersMock.mockRejectedValueOnce(new Error("BC API 500"));

    const r = await runBandcampShippingVerify();
    expect(r.errors).toBe(1);
    expect(r.fell_back_to_direct_push).toBe(0);
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it("does NOT process shipments under the 30-min cutoff (gives SS connector a fair window)", async () => {
    const tooRecentISO = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    dbState.warehouseShipments.push({
      id: "ship_5",
      workspace_id: "ws_1",
      org_id: "org_1",
      bandcamp_payment_id: 9005,
      tracking_number: "TRK5",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: tooRecentISO,
      bandcamp_synced_at: null,
    });
    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(0);
    expect(getOrdersMock).not.toHaveBeenCalled();
  });

  it("does NOT process shipments that are already bandcamp_synced_at", async () => {
    dbState.warehouseShipments.push({
      id: "ship_6",
      workspace_id: "ws_1",
      org_id: "org_1",
      bandcamp_payment_id: 9006,
      tracking_number: "TRK6",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: new Date().toISOString(),
    });
    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(0);
  });
});
