import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock supabase client
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockGte = vi.fn();
const mockLte = vi.fn();
const mockOr = vi.fn();
const mockIn = vi.fn();
const mockOrder = vi.fn();
const mockRange = vi.fn();
const mockLimit = vi.fn();
const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();

// biome-ignore lint/suspicious/noExplicitAny: test mock
const mockFrom: ReturnType<typeof vi.fn<any>> = vi.fn(() => ({
  select: mockSelect,
}));

function wireChain() {
  const chain = {
    eq: mockEq,
    gte: mockGte,
    lte: mockLte,
    or: mockOr,
    in: mockIn,
    order: mockOrder,
    range: mockRange,
    limit: mockLimit,
    single: mockSingle,
    maybeSingle: mockMaybeSingle,
    select: mockSelect,
  };
  // Reset mockFrom to its default implementation each time so mockImplementation()
  // calls in individual tests don't bleed into the next test via vi.clearAllMocks().
  mockFrom.mockImplementation(() => ({ select: mockSelect }));
  mockSelect.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
  mockGte.mockReturnValue(chain);
  mockLte.mockReturnValue(chain);
  mockOr.mockReturnValue(chain);
  mockIn.mockReturnValue(chain);
  mockOrder.mockReturnValue(chain);
  mockRange.mockResolvedValue({ data: [], error: null, count: 0 });
  mockLimit.mockResolvedValue({ data: [], error: null });
  mockSingle.mockResolvedValue({ data: null, error: null });
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(() => Promise.resolve({ from: mockFrom })),
  createServiceRoleClient: vi.fn(() => ({ from: mockFrom })),
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
}));

vi.mock("@/lib/server/bandcamp-shipping-paid", () => ({
  fetchBandcampShippingPaidForPayment: vi.fn(() => Promise.resolve(null)),
}));

// Must import after mocks
import {
  exportShipmentsCsv,
  getShipmentDetail,
  getShipments,
  getShipmentsSummary,
} from "@/actions/shipping";

describe("shipping server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireChain();
  });

  describe("getShipments", () => {
    it("returns paginated results with defaults", async () => {
      mockRange.mockResolvedValueOnce({
        data: [
          {
            id: "1",
            workspace_id: "ws-1",
            tracking_number: "TRK-001",
            carrier: "usps",
            shipping_cost: 5.99,
            label_data: null,
            warehouse_orders: { order_number: "1001" },
            warehouse_shipment_items: [{ id: "i1", sku: null, quantity: 1 }],
            organizations: { name: "Test Org" },
          },
        ],
        error: null,
        count: 1,
      });

      const result = await getShipments({ page: 1, pageSize: 25 });

      expect(result.shipments).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(25);
    });

    it("enriches shipments with fulfillment_total and fulfillment_partial", async () => {
      mockRange.mockResolvedValueOnce({
        data: [
          {
            id: "2",
            workspace_id: "ws-1",
            shipping_cost: 5.99,
            warehouse_shipment_items: [{ id: "i2", sku: "LP-001", quantity: 1 }],
            organizations: { name: "Org" },
          },
        ],
        error: null,
        count: 1,
      });

      // Wire mockFrom so variant + format_cost lookups return data
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              or: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    range: mockRange,
                  }),
                }),
              }),
              order: vi.fn().mockReturnValue({ range: mockRange }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ sku: "LP-001", format_name: "LP" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ format_name: "LP", pick_pack_cost: 2.5, material_cost: 1.0 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: mockSelect };
      });

      const result = await getShipments({ page: 1, pageSize: 25 });
      const row = result.shipments[0] as (typeof result.shipments)[0] & {
        fulfillment_total?: number | null;
        fulfillment_partial?: boolean;
      };
      // fulfillment_total = postage(5.99) + pickPack(2.5) + materials(1.0) = 9.49
      expect(row.fulfillment_total).toBeCloseTo(9.49, 2);
      expect(row.fulfillment_partial).toBe(false);
    });

    it("sets fulfillment_partial=true when SKU has no variant row", async () => {
      mockRange.mockResolvedValueOnce({
        data: [
          {
            id: "3",
            workspace_id: "ws-1",
            shipping_cost: 5.0,
            warehouse_shipment_items: [{ id: "i3", sku: "GHOST-SKU", quantity: 1 }],
            organizations: { name: "Org" },
          },
        ],
        error: null,
        count: 1,
      });

      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({ range: mockRange }),
            }),
          };
        }
        // variant lookup returns empty → unknown SKU
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        return { select: mockSelect };
      });

      const result = await getShipments({ page: 1, pageSize: 25 });
      const row = result.shipments[0] as (typeof result.shipments)[0] & {
        fulfillment_partial?: boolean;
      };
      expect(row.fulfillment_partial).toBe(true);
    });

    it("applies search filter using or()", async () => {
      mockRange.mockResolvedValueOnce({ data: [], error: null, count: 0 });

      await getShipments({ search: "TRK", page: 1, pageSize: 25 });

      expect(mockOr).toHaveBeenCalledWith("tracking_number.ilike.%TRK%,carrier.ilike.%TRK%");
    });

    it("applies org filter", async () => {
      mockRange.mockResolvedValueOnce({ data: [], error: null, count: 0 });

      await getShipments({
        orgId: "550e8400-e29b-41d4-a716-446655440000",
        page: 1,
        pageSize: 25,
      });

      expect(mockEq).toHaveBeenCalledWith("org_id", "550e8400-e29b-41d4-a716-446655440000");
    });

    it("applies date range filters", async () => {
      mockRange.mockResolvedValueOnce({ data: [], error: null, count: 0 });

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
      await expect(getShipments({ page: 1, pageSize: 300 })).rejects.toThrow();
    });
  });

  describe("getShipmentsSummary", () => {
    it("returns summary stats", async () => {
      const mockData = [
        { id: "1", shipping_cost: 5.99 },
        { id: "2", shipping_cost: 8.5 },
        { id: "3", shipping_cost: null },
      ];

      mockFrom.mockImplementationOnce(() => ({
        select: () => ({
          eq: () => Promise.resolve({ data: mockData, error: null, count: 3 }),
        }),
      }));

      const result = await getShipmentsSummary();

      expect(result.totalCount).toBe(3);
      expect(result.totalPostage).toBeCloseTo(14.49);
      expect(result.avgCost).toBeCloseTo(4.83);
    });

    it("returns zeros when no shipments", async () => {
      mockFrom.mockImplementationOnce(() => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null, count: 0 }),
        }),
      }));

      const result = await getShipmentsSummary();

      expect(result.totalCount).toBe(0);
      expect(result.totalPostage).toBe(0);
      expect(result.avgCost).toBe(0);
    });
  });

  describe("getShipmentDetail", () => {
    it("rejects non-UUID id", async () => {
      await expect(getShipmentDetail("not-a-uuid")).rejects.toThrow();
    });

    it("fetches shipment with items, events, and cost breakdown", async () => {
      const shipmentId = "550e8400-e29b-41d4-a716-446655440000";

      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: shipmentId,
                    workspace_id: "ws-1",
                    tracking_number: "1Z123",
                    carrier: "ups",
                    shipping_cost: 12.5,
                    label_data: {
                      shipTo: {
                        name: "John Doe",
                        city: "Austin",
                        state: "TX",
                        postalCode: "78701",
                      },
                    },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_shipment_items") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [{ id: "item-1", sku: "LP-001", quantity: 1, product_title: "Test LP" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_tracking_events") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [{ id: "evt-1", status: "shipped" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ sku: "LP-001", format_name: "LP" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ format_name: "LP", pick_pack_cost: 2.5, material_cost: 1.0 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: mockSelect };
      });

      const result = await getShipmentDetail(shipmentId);
      expect(result).toHaveProperty("shipment");
      expect(result).toHaveProperty("items");
      expect(result).toHaveProperty("trackingEvents");
      expect(result).toHaveProperty("costBreakdown");
      expect(result).toHaveProperty("recipient");
      expect(result.recipient?.name).toBe("John Doe");
      expect(result.costBreakdown.postage).toBe(12.5);
      expect(result.costBreakdown.pickPack).toBe(2.5);
      expect(result.costBreakdown.materials).toBe(1.0);
      expect(result.costBreakdown.total).toBe(16.0);
      // New fields from plan
      expect(result.costBreakdown.partial).toBe(false);
      expect(result.costBreakdown.unknownSkus).toEqual([]);
      expect(result.costBreakdown.missingFormatCosts).toEqual([]);
    });

    it("returns partial=true when variant not found in workspace", async () => {
      const shipmentId = "550e8400-e29b-41d4-a716-446655440099";

      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: shipmentId,
                    workspace_id: "ws-other",
                    shipping_cost: 5.0,
                    label_data: null,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_shipment_items") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [{ id: "item-x", sku: "UNKNOWN-SKU", quantity: 1 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_tracking_events") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        // variant lookup returns empty → SKU unknown in this workspace
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        return { select: mockSelect };
      });

      const result = await getShipmentDetail(shipmentId);
      expect(result.costBreakdown.partial).toBe(true);
      expect(result.costBreakdown.unknownSkus).toContain("UNKNOWN-SKU");
      expect(result.costBreakdown.total).toBe(5.0); // only postage
    });

    it("normalizes Pirate Ship label_data recipient address1/zip into street1/postalCode", async () => {
      const shipmentId = "550e8400-e29b-41d4-a716-446655440001";

      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: shipmentId,
                    tracking_number: "AH0Y1",
                    carrier: "Asendia",
                    shipping_cost: 10,
                    label_data: {
                      recipient: {
                        name: "International Buyer",
                        address1: "456 Rue Example",
                        city: "Paris",
                        zip: "75001",
                        country: "FR",
                      },
                    },
                    warehouse_orders: null,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_shipment_items") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "warehouse_tracking_events") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        return { select: mockSelect };
      });

      const result = await getShipmentDetail(shipmentId);
      expect(result.recipient?.street1).toBe("456 Rue Example");
      expect(result.recipient?.postalCode).toBe("75001");
      expect(result.recipient?.country).toBe("FR");
    });
  });

  describe("exportShipmentsCsv", () => {
    it("returns CSV with headers", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: "1",
                      workspace_id: "ws-1",
                      tracking_number: "TRK-001",
                      carrier: "usps",
                      service: "priority",
                      ship_date: "2026-03-15",
                      shipping_cost: 5.99,
                      label_data: {
                        shipTo: {
                          name: "Jane",
                          city: "NYC",
                          state: "NY",
                          postalCode: "10001",
                          country: "US",
                        },
                      },
                      warehouse_orders: { order_number: "1001" },
                      warehouse_shipment_items: [{ sku: "LP-001", quantity: 2 }],
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ sku: "LP-001", format_name: "LP" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_format_costs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ format_name: "LP", pick_pack_cost: 2.5, material_cost: 1.0 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: mockSelect };
      });

      const csv = await exportShipmentsCsv();
      const lines = csv.split("\n");

      expect(lines[0]).toBe(
        "order_number,ship_date,carrier,service,tracking_number,recipient,city,state,zip,country,items,postage,materials,pick_pack,fulfillment_total",
      );
      expect(lines).toHaveLength(2); // header + 1 row
      expect(lines[1]).toContain("1001");
      expect(lines[1]).toContain("TRK-001");
      expect(lines[1]).toContain("Jane");
    });

    it("escapes CSV fields with commas", async () => {
      mockFrom.mockImplementation((table) => {
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: "1",
                      workspace_id: "ws-1",
                      tracking_number: "TRK-001",
                      carrier: "usps",
                      service: "priority",
                      ship_date: "2026-03-15",
                      shipping_cost: 5.99,
                      label_data: {
                        shipTo: {
                          name: "Doe, Jane",
                          city: "NYC",
                          state: "NY",
                          postalCode: "10001",
                          country: "US",
                        },
                      },
                      warehouse_orders: { order_number: "1001" },
                      warehouse_shipment_items: [],
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        // No items → no SKU lookups needed; return safe empty mock
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      });

      const csv = await exportShipmentsCsv();
      expect(csv).toContain('"Doe, Jane"');
    });
  });
});
