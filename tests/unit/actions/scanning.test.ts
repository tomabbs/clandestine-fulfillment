import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockUpsert = vi.fn();
const mockFrom = vi.fn();
const mockSingle = vi.fn();
const mockLimit = vi.fn();
const mockEq = vi.fn();
const mockOr = vi.fn();

function setupChain(data: unknown, error: unknown = null) {
  mockSingle.mockResolvedValue({ data, error });
  mockLimit.mockReturnValue({ single: mockSingle });
  mockEq.mockReturnValue({ single: mockSingle, limit: mockLimit });
  mockOr.mockReturnValue({ limit: mockLimit, single: mockSingle, eq: mockEq });
  mockSelect.mockReturnValue({ or: mockOr, eq: mockEq, limit: mockLimit, single: mockSingle });
  mockUpdate.mockReturnValue({ eq: mockEq });
  mockUpsert.mockResolvedValue({ error: null });
  mockInsert.mockResolvedValue({ error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    upsert: mockUpsert,
  });
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    from: mockFrom,
  })),
}));

// Phase 4d: every action now goes through requireStaff() first; default the
// mock to "staff present" so existing happy-path tests still exercise the
// downstream Supabase calls. The auth-rejection test below overrides this.
const mockRequireStaff = vi.fn(async () => ({ userId: "u1", workspaceId: "w1" }));
vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: () => mockRequireStaff(),
}));

// Import after mocks
let lookupBarcode: (barcode: string) => Promise<Record<string, unknown>>;
let lookupLocation: (barcode: string) => Promise<Record<string, unknown>>;
let submitCount: (
  locationId: string,
  counts: Array<{ sku: string; scannedCount: number; expectedCount: number }>,
) => Promise<Record<string, unknown>>;
let recordReceivingScan: (
  inboundItemId: string,
  quantity: number,
) => Promise<Record<string, unknown>>;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import("../../../src/actions/scanning");
  lookupBarcode = mod.lookupBarcode;
  lookupLocation = mod.lookupLocation;
  submitCount = mod.submitCount;
  recordReceivingScan = mod.recordReceivingScan;
});

describe("lookupBarcode", () => {
  it("returns error for empty barcode", async () => {
    const result = await lookupBarcode("");
    expect(result).toEqual({ error: "Invalid barcode" });
  });

  it("returns error when variant not found", async () => {
    setupChain(null, { message: "not found" });
    const result = await lookupBarcode("UNKNOWN-SKU");
    expect(result).toEqual({ error: "Product not found" });
  });

  it("returns product data when variant found", async () => {
    const mockVariant = { id: "v1", product_id: "p1", sku: "TEST-001", barcode: "123456" };
    const mockProduct = { id: "p1", title: "Test Product" };
    const mockInventory = { id: "inv1", available: 10, committed: 2, incoming: 5 };
    const mockLocations = [
      { id: "vl1", location_id: "loc1", quantity: 8, warehouse_locations: { name: "Shelf A" } },
    ];

    // Chain: first call for variant, then product, inventory, locations
    mockFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return {
          select: () => ({
            or: () => ({
              limit: () => ({
                single: () => Promise.resolve({ data: mockVariant, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "warehouse_products") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: mockProduct, error: null }),
            }),
          }),
        };
      }
      if (table === "warehouse_inventory_levels") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: mockInventory, error: null }),
            }),
          }),
        };
      }
      if (table === "warehouse_variant_locations") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: mockLocations, error: null }),
          }),
        };
      }
      return { select: mockSelect };
    });

    const result = await lookupBarcode("TEST-001");
    expect(result).toEqual({
      variant: mockVariant,
      product: mockProduct,
      inventory: mockInventory,
      locations: mockLocations,
    });
  });
});

describe("lookupLocation", () => {
  it("returns error for empty barcode", async () => {
    const result = await lookupLocation("");
    expect(result).toEqual({ error: "Invalid barcode" });
  });

  it("returns error when location not found", async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({
        or: () => ({
          eq: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "not found" } }),
            }),
          }),
        }),
      }),
    }));

    const result = await lookupLocation("UNKNOWN-LOC");
    expect(result).toEqual({ error: "Location not found" });
  });

  it("returns location data when found by barcode", async () => {
    const mockLocation = {
      id: "loc-1",
      name: "Shelf A-1",
      barcode: "LOC-001",
      location_type: "shelf",
      is_active: true,
    };

    mockFrom.mockImplementation(() => ({
      select: () => ({
        or: () => ({
          eq: () => ({
            limit: () => ({
              single: () => Promise.resolve({ data: mockLocation, error: null }),
            }),
          }),
        }),
      }),
    }));

    const result = await lookupLocation("LOC-001");
    expect(result).toEqual({ location: mockLocation });
  });
});

describe("submitCount", () => {
  it("returns error for invalid location ID", async () => {
    const result = await submitCount("not-a-uuid", []);
    expect(result).toHaveProperty("error");
  });

  it("returns error for empty counts array", async () => {
    const result = await submitCount("550e8400-e29b-41d4-a716-446655440000", []);
    expect(result).toHaveProperty("error");
  });

  it("detects mismatches and creates review queue items", async () => {
    const locationId = "550e8400-e29b-41d4-a716-446655440000";
    const counts = [
      { sku: "SKU-A", scannedCount: 8, expectedCount: 10 },
      { sku: "SKU-B", scannedCount: 5, expectedCount: 5 },
    ];

    // Mock variant lookup for matched items
    mockFrom.mockImplementation((table: string) => {
      if (table === "warehouse_review_queue") {
        return {
          upsert: () => Promise.resolve({ error: null }),
        };
      }
      if (table === "warehouse_product_variants") {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                single: () => Promise.resolve({ data: { id: "v-b" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "warehouse_variant_locations") {
        return {
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
      }
      return { select: mockSelect, upsert: mockUpsert };
    });

    const result = await submitCount(locationId, counts);
    expect(result).toEqual({
      matchedCount: 1,
      mismatchCount: 1,
      mismatches: [{ sku: "SKU-A", expected: 10, scanned: 8 }],
    });
  });

  it("all matching counts returns zero mismatches", async () => {
    const locationId = "550e8400-e29b-41d4-a716-446655440000";
    const counts = [
      { sku: "SKU-A", scannedCount: 10, expectedCount: 10 },
      { sku: "SKU-B", scannedCount: 5, expectedCount: 5 },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "warehouse_product_variants") {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                single: () => Promise.resolve({ data: { id: "v-x" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "warehouse_variant_locations") {
        return {
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
      }
      return { select: mockSelect, upsert: mockUpsert };
    });

    const result = await submitCount(locationId, counts);
    expect(result).toEqual({
      matchedCount: 2,
      mismatchCount: 0,
      mismatches: [],
    });
  });

  it("flags large discrepancies as high severity", async () => {
    const locationId = "550e8400-e29b-41d4-a716-446655440000";
    const counts = [
      { sku: "SKU-A", scannedCount: 0, expectedCount: 20 }, // delta > 5 → high
    ];

    let upsertPayload: unknown = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === "warehouse_review_queue") {
        return {
          upsert: (data: unknown) => {
            upsertPayload = data;
            return Promise.resolve({ error: null });
          },
        };
      }
      return { select: mockSelect };
    });

    await submitCount(locationId, counts);
    expect(upsertPayload).toBeTruthy();
    expect((upsertPayload as Array<Record<string, unknown>>)[0].severity).toBe("high");
  });
});

describe("recordReceivingScan", () => {
  it("returns error for invalid UUID", async () => {
    const result = await recordReceivingScan("not-a-uuid", 1);
    expect(result).toHaveProperty("error");
  });

  it("returns error for zero quantity", async () => {
    const result = await recordReceivingScan("550e8400-e29b-41d4-a716-446655440000", 0);
    expect(result).toHaveProperty("error");
  });

  it("returns error when item not found", async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: { message: "not found" } }),
        }),
      }),
    }));

    const result = await recordReceivingScan("550e8400-e29b-41d4-a716-446655440000", 1);
    expect(result).toEqual({ error: "Inbound item not found" });
  });

  it("increments received quantity correctly", async () => {
    const mockItem = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      sku: "SKU-X",
      expected_quantity: 10,
      received_quantity: 3,
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === "warehouse_inbound_items") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: mockItem, error: null }),
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      return { select: mockSelect };
    });

    const result = await recordReceivingScan(mockItem.id, 1);
    expect(result).toEqual({
      inboundItemId: mockItem.id,
      sku: "SKU-X",
      previousReceived: 3,
      newReceived: 4,
      expectedQuantity: 10,
      isComplete: false,
      isOver: false,
    });
  });

  it("detects completion when received meets expected", async () => {
    const mockItem = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      sku: "SKU-X",
      expected_quantity: 5,
      received_quantity: 4,
    };

    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: mockItem, error: null }),
        }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }));

    const result = await recordReceivingScan(mockItem.id, 1);
    expect(result).toMatchObject({
      isComplete: true,
      isOver: false,
      newReceived: 5,
    });
  });

  it("detects over-receiving", async () => {
    const mockItem = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      sku: "SKU-X",
      expected_quantity: 5,
      received_quantity: 5,
    };

    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: mockItem, error: null }),
        }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }));

    const result = await recordReceivingScan(mockItem.id, 1);
    expect(result).toMatchObject({
      isComplete: true,
      isOver: true,
      newReceived: 6,
    });
  });
});

// Phase 4d (finish-line plan v4) — auth gate enforcement
describe("scanning Server Actions reject unauthenticated callers", () => {
  it("lookupLocation throws when requireStaff rejects", async () => {
    mockRequireStaff.mockRejectedValueOnce(new Error("Authentication required"));
    await expect(lookupLocation("BIN-1")).rejects.toThrow(/Authentication required/);
  });

  it("lookupBarcode throws when requireStaff rejects", async () => {
    mockRequireStaff.mockRejectedValueOnce(new Error("Authentication required"));
    await expect(lookupBarcode("SKU-X")).rejects.toThrow(/Authentication required/);
  });

  it("submitCount throws when requireStaff rejects", async () => {
    mockRequireStaff.mockRejectedValueOnce(new Error("Staff access required"));
    await expect(
      submitCount("550e8400-e29b-41d4-a716-446655440000", [
        { sku: "S", scannedCount: 0, expectedCount: 0 },
      ]),
    ).rejects.toThrow(/Staff access required/);
  });

  it("recordReceivingScan throws when requireStaff rejects", async () => {
    mockRequireStaff.mockRejectedValueOnce(new Error("Staff access required"));
    await expect(recordReceivingScan("550e8400-e29b-41d4-a716-446655440000", 1)).rejects.toThrow(
      /Staff access required/,
    );
  });
});
