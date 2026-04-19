// Phase 3.2 — post-label-purchase orchestrator tests.
//
// We assert the orchestrator dispatches the right downstream tasks based on
// which fields the persisted warehouse_shipments row has populated. Each
// dispatch is wrapped in try/catch so a missing-task failure (Phase 4.3 not
// yet shipped, etc.) doesn't regress earlier flows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTrigger, mockShipment } = vi.hoisted(() => ({
  mockTrigger: vi.fn().mockResolvedValue({ id: "run-1" }),
  mockShipment: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: unknown }) => def,
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  tasks: { trigger: mockTrigger },
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockShipment,
        }),
      }),
    }),
  }),
}));

import { postLabelPurchaseTask } from "@/trigger/tasks/post-label-purchase";

const run = (
  postLabelPurchaseTask as unknown as {
    run: (p: { warehouse_shipment_id: string }) => Promise<{ ok: true; triggered: string[] }>;
  }
).run;

beforeEach(() => {
  mockTrigger.mockReset();
  mockTrigger.mockResolvedValue({ id: "run-1" });
  mockShipment.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("postLabelPurchaseTask (Phase 3.2)", () => {
  it("returns triggered=[] when shipment row is missing", async () => {
    mockShipment.mockResolvedValue({ data: null, error: null });
    const result = await run({ warehouse_shipment_id: "missing" });
    expect(result.ok).toBe(true);
    expect(result.triggered).toEqual([]);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("fulfillment shipment → triggers aftership-register + mark-platform-fulfilled (no SS)", async () => {
    mockShipment.mockResolvedValue({
      data: {
        id: "ship_1",
        label_source: "easypost",
        tracking_number: "TRK1",
        carrier: "USPS",
        order_id: "ord_1",
        mailorder_id: null,
        shipstation_order_id: null,
        bandcamp_payment_id: 12345,
      },
      error: null,
    });
    const result = await run({ warehouse_shipment_id: "ship_1" });
    expect(result.triggered).toContain("aftership-register");
    expect(result.triggered).toContain("mark-platform-fulfilled");
    expect(result.triggered).not.toContain("shipstation-mark-shipped");
    expect(result.triggered).not.toContain("mark-mailorder-fulfilled");
  });

  it("mailorder shipment → triggers aftership-register + mark-mailorder-fulfilled", async () => {
    mockShipment.mockResolvedValue({
      data: {
        id: "ship_2",
        label_source: "easypost",
        tracking_number: "TRK2",
        carrier: "USPS",
        order_id: null,
        mailorder_id: "mail_1",
        shipstation_order_id: null,
        bandcamp_payment_id: null,
      },
      error: null,
    });
    const result = await run({ warehouse_shipment_id: "ship_2" });
    expect(result.triggered).toContain("mark-mailorder-fulfilled");
    expect(result.triggered).not.toContain("mark-platform-fulfilled");
  });

  it("shipstation shipment → triggers aftership-register + shipstation-mark-shipped only", async () => {
    mockShipment.mockResolvedValue({
      data: {
        id: "ship_3",
        label_source: "easypost",
        tracking_number: "TRK3",
        carrier: "USPS",
        order_id: null,
        mailorder_id: null,
        shipstation_order_id: "9001",
        bandcamp_payment_id: null,
      },
      error: null,
    });
    const result = await run({ warehouse_shipment_id: "ship_3" });
    expect(result.triggered).toContain("aftership-register");
    expect(result.triggered).toContain("shipstation-mark-shipped");
    expect(result.triggered).not.toContain("mark-platform-fulfilled");
    expect(result.triggered).not.toContain("mark-mailorder-fulfilled");
  });

  it("a failing trigger is logged but does not abort other dispatches", async () => {
    mockShipment.mockResolvedValue({
      data: {
        id: "ship_4",
        label_source: "easypost",
        tracking_number: "TRK4",
        carrier: "USPS",
        order_id: null,
        mailorder_id: null,
        shipstation_order_id: "9002",
        bandcamp_payment_id: null,
      },
      error: null,
    });
    // First call (aftership) fails, second (shipstation-mark-shipped) succeeds.
    mockTrigger
      .mockRejectedValueOnce(new Error("aftership down"))
      .mockResolvedValue({ id: "run-x" });
    const result = await run({ warehouse_shipment_id: "ship_4" });
    expect(result.triggered).not.toContain("aftership-register");
    expect(result.triggered).toContain("shipstation-mark-shipped");
  });

  it("SS + warehouse_orders both populated (multi-source) → fans out to ALL relevant tasks", async () => {
    // Edge case: same shipment links a SS order + a warehouse_orders row (e.g.
    // staff manually linked them post-purchase). Orchestrator should hit both
    // platform-fulfilled paths.
    mockShipment.mockResolvedValue({
      data: {
        id: "ship_5",
        label_source: "easypost",
        tracking_number: "TRK5",
        carrier: "USPS",
        order_id: "ord_5",
        mailorder_id: null,
        shipstation_order_id: "9005",
        bandcamp_payment_id: null,
      },
      error: null,
    });
    const result = await run({ warehouse_shipment_id: "ship_5" });
    expect(result.triggered).toContain("aftership-register");
    expect(result.triggered).toContain("shipstation-mark-shipped");
    expect(result.triggered).toContain("mark-platform-fulfilled");
  });
});
