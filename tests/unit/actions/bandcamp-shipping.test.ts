import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFrom = vi.fn();
let userRole = "admin";
let shipmentMode: "update" | "select" = "update";
let shipmentSelectRow: Record<string, unknown> = {};
let lastUpdatePayload: Record<string, unknown> | null = null;

function mockUsersTable(role: string) {
  const single = vi.fn().mockResolvedValue({ data: { role }, error: null });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  return { select, eq, single };
}

function mockShipmentsUpdate() {
  const eq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
    lastUpdatePayload = payload;
    return { eq };
  });
  return { update, eq };
}

function mockShipmentsSelect(row: Record<string, unknown>) {
  const single = vi.fn().mockResolvedValue({ data: row, error: null });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  return { select, eq, single };
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(() =>
    Promise.resolve({
      from: mockFrom,
      auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: "user-1" } } })) },
    }),
  ),
  createServiceRoleClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn(() => Promise.resolve({ id: "run-123" })) },
}));

import { setBandcampPaymentId, triggerBandcampMarkShipped } from "@/actions/bandcamp-shipping";

const SHIPMENT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("bandcamp-shipping server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userRole = "admin";
    shipmentMode = "update";
    shipmentSelectRow = {};
    lastUpdatePayload = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === "users") return mockUsersTable(userRole);
      if (table === "warehouse_shipments") {
        return shipmentMode === "update"
          ? mockShipmentsUpdate()
          : mockShipmentsSelect(shipmentSelectRow);
      }
      return {};
    });
  });

  describe("setBandcampPaymentId", () => {
    it("succeeds for valid input", async () => {
      const result = await setBandcampPaymentId({
        shipmentId: SHIPMENT_ID,
        bandcampPaymentId: 42,
      });

      expect(result).toEqual({ success: true });
      expect(lastUpdatePayload).toMatchObject({
        bandcamp_payment_id: 42,
      });
      expect(lastUpdatePayload).not.toHaveProperty("bandcamp_synced_at");
    });

    it("rejects invalid shipment UUID", async () => {
      await expect(
        setBandcampPaymentId({ shipmentId: "not-a-uuid", bandcampPaymentId: 1 }),
      ).rejects.toThrow();
    });

    it("clears bandcamp_synced_at when payment id is null", async () => {
      await setBandcampPaymentId({
        shipmentId: SHIPMENT_ID,
        bandcampPaymentId: null,
      });

      expect(lastUpdatePayload).toMatchObject({
        bandcamp_payment_id: null,
        bandcamp_synced_at: null,
      });
    });
  });

  describe("triggerBandcampMarkShipped", () => {
    beforeEach(() => {
      shipmentMode = "select";
    });

    it("rejects shipment without bandcamp_payment_id", async () => {
      shipmentSelectRow = {
        id: SHIPMENT_ID,
        bandcamp_payment_id: null,
        tracking_number: "1Z999",
      };

      await expect(triggerBandcampMarkShipped({ shipmentId: SHIPMENT_ID })).rejects.toThrow(
        "Shipment has no Bandcamp payment ID",
      );
    });

    it("rejects shipment without tracking_number", async () => {
      shipmentSelectRow = {
        id: SHIPMENT_ID,
        bandcamp_payment_id: 99,
        tracking_number: null,
      };

      await expect(triggerBandcampMarkShipped({ shipmentId: SHIPMENT_ID })).rejects.toThrow(
        "Shipment has no tracking number",
      );
    });
  });

  describe("auth", () => {
    it("throws when user is not staff", async () => {
      userRole = "client";

      await expect(
        setBandcampPaymentId({ shipmentId: SHIPMENT_ID, bandcampPaymentId: 1 }),
      ).rejects.toThrow("Staff access required");
    });
  });
});
