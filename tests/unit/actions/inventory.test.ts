import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock supabase
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockEq = vi.fn();
const mockOr = vi.fn();
const mockRange = vi.fn();
const mockOrder = vi.fn();
const mockSingle = vi.fn();
const mockLimit = vi.fn();
const mockGetUser = vi.fn();

function createChain() {
  const chain = {
    select: mockSelect,
    eq: mockEq,
    or: mockOr,
    range: mockRange,
    order: mockOrder,
    single: mockSingle,
    limit: mockLimit,
  };
  // Each chain method returns the chain for fluent API
  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }
  return chain;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({
    from: mockFrom,
    rpc: mockRpc,
    auth: { getUser: mockGetUser },
  }),
}));

const mockRecordInventoryChange = vi.fn();
vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: (...args: unknown[]) => mockRecordInventoryChange(...args),
}));

import { adjustInventory, getInventoryDetail, getInventoryLevels } from "@/actions/inventory";

describe("inventory Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInventoryLevels", () => {
    it("queries Postgres with default pagination", async () => {
      const chain = createChain();
      mockFrom.mockReturnValue(chain);
      mockOrder.mockResolvedValue({ data: [], error: null, count: 0 });

      const result = await getInventoryLevels();

      expect(mockFrom).toHaveBeenCalledWith("warehouse_inventory_levels");
      expect(mockSelect).toHaveBeenCalledWith(expect.any(String), { count: "exact" });
      expect(mockRange).toHaveBeenCalledWith(0, 49); // page 1, pageSize 50
      expect(mockOrder).toHaveBeenCalledWith("sku", { ascending: true });
      expect(result).toEqual({
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
      });
    });

    it("applies org filter when provided", async () => {
      const chain = createChain();
      mockFrom.mockReturnValue(chain);
      mockOrder.mockResolvedValue({ data: [], error: null, count: 0 });

      await getInventoryLevels({ orgId: "org-1" });

      expect(mockEq).toHaveBeenCalledWith(
        "warehouse_product_variants.warehouse_products.org_id",
        "org-1",
      );
    });

    it("applies format filter when provided", async () => {
      const chain = createChain();
      mockFrom.mockReturnValue(chain);
      mockOrder.mockResolvedValue({ data: [], error: null, count: 0 });

      await getInventoryLevels({ format: "LP" });

      expect(mockEq).toHaveBeenCalledWith("warehouse_product_variants.format_name", "LP");
    });

    it("applies search filter", async () => {
      const chain = createChain();
      mockFrom.mockReturnValue(chain);
      mockOrder.mockResolvedValue({ data: [], error: null, count: 0 });

      await getInventoryLevels({ search: "vinyl" });

      expect(mockOr).toHaveBeenCalledWith(expect.stringContaining("vinyl"));
    });

    it("calculates correct pagination offset", async () => {
      const chain = createChain();
      mockFrom.mockReturnValue(chain);
      mockOrder.mockResolvedValue({ data: [], error: null, count: 0 });

      await getInventoryLevels({ page: 3, pageSize: 10 });

      expect(mockRange).toHaveBeenCalledWith(20, 29);
    });

    it("throws on Supabase error", async () => {
      const chain = createChain();
      mockFrom.mockReturnValue(chain);
      mockOrder.mockResolvedValue({
        data: null,
        error: { message: "table not found" },
        count: null,
      });

      await expect(getInventoryLevels()).rejects.toThrow("Failed to fetch inventory levels");
    });

    it("maps row data correctly", async () => {
      const chain = createChain();
      mockFrom.mockReturnValue(chain);
      mockOrder.mockResolvedValue({
        data: [
          {
            id: "il-1",
            variant_id: "v-1",
            sku: "SKU-001",
            available: 10,
            committed: 2,
            incoming: 5,
            warehouse_product_variants: {
              id: "v-1",
              title: "Black Vinyl",
              format_name: "LP",
              bandcamp_url: "https://bc.example.com",
              warehouse_products: {
                id: "p-1",
                title: "Test Album",
                status: "active",
                org_id: "org-1",
                images: [{ src: "https://img.example.com/1.jpg" }],
                organizations: { id: "org-1", name: "Test Label" },
              },
            },
          },
        ],
        error: null,
        count: 1,
      });

      const result = await getInventoryLevels();

      expect(result.rows[0]).toEqual({
        variantId: "v-1",
        sku: "SKU-001",
        productTitle: "Test Album",
        variantTitle: "Black Vinyl",
        orgId: "org-1",
        orgName: "Test Label",
        formatName: "LP",
        available: 10,
        committed: 2,
        incoming: 5,
        imageSrc: "https://img.example.com/1.jpg",
        bandcampUrl: "https://bc.example.com",
        status: "active",
      });
    });
  });

  describe("adjustInventory", () => {
    it("authenticates user and calls recordInventoryChange", async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: "auth-user-1" } },
      });

      const userChain = createChain();
      mockFrom.mockReturnValue(userChain);
      mockSingle.mockResolvedValue({
        data: { workspace_id: "ws-1" },
        error: null,
      });

      mockRecordInventoryChange.mockResolvedValue({
        success: true,
        newQuantity: 8,
        alreadyProcessed: false,
      });

      const result = await adjustInventory("SKU-001", -2, "Damaged stock");

      expect(mockRecordInventoryChange).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        sku: "SKU-001",
        delta: -2,
        source: "manual",
        correlationId: expect.stringMatching(/^manual:auth-user-1:\d+$/),
        metadata: { reason: "Damaged stock", adjusted_by: "auth-user-1" },
      });
      expect(result).toEqual({ success: true, newQuantity: 8 });
    });

    it("throws when not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      await expect(adjustInventory("SKU-001", -2, "test")).rejects.toThrow("Not authenticated");
    });

    it("throws when user workspace lookup fails", async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: "auth-user-1" } },
      });

      const userChain = createChain();
      mockFrom.mockReturnValue(userChain);
      mockSingle.mockResolvedValue({ data: null, error: { message: "not found" } });

      await expect(adjustInventory("SKU-001", -2, "test")).rejects.toThrow(
        "Failed to resolve workspace",
      );
    });
  });

  describe("getInventoryDetail", () => {
    function createIndependentChain(terminalResult: unknown) {
      const chain: Record<string, ReturnType<typeof vi.fn>> = {};
      const handler: ProxyHandler<Record<string, ReturnType<typeof vi.fn>>> = {
        get(_target, prop: string) {
          if (!chain[prop]) {
            chain[prop] = vi
              .fn()
              .mockReturnValue(new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, handler));
          }
          return chain[prop];
        },
      };
      const proxy = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, handler);
      // Set the terminal method to resolve with the result
      return {
        proxy,
        setTerminal: (method: string) => {
          // Access proxy to trigger get trap if not yet created
          (proxy as Record<string, unknown>)[method];
          const mockFn = chain[method] as ReturnType<typeof vi.fn>;
          mockFn.mockResolvedValue(terminalResult);
        },
      };
    }

    it("fetches level, locations, and activity for a SKU", async () => {
      // Call 1: .from("warehouse_inventory_levels").select(...).eq(...).single()
      const level = createIndependentChain(null);
      level.setTerminal("single");
      level.proxy.single.mockResolvedValue({
        data: { sku: "SKU-001", available: 10, committed: 2, incoming: 5, variant_id: "v-1" },
        error: null,
      });

      // Call 2: .from("warehouse_product_variants").select(...).eq(...).single()
      const variant = createIndependentChain(null);
      variant.setTerminal("single");
      variant.proxy.single.mockResolvedValue({
        data: { bandcamp_url: "https://bc.example.com" },
      });

      // Call 3: .from("warehouse_variant_locations").select(...).eq(...)
      const locations = createIndependentChain(null);
      locations.setTerminal("eq");
      locations.proxy.eq.mockResolvedValue({
        data: [
          {
            quantity: 8,
            location_id: "loc-1",
            warehouse_locations: { id: "loc-1", name: "Shelf A", location_type: "shelf" },
          },
        ],
      });

      // Call 4: .from("warehouse_inventory_activity").select(...).eq(...).order(...).limit(...)
      const activity = createIndependentChain(null);
      activity.setTerminal("limit");
      activity.proxy.limit.mockResolvedValue({
        data: [
          {
            id: "act-1",
            delta: -2,
            source: "shopify",
            correlation_id: "wh:123",
            created_at: "2026-03-15T00:00:00Z",
            metadata: {},
          },
        ],
      });

      mockFrom
        .mockReturnValueOnce(level.proxy)
        .mockReturnValueOnce(variant.proxy)
        .mockReturnValueOnce(locations.proxy)
        .mockReturnValueOnce(activity.proxy);

      const result = await getInventoryDetail("SKU-001");

      expect(result.level).toEqual({
        sku: "SKU-001",
        available: 10,
        committed: 2,
        incoming: 5,
      });
      expect(result.locations).toEqual([
        {
          locationId: "loc-1",
          locationName: "Shelf A",
          locationType: "shelf",
          quantity: 8,
        },
      ]);
      expect(result.recentActivity).toEqual([
        {
          id: "act-1",
          delta: -2,
          source: "shopify",
          correlationId: "wh:123",
          createdAt: "2026-03-15T00:00:00Z",
          metadata: {},
        },
      ]);
      expect(result.bandcampUrl).toBe("https://bc.example.com");
    });

    it("throws when SKU not found", async () => {
      const level = createIndependentChain(null);
      level.setTerminal("single");
      level.proxy.single.mockResolvedValue({
        data: null,
        error: { message: "not found" },
      });
      mockFrom.mockReturnValue(level.proxy);

      await expect(getInventoryDetail("SKU-MISSING")).rejects.toThrow(
        "Inventory level not found for SKU: SKU-MISSING",
      );
    });
  });
});
