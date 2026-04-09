import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/clients/shipstation", () => ({
  fetchOrders: vi.fn(() => Promise.resolve({ orders: [], total: 0, pages: 0 })),
}));

import { getShipStationOrders } from "@/actions/shipstation-orders";
import { fetchOrders } from "@/lib/clients/shipstation";
import { requireStaff } from "@/lib/server/auth-context";

describe("shipstation-orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getShipStationOrders", () => {
    it("calls fetchOrders with default filters", async () => {
      await getShipStationOrders();

      expect(fetchOrders).toHaveBeenCalledWith({
        orderStatus: "awaiting_shipment",
        page: 1,
        pageSize: 500,
      });
    });

    it("passes custom status and page params", async () => {
      await getShipStationOrders({ status: "shipped", page: 3, pageSize: 100 });

      expect(fetchOrders).toHaveBeenCalledWith({
        orderStatus: "shipped",
        page: 3,
        pageSize: 100,
      });
    });
  });

  describe("auth", () => {
    it("requires staff role", async () => {
      vi.mocked(requireStaff).mockRejectedValueOnce(new Error("Forbidden"));

      await expect(getShipStationOrders()).rejects.toThrow("Forbidden");
      expect(fetchOrders).not.toHaveBeenCalled();
    });
  });
});
