import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock supabase client
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockGte = vi.fn();
const mockLte = vi.fn();
const mockOrder = vi.fn();
const mockRange = vi.fn();
const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();

const mockFrom = vi.fn(() => ({
  select: mockSelect,
}));

mockSelect.mockReturnValue({
  eq: mockEq,
  gte: mockGte,
  lte: mockLte,
  order: mockOrder,
  range: mockRange,
  single: mockSingle,
});

mockEq.mockReturnValue({
  eq: mockEq,
  gte: mockGte,
  lte: mockLte,
  order: mockOrder,
  range: mockRange,
  single: mockSingle,
  maybeSingle: mockMaybeSingle,
});

mockGte.mockReturnValue({
  eq: mockEq,
  gte: mockGte,
  lte: mockLte,
  order: mockOrder,
  range: mockRange,
});

mockLte.mockReturnValue({
  eq: mockEq,
  order: mockOrder,
  range: mockRange,
});

mockOrder.mockReturnValue({
  range: mockRange,
  order: mockOrder,
});

mockRange.mockResolvedValue({
  data: [],
  error: null,
  count: 0,
});

mockSingle.mockResolvedValue({
  data: { id: "test-id", tracking_number: "1Z123" },
  error: null,
});

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(() => Promise.resolve({ from: mockFrom })),
}));

// Must import after mocks
import { getShipmentDetail, getShipments } from "@/actions/shipping";

describe("shipping server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset chain
    mockSelect.mockReturnValue({
      eq: mockEq,
      gte: mockGte,
      lte: mockLte,
      order: mockOrder,
      range: mockRange,
      single: mockSingle,
    });
    mockEq.mockReturnValue({
      eq: mockEq,
      gte: mockGte,
      lte: mockLte,
      order: mockOrder,
      range: mockRange,
      single: mockSingle,
      maybeSingle: mockMaybeSingle,
    });
    mockGte.mockReturnValue({
      eq: mockEq,
      gte: mockGte,
      lte: mockLte,
      order: mockOrder,
      range: mockRange,
    });
    mockLte.mockReturnValue({
      eq: mockEq,
      order: mockOrder,
      range: mockRange,
    });
    mockOrder.mockReturnValue({
      range: mockRange,
      order: mockOrder,
    });
    mockRange.mockResolvedValue({
      data: [],
      error: null,
      count: 0,
    });
  });

  describe("getShipments", () => {
    it("returns paginated results with defaults", async () => {
      mockRange.mockResolvedValueOnce({
        data: [{ id: "1", tracking_number: "TRK-001" }],
        error: null,
        count: 1,
      });

      const result = await getShipments({ page: 1, pageSize: 25 });

      expect(result.shipments).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(25);
    });

    it("applies org filter", async () => {
      mockRange.mockResolvedValueOnce({
        data: [],
        error: null,
        count: 0,
      });

      await getShipments({
        orgId: "550e8400-e29b-41d4-a716-446655440000",
        page: 1,
        pageSize: 25,
      });

      expect(mockEq).toHaveBeenCalledWith("org_id", "550e8400-e29b-41d4-a716-446655440000");
    });

    it("applies date range filters", async () => {
      mockRange.mockResolvedValueOnce({
        data: [],
        error: null,
        count: 0,
      });

      await getShipments({
        dateFrom: "2024-01-01",
        dateTo: "2024-01-31",
        page: 1,
        pageSize: 25,
      });

      expect(mockGte).toHaveBeenCalledWith("ship_date", "2024-01-01");
      expect(mockLte).toHaveBeenCalledWith("ship_date", "2024-01-31");
    });

    it("rejects invalid page size", async () => {
      await expect(getShipments({ page: 1, pageSize: 200 })).rejects.toThrow();
    });
  });

  describe("getShipmentDetail", () => {
    it("rejects non-UUID id", async () => {
      await expect(getShipmentDetail("not-a-uuid")).rejects.toThrow();
    });

    it("fetches shipment with items and events", async () => {
      const shipmentId = "550e8400-e29b-41d4-a716-446655440000";

      // Mock parallel calls
      mockSingle.mockResolvedValueOnce({
        data: { id: shipmentId, tracking_number: "1Z123" },
        error: null,
      });
      mockOrder.mockReturnValue({
        range: mockRange,
        order: mockOrder,
      });
      // For items and events queries, mock the full chain
      const mockItemsResult = { data: [{ id: "item-1", sku: "TEST-001" }], error: null };
      const mockEventsResult = { data: [{ id: "evt-1", status: "shipped" }], error: null };

      // Since Promise.all is used, we need the from mock to handle multiple tables
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: shipmentId, tracking_number: "1Z123" },
                error: null,
              }),
              order: vi
                .fn()
                .mockResolvedValue(callCount === 2 ? mockItemsResult : mockEventsResult),
            }),
          }),
        };
      });

      const result = await getShipmentDetail(shipmentId);
      expect(result).toHaveProperty("shipment");
      expect(result).toHaveProperty("items");
      expect(result).toHaveProperty("trackingEvents");
    });
  });
});
