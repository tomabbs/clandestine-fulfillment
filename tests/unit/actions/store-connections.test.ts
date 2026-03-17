import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();

const mockServerClient = {
  auth: { getUser: mockGetUser },
  from: vi.fn(),
};

const mockServiceFrom = vi.fn();
const mockServiceClient = {
  from: mockServiceFrom,
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => mockServerClient,
  createServiceRoleClient: () => mockServiceClient,
}));

// Import after mocks
import {
  createStoreConnection,
  disableStoreConnection,
  getSkuMappings,
  getStoreConnections,
  updateStoreConnection,
} from "@/actions/store-connections";

describe("store-connections server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  // === Auth tests ===

  describe("authentication", () => {
    it("getStoreConnections throws when unauthenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(getStoreConnections()).rejects.toThrow("Unauthorized");
    });

    it("createStoreConnection throws when unauthenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(
        createStoreConnection({
          orgId: "org-1",
          platform: "shopify",
          storeUrl: "https://shop.example.com",
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("updateStoreConnection throws when unauthenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(
        updateStoreConnection("conn-1", { storeUrl: "https://new.example.com" }),
      ).rejects.toThrow("Unauthorized");
    });

    it("disableStoreConnection throws when unauthenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(disableStoreConnection("conn-1")).rejects.toThrow("Unauthorized");
    });

    it("getSkuMappings throws when unauthenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(getSkuMappings("conn-1")).rejects.toThrow("Unauthorized");
    });
  });

  // === getStoreConnections ===

  describe("getStoreConnections", () => {
    it("returns connections grouped with org name and mapping count", async () => {
      // Main connections query
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            eq: undefined,
          }),
        }),
      });

      // Simplify: mock the full chain
      const mockQuery = {
        select: vi.fn(),
      };
      mockQuery.select.mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            {
              id: "conn-1",
              org_id: "org-1",
              platform: "shopify",
              store_url: "https://shop.example.com",
              connection_status: "active",
              organizations: { name: "Test Label" },
            },
          ],
          error: null,
        }),
      });

      mockServiceFrom.mockReset();
      // First call: connections query
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({
            data: [
              {
                id: "conn-1",
                org_id: "org-1",
                platform: "shopify",
                store_url: "https://shop.example.com",
                connection_status: "active",
                organizations: { name: "Test Label" },
              },
            ],
            error: null,
          }),
        }),
      });

      // Second call: mapping counts
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ connection_id: "conn-1" }, { connection_id: "conn-1" }],
              error: null,
            }),
          }),
        }),
      });

      const result = await getStoreConnections();
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].org_name).toBe("Test Label");
      expect(result.connections[0].sku_mapping_count).toBe(2);
    });
  });

  // === createStoreConnection ===

  describe("createStoreConnection", () => {
    it("creates a pending connection with do_not_fanout=true", async () => {
      // Org lookup
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { workspace_id: "ws-1" },
              error: null,
            }),
          }),
        }),
      });

      // Insert
      const mockSingle = vi.fn().mockResolvedValue({
        data: {
          id: "new-conn",
          workspace_id: "ws-1",
          org_id: "org-1",
          platform: "squarespace",
          store_url: "https://store.squarespace.com",
          connection_status: "pending",
          do_not_fanout: true,
        },
        error: null,
      });

      mockServiceFrom.mockReturnValueOnce({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: mockSingle,
          }),
        }),
      });

      const result = await createStoreConnection({
        orgId: "org-1",
        platform: "squarespace",
        storeUrl: "https://store.squarespace.com",
      });

      expect(result.connection_status).toBe("pending");
      expect(result.do_not_fanout).toBe(true);
    });

    it("throws when org not found", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } }),
          }),
        }),
      });

      await expect(
        createStoreConnection({
          orgId: "bad-org",
          platform: "shopify",
          storeUrl: "https://shop.example.com",
        }),
      ).rejects.toThrow("Organization not found");
    });

    it("validates store URL format", async () => {
      await expect(
        createStoreConnection({
          orgId: "org-1",
          platform: "shopify",
          storeUrl: "not-a-url",
        }),
      ).rejects.toThrow();
    });
  });

  // === disableStoreConnection ===

  describe("disableStoreConnection", () => {
    it("sets connection_status to error and do_not_fanout to true", async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq });

      mockServiceFrom.mockReturnValueOnce({
        update: mockUpdate,
      });

      const result = await disableStoreConnection("conn-1");

      expect(result).toEqual({ success: true });
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          connection_status: "error",
          do_not_fanout: true,
        }),
      );
    });
  });

  // === getSkuMappings ===

  describe("getSkuMappings", () => {
    it("returns mappings with variant SKU enrichment", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "map-1",
                  connection_id: "conn-1",
                  variant_id: "var-1",
                  remote_sku: "REMOTE-001",
                  last_pushed_quantity: 10,
                  last_pushed_at: "2026-01-01T00:00:00Z",
                  is_active: true,
                  warehouse_product_variants: { sku: "LP-001", title: "Test LP" },
                },
              ],
              error: null,
            }),
          }),
        }),
      });

      const result = await getSkuMappings("conn-1");

      expect(result).toHaveLength(1);
      expect(result[0].variant_sku).toBe("LP-001");
      expect(result[0].variant_title).toBe("Test LP");
      expect(result[0].last_pushed_quantity).toBe(10);
    });
  });
});
