// Phase 4.3 — shipstation-mark-shipped task tests.
//
// Covers J.6 scenarios:
//   G — v2 happy path (shipment_id present, no errors).
//   H — idempotent retry (already stamped, no API call).
//   I — already-shipped (v1 409 / v2 "already fulfilled" → success).
//   J — carrier unknown (mapping resolver returns no_mapping → error stamp).
//   plus v2-error-then-v1-success fallback path.
//   plus v2 throws → v1 success.
//   plus v1 fallback when shipstation_shipment_id missing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createFulfillmentsMock, markOrderShippedMock, dbState } = vi.hoisted(() => ({
  createFulfillmentsMock: vi.fn(),
  markOrderShippedMock: vi.fn(),
  dbState: {
    shipments: new Map<string, Record<string, unknown>>(),
    ssOrders: new Map<string, Record<string, unknown>>(),
    carrierMap: [] as Array<Record<string, unknown>>,
    sensors: [] as Array<Record<string, unknown>>,
    reviewQueue: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: unknown }) => def,
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  queue: () => ({ name: "shipstation", concurrencyLimit: 1 }),
}));
vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: { name: "shipstation", concurrencyLimit: 1 },
}));
vi.mock("@/lib/clients/shipstation-inventory-v2", () => ({
  createFulfillments: createFulfillmentsMock,
}));
vi.mock("@/lib/clients/shipstation", () => ({
  markOrderShipped: markOrderShippedMock,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => makeMockSupabase(),
}));

function makeMockSupabase() {
  return {
    from(table: string) {
      const _eqs: Array<[string, unknown]> = [];
      let _isNull = false;
      let _updates: Record<string, unknown> | null = null;
      let _insert: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          _eqs.push([col, val]);
          return builder;
        },
        is: (col: string, val: unknown) => {
          if (col === "easypost_service" && val === null) _isNull = true;
          return builder;
        },
        update(payload: Record<string, unknown>) {
          _updates = payload;
          return builder;
        },
        insert(payload: Record<string, unknown>) {
          _insert = payload;
          if (table === "sensor_readings") dbState.sensors.push(payload);
          if (table === "warehouse_review_queue") dbState.reviewQueue.push(payload);
          return builder;
        },
        upsert(payload: Record<string, unknown>) {
          _insert = payload;
          if (table === "warehouse_review_queue") dbState.reviewQueue.push(payload);
          return builder;
        },
        async maybeSingle() {
          if (table === "warehouse_shipments") {
            const id = _eqs.find((e) => e[0] === "id")?.[1] as string;
            return { data: dbState.shipments.get(id) ?? null, error: null };
          }
          if (table === "shipstation_orders") {
            const id = _eqs.find((e) => e[0] === "id")?.[1] as string;
            return { data: dbState.ssOrders.get(id) ?? null, error: null };
          }
          if (table === "shipstation_carrier_map") {
            const ws = _eqs.find((e) => e[0] === "workspace_id")?.[1];
            const carrier = _eqs.find((e) => e[0] === "easypost_carrier")?.[1];
            const service = _eqs.find((e) => e[0] === "easypost_service")?.[1] ?? null;
            const match = dbState.carrierMap.find((r) => {
              if (r.workspace_id !== ws) return false;
              if (r.easypost_carrier !== carrier) return false;
              if (_isNull) return r.easypost_service === null;
              return r.easypost_service === service;
            });
            return { data: match ?? null, error: null };
          }
          return { data: null, error: null };
        },
        // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mimic Supabase PostgREST builder
        then(onFulfilled: (v: { data: null; error: null }) => unknown) {
          if (_updates && table === "warehouse_shipments") {
            const id = _eqs.find((e) => e[0] === "id")?.[1] as string;
            const existing = dbState.shipments.get(id) ?? {};
            dbState.shipments.set(id, { ...existing, ..._updates });
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

import { shipstationMarkShippedTask } from "@/trigger/tasks/shipstation-mark-shipped";

const run = (
  shipstationMarkShippedTask as unknown as {
    run: (p: { warehouse_shipment_id: string }) => Promise<{
      ok: boolean;
      path?: string;
      alreadyShipped?: boolean;
      error?: string;
      trackingUrl?: string | null;
    }>;
  }
).run;

beforeEach(() => {
  createFulfillmentsMock.mockReset();
  markOrderShippedMock.mockReset();
  dbState.shipments.clear();
  dbState.ssOrders.clear();
  dbState.carrierMap.length = 0;
  dbState.sensors.length = 0;
  dbState.reviewQueue.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

function seedHappyPath(over?: Partial<Record<string, unknown>>) {
  dbState.shipments.set("ship_1", {
    id: "ship_1",
    workspace_id: "ws_1",
    label_source: "easypost",
    carrier: "USPS",
    service: "Priority",
    tracking_number: "TRK1",
    ship_date: "2026-04-19",
    shipstation_order_id: "ssord_uuid_1",
    shipstation_shipment_id: "se-100",
    shipstation_marked_shipped_at: null,
    shipstation_writeback_attempts: 0,
    label_data: {},
    ...over,
  });
  dbState.ssOrders.set("ssord_uuid_1", {
    id: "ssord_uuid_1",
    shipstation_order_id: 9001,
  });
  dbState.carrierMap.push({
    id: "cm_1",
    workspace_id: "ws_1",
    easypost_carrier: "USPS",
    easypost_service: "Priority",
    shipstation_carrier_code: "stamps_com",
    shipstation_service_code: null,
    mapping_confidence: "verified",
    block_auto_writeback: false,
  });
}

describe("shipstation-mark-shipped (Phase 4.3)", () => {
  it("J.6 G — v2 happy path stamps shipstation_marked_shipped_at + writeback_path='v2'", async () => {
    seedHappyPath();
    createFulfillmentsMock.mockResolvedValue({
      has_errors: false,
      fulfillments: [{ shipment_id: "se-100", tracking_url: "https://ss.com/track/TRK1" }],
    });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("v2");
    expect(r.trackingUrl ?? null).toBe("https://ss.com/track/TRK1");
    const shipment = dbState.shipments.get("ship_1") as Record<string, unknown>;
    expect(shipment.shipstation_marked_shipped_at).toBeDefined();
    expect(shipment.shipstation_writeback_path).toBe("v2");
    expect(shipment.shipstation_writeback_error).toBeNull();
  });

  it("J.6 H — already stamped → returns alreadyShipped without calling SS", async () => {
    seedHappyPath({ shipstation_marked_shipped_at: "2026-04-19T11:00:00Z" });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    expect(r.alreadyShipped).toBe(true);
    expect(createFulfillmentsMock).not.toHaveBeenCalled();
    expect(markOrderShippedMock).not.toHaveBeenCalled();
  });

  it("J.6 I — v2 returns 'already fulfilled' → treated as success and stamped", async () => {
    seedHappyPath();
    createFulfillmentsMock.mockResolvedValue({
      has_errors: true,
      fulfillments: [{ shipment_id: "se-100", error_message: "Shipment already fulfilled" }],
    });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    expect(r.alreadyShipped).toBe(true);
    const shipment = dbState.shipments.get("ship_1") as Record<string, unknown>;
    expect(shipment.shipstation_marked_shipped_at).toBeDefined();
  });

  it("v2 returns a NON-already-shipped error → falls back to v1 success", async () => {
    seedHappyPath();
    createFulfillmentsMock.mockResolvedValue({
      has_errors: true,
      fulfillments: [{ shipment_id: "se-100", error_message: "Carrier code invalid" }],
    });
    markOrderShippedMock.mockResolvedValue({
      orderId: 9001,
      orderNumber: "BC-9001",
      customerNotifiedAt: "2026-04-19T12:00:00Z",
    });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("v1");
    const shipment = dbState.shipments.get("ship_1") as Record<string, unknown>;
    expect(shipment.shipstation_writeback_path).toBe("v1");
  });

  it("v2 throws (network/SDK error) → falls back to v1 success", async () => {
    seedHappyPath();
    createFulfillmentsMock.mockRejectedValue(new Error("ShipStation v2 503"));
    markOrderShippedMock.mockResolvedValue({ orderId: 9001 });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("v1");
  });

  it("v1 throws 409 already_shipped → treated as success", async () => {
    seedHappyPath();
    createFulfillmentsMock.mockResolvedValue({
      has_errors: true,
      fulfillments: [{ shipment_id: "se-100", error_message: "Carrier mapping error" }],
    });
    markOrderShippedMock.mockRejectedValue(
      new Error("ShipStation API error 409: order already_shipped"),
    );
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    expect(r.alreadyShipped).toBe(true);
    expect(r.path).toBe("v1");
  });

  it("J.6 J — carrier mapping unresolved → error stamped, no SS API calls", async () => {
    seedHappyPath();
    dbState.carrierMap.length = 0; // wipe mapping
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("mapping_no_mapping");
    expect(createFulfillmentsMock).not.toHaveBeenCalled();
    expect(markOrderShippedMock).not.toHaveBeenCalled();
    const shipment = dbState.shipments.get("ship_1") as Record<string, unknown>;
    expect(shipment.shipstation_writeback_error).toContain("mapping_no_mapping");
    expect(shipment.shipstation_writeback_attempts).toBe(1);
  });

  it("low-confidence mapping → blocked_by_low_confidence error", async () => {
    seedHappyPath();
    dbState.carrierMap[0]!.block_auto_writeback = true;
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("blocked_by_low_confidence");
  });

  it("missing shipstation_shipment_id → skips v2, goes straight to v1", async () => {
    seedHappyPath({ shipstation_shipment_id: null });
    markOrderShippedMock.mockResolvedValue({ orderId: 9001 });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("v1");
    expect(createFulfillmentsMock).not.toHaveBeenCalled();
  });

  it("family-wildcard fallback fires telemetry to sensor_readings + warehouse_review_queue", async () => {
    seedHappyPath();
    // Drop the specific service row, add a family wildcard.
    dbState.carrierMap.length = 0;
    dbState.carrierMap.push({
      id: "cm_family",
      workspace_id: "ws_1",
      easypost_carrier: "USPS",
      easypost_service: null,
      shipstation_carrier_code: "stamps_com",
      shipstation_service_code: null,
      mapping_confidence: "verified",
      block_auto_writeback: false,
    });
    createFulfillmentsMock.mockResolvedValue({
      has_errors: false,
      fulfillments: [{ shipment_id: "se-100" }],
    });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(true);
    const sensor = dbState.sensors.find((s) => s.sensor_name === "easypost.unmapped_service_used");
    expect(sensor).toBeDefined();
    const review = dbState.reviewQueue.find((q) => q.category === "carrier_mapping");
    expect(review).toBeDefined();
  });

  it("missing shipment row → returns ok=false without throwing", async () => {
    const r = await run({ warehouse_shipment_id: "missing" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("shipment_not_found");
  });

  it("missing tracking_number → ok=false without API calls", async () => {
    seedHappyPath({ tracking_number: null });
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing_tracking_or_carrier");
  });

  it("v1 fallback fails too (both paths errored) → error stamped, attempts incremented", async () => {
    seedHappyPath();
    createFulfillmentsMock.mockRejectedValue(new Error("v2 down"));
    markOrderShippedMock.mockRejectedValue(new Error("v1 500"));
    const r = await run({ warehouse_shipment_id: "ship_1" });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("v1");
    const shipment = dbState.shipments.get("ship_1") as Record<string, unknown>;
    expect(shipment.shipstation_writeback_error).toContain("v1_fallback_failed");
    expect(shipment.shipstation_writeback_attempts).toBe(1);
  });
});
