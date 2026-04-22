// Phase 6.5 — bandcamp-shipping-verify branch tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbState, getOrdersMock, refreshTokenMock, triggerMock } = vi.hoisted(() => ({
  dbState: {
    warehouseShipments: [] as Array<Record<string, unknown>>,
    bandcampConnections: [] as Array<Record<string, unknown>>,
    sensorReadings: [] as Array<Record<string, unknown>>,
    workspaces: [] as Array<Record<string, unknown>>,
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
      const _eqs: Array<[string, unknown]> = [];
      const _isNotNull: string[] = [];
      const _isNull: string[] = [];
      const _lte: Array<[string, unknown]> = [];
      const _ins: Array<[string, unknown[]]> = [];
      const _notIns: Array<[string, unknown[]]> = [];
      let _limit = 10000;
      let _updates: Record<string, unknown> | null = null;
      let _insertPayload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;

      const parseInList = (val: unknown): unknown[] => {
        if (Array.isArray(val)) return val;
        if (typeof val === "string") {
          // PostgREST not.in style: "(id1,id2,id3)"
          const trimmed = val.replace(/^\(/, "").replace(/\)$/, "");
          if (trimmed.length === 0) return [];
          return trimmed.split(",").map((s) => s.trim());
        }
        return [];
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          _eqs.push([col, val]);
          return builder;
        },
        not: (col: string, op: string, val: unknown) => {
          if (op === "is") _isNotNull.push(col);
          else if (op === "in") _notIns.push([col, parseInList(val)]);
          return builder;
        },
        in: (col: string, val: unknown[]) => {
          _ins.push([col, val]);
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
        insert: (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
          _insertPayload = payload;
          if (table === "sensor_readings") {
            const rows = Array.isArray(payload) ? payload : [payload];
            for (const row of rows) dbState.sensorReadings.push(row);
          }
          return builder;
        },
        async maybeSingle() {
          return { data: null, error: null };
        },
        // biome-ignore lint/suspicious/noThenProperty: deliberate thennable mock for PostgREST builder
        then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
          if (table === "warehouse_shipments") {
            if (_updates) {
              const id = _eqs.find((e) => e[0] === "id")?.[1] as string;
              const row = dbState.warehouseShipments.find((r) => r.id === id);
              if (row) Object.assign(row, _updates);
              return Promise.resolve({ data: null, error: null }).then(onFulfilled);
            }
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
              .filter((r) => _ins.every(([col, vals]) => vals.includes(r[col])))
              .filter((r) => _notIns.every(([col, vals]) => !vals.includes(r[col])))
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
          if (table === "workspaces") {
            const matches = dbState.workspaces.filter((r) =>
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
  dbState.workspaces = [];
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

// Phase 5 (HRD-11) — direct-primary polarity tests.
describe("runBandcampShippingVerify (Phase 5 — direct-primary mode)", () => {
  // 10 min ago → past the 5-min direct-primary grace window.
  const dpEligibleISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  // 1 min ago → still inside the grace window (must be skipped).
  const dpInsideGraceISO = new Date(Date.now() - 60 * 1000).toISOString();

  function flipDirectPrimary(workspaceId: string) {
    dbState.workspaces.push({ id: workspaceId, bc_verify_direct_primary: true });
  }

  it("workspace with bc_verify_direct_primary=true: BC has no ship_date → enqueue direct push as the EXPECTED path (healthy sensor)", async () => {
    flipDirectPrimary("ws_dp");
    dbState.warehouseShipments.push({
      id: "ship_dp_1",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      bandcamp_payment_id: 7001,
      tracking_number: "TRK-DP-1",
      carrier: "USPS",
      ship_date: "2026-04-21",
      shipstation_marked_shipped_at: null,
      bandcamp_synced_at: null,
      created_at: dpEligibleISO,
    });
    dbState.bandcampConnections.push({
      id: "conn_dp",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      band_id: 5555,
      is_active: true,
    });
    getOrdersMock.mockResolvedValueOnce([
      { payment_id: 7001, ship_date: null, sku: "LP-DP", quantity: 1, sub_total: 25 },
    ]);

    const r = await runBandcampShippingVerify();

    expect(r.scanned).toBe(1);
    expect(r.direct_primary_pushed).toBe(1);
    expect(r.fell_back_to_direct_push).toBe(0);
    expect(r.direct_primary_already_shipped).toBe(0);
    expect(r.workspaces_direct_primary).toBe(1);
    expect(r.workspaces_legacy).toBe(0);

    expect(triggerMock).toHaveBeenCalledWith("bandcamp-mark-shipped", {
      shipmentId: "ship_dp_1",
    });

    const pushSensor = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.direct_primary_push",
    );
    expect(pushSensor).toBeDefined();
    expect(pushSensor?.status).toBe("healthy");

    // No legacy fallback alarm should fire under direct-primary polarity.
    const legacyFallback = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.connector_fallback",
    );
    expect(legacyFallback).toBeUndefined();
  });

  it("direct-primary: BC already shows shipped → stamp synced + emit healthy 'already shipped' sensor (no push)", async () => {
    flipDirectPrimary("ws_dp");
    dbState.warehouseShipments.push({
      id: "ship_dp_2",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      bandcamp_payment_id: 7002,
      tracking_number: "TRK-DP-2",
      carrier: "USPS",
      ship_date: "2026-04-21",
      shipstation_marked_shipped_at: null,
      bandcamp_synced_at: null,
      created_at: dpEligibleISO,
    });
    dbState.bandcampConnections.push({
      id: "conn_dp",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      band_id: 5555,
      is_active: true,
    });
    getOrdersMock.mockResolvedValueOnce([
      { payment_id: 7002, ship_date: "2026-04-21", sku: "LP-DP", quantity: 1, sub_total: 25 },
    ]);

    const r = await runBandcampShippingVerify();
    expect(r.direct_primary_already_shipped).toBe(1);
    expect(r.direct_primary_pushed).toBe(0);
    expect(triggerMock).not.toHaveBeenCalled();

    const stamped = dbState.warehouseShipments.find((s) => s.id === "ship_dp_2");
    expect(stamped?.bandcamp_synced_at).toBeDefined();

    const sensor = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.direct_primary_already_shipped",
    );
    expect(sensor).toBeDefined();
  });

  it("direct-primary: shipment INSIDE 5-min grace window is NOT processed (gives inline push a fair chance)", async () => {
    flipDirectPrimary("ws_dp");
    dbState.warehouseShipments.push({
      id: "ship_dp_grace",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      bandcamp_payment_id: 7003,
      tracking_number: "TRK-DP-3",
      carrier: "USPS",
      ship_date: "2026-04-21",
      shipstation_marked_shipped_at: null,
      bandcamp_synced_at: null,
      created_at: dpInsideGraceISO,
    });
    dbState.bandcampConnections.push({
      id: "conn_dp",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      band_id: 5555,
      is_active: true,
    });

    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(0);
    expect(getOrdersMock).not.toHaveBeenCalled();
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it("legacy workspace and direct-primary workspace coexist: each is processed under its own polarity", async () => {
    flipDirectPrimary("ws_dp");

    // Legacy shipment (ws_legacy is NOT direct-primary).
    dbState.warehouseShipments.push({
      id: "ship_legacy",
      workspace_id: "ws_legacy",
      org_id: "org_legacy",
      bandcamp_payment_id: 8001,
      tracking_number: "TRK-LEG",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: null,
      created_at: oldEnoughISO,
    });
    dbState.bandcampConnections.push({
      id: "conn_legacy",
      workspace_id: "ws_legacy",
      org_id: "org_legacy",
      band_id: 6666,
      is_active: true,
    });

    // Direct-primary shipment.
    dbState.warehouseShipments.push({
      id: "ship_dp_3",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      bandcamp_payment_id: 7004,
      tracking_number: "TRK-DP-4",
      carrier: "USPS",
      ship_date: "2026-04-21",
      shipstation_marked_shipped_at: null,
      bandcamp_synced_at: null,
      created_at: dpEligibleISO,
    });
    dbState.bandcampConnections.push({
      id: "conn_dp",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      band_id: 5555,
      is_active: true,
    });

    // Both BC API calls return "not yet shipped" so both take the push path.
    getOrdersMock.mockImplementation(async (params: { bandId: number }) => {
      if (params.bandId === 6666) {
        return [{ payment_id: 8001, ship_date: null, sku: "LP-LEG", quantity: 1, sub_total: 25 }];
      }
      if (params.bandId === 5555) {
        return [{ payment_id: 7004, ship_date: null, sku: "LP-DP", quantity: 1, sub_total: 25 }];
      }
      return [];
    });

    const r = await runBandcampShippingVerify();

    expect(r.scanned).toBe(2);
    expect(r.fell_back_to_direct_push).toBe(1); // legacy → alarm fallback
    expect(r.direct_primary_pushed).toBe(1); // direct-primary → expected push
    expect(r.workspaces_direct_primary).toBe(1);
    expect(r.workspaces_legacy).toBe(1);

    expect(triggerMock).toHaveBeenCalledTimes(2);

    const fallbackSensor = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.connector_fallback",
    );
    expect(fallbackSensor).toBeDefined();
    expect(fallbackSensor?.status).toBe("warning");

    const pushSensor = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.direct_primary_push",
    );
    expect(pushSensor).toBeDefined();
    expect(pushSensor?.status).toBe("healthy");
  });

  it("direct-primary: shipment without shipstation_marked_shipped_at is STILL eligible (legacy filter dropped)", async () => {
    flipDirectPrimary("ws_dp");
    dbState.warehouseShipments.push({
      id: "ship_dp_noss",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      bandcamp_payment_id: 7005,
      tracking_number: "TRK-DP-5",
      carrier: "USPS",
      ship_date: "2026-04-21",
      shipstation_marked_shipped_at: null, // ← legacy filter would skip this
      bandcamp_synced_at: null,
      created_at: dpEligibleISO,
    });
    dbState.bandcampConnections.push({
      id: "conn_dp",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      band_id: 5555,
      is_active: true,
    });
    getOrdersMock.mockResolvedValueOnce([
      { payment_id: 7005, ship_date: null, sku: "LP-DP", quantity: 1, sub_total: 25 },
    ]);

    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(1);
    expect(r.direct_primary_pushed).toBe(1);
  });

  it("direct-primary workspace is EXCLUDED from the legacy SELECT (no double-processing)", async () => {
    flipDirectPrimary("ws_dp");

    // Shipment that satisfies BOTH legacy AND direct-primary filters
    // (has SS-marked-at AND created long enough ago). Direct-primary
    // polarity must win — it should be processed exactly once and emit a
    // direct_primary_push sensor reading, NEVER a connector_fallback.
    dbState.warehouseShipments.push({
      id: "ship_dp_dual",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      bandcamp_payment_id: 7006,
      tracking_number: "TRK-DP-6",
      carrier: "USPS",
      ship_date: "2026-04-21",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: null,
      created_at: oldEnoughISO,
    });
    dbState.bandcampConnections.push({
      id: "conn_dp",
      workspace_id: "ws_dp",
      org_id: "org_dp",
      band_id: 5555,
      is_active: true,
    });
    getOrdersMock.mockResolvedValueOnce([
      { payment_id: 7006, ship_date: null, sku: "LP-DP", quantity: 1, sub_total: 25 },
    ]);

    const r = await runBandcampShippingVerify();
    expect(r.scanned).toBe(1);
    expect(r.direct_primary_pushed).toBe(1);
    expect(r.fell_back_to_direct_push).toBe(0);
    expect(triggerMock).toHaveBeenCalledTimes(1);

    const fallback = dbState.sensorReadings.find(
      (s) => s.sensor_name === "bandcamp.connector_fallback",
    );
    expect(fallback).toBeUndefined();
  });

  it("emits ONE per-workspace sensor reading per run (not one global)", async () => {
    flipDirectPrimary("ws_dp");
    dbState.warehouseShipments.push({
      id: "ship_legacy_a",
      workspace_id: "ws_legacy_a",
      org_id: "org_a",
      bandcamp_payment_id: 5001,
      tracking_number: "TRK-A",
      carrier: "USPS",
      ship_date: "2026-04-19",
      shipstation_marked_shipped_at: oldEnoughISO,
      bandcamp_synced_at: null,
      created_at: oldEnoughISO,
    });
    dbState.warehouseShipments.push({
      id: "ship_dp_b",
      workspace_id: "ws_dp",
      org_id: "org_b",
      bandcamp_payment_id: 5002,
      tracking_number: "TRK-B",
      carrier: "USPS",
      ship_date: "2026-04-21",
      shipstation_marked_shipped_at: null,
      bandcamp_synced_at: null,
      created_at: dpEligibleISO,
    });
    dbState.bandcampConnections.push(
      {
        id: "c_a",
        workspace_id: "ws_legacy_a",
        org_id: "org_a",
        band_id: 1111,
        is_active: true,
      },
      {
        id: "c_b",
        workspace_id: "ws_dp",
        org_id: "org_b",
        band_id: 2222,
        is_active: true,
      },
    );
    getOrdersMock.mockImplementation(async (params: { bandId: number }) => {
      if (params.bandId === 1111) {
        return [{ payment_id: 5001, ship_date: "2026-04-19", sku: "X", quantity: 1, sub_total: 1 }];
      }
      return [{ payment_id: 5002, ship_date: null, sku: "Y", quantity: 1, sub_total: 1 }];
    });

    await runBandcampShippingVerify();

    const summarySensors = dbState.sensorReadings.filter(
      (s) => s.sensor_name === "trigger:bandcamp-shipping-verify",
    );
    expect(summarySensors).toHaveLength(2);
    const wsIds = summarySensors.map((s) => s.workspace_id).sort();
    expect(wsIds).toEqual(["ws_dp", "ws_legacy_a"]);
  });
});
