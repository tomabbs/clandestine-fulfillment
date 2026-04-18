import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockServiceClient = {
  from: mockServiceFrom,
};

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: vi.fn(() =>
    Promise.resolve({
      supabase: { from: mockFrom },
      authUserId: "auth-1",
      userRecord: {
        id: "user-1",
        workspace_id: "ws-1",
        org_id: null,
        role: "admin",
        email: "admin@test.com",
        name: "Admin",
      },
      isStaff: true,
    }),
  ),
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
  requireClient: vi.fn(() =>
    Promise.resolve({ userId: "user-1", orgId: "org-1", workspaceId: "ws-1" }),
  ),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: vi.fn() }, from: vi.fn() }),
  createServiceRoleClient: () => mockServiceClient,
}));

import {
  createStoreConnection,
  disableStoreConnection,
  getSkuMappings,
  getStoreConnections,
  reactivateClientStoreConnection,
  updateStoreConnection,
} from "@/actions/store-connections";
// Import after mocks
import { requireAuth } from "@/lib/server/auth-context";

describe("store-connections server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({
      supabase: { from: mockFrom } as never,
      authUserId: "auth-1",
      userRecord: {
        id: "user-1",
        workspace_id: "ws-1",
        org_id: null,
        role: "admin",
        email: "admin@test.com",
        name: "Admin",
      },
      isStaff: true,
    });
  });

  // === Auth tests ===

  describe("authentication", () => {
    it("getStoreConnections throws when unauthenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(getStoreConnections()).rejects.toThrow("Unauthorized");
    });

    it("createStoreConnection throws when unauthenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(
        createStoreConnection({
          orgId: "org-1",
          platform: "shopify",
          storeUrl: "https://shop.example.com",
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("updateStoreConnection throws when unauthenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(
        updateStoreConnection("conn-1", { storeUrl: "https://new.example.com" }),
      ).rejects.toThrow("Unauthorized");
    });

    it("disableStoreConnection throws when unauthenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(disableStoreConnection("conn-1")).rejects.toThrow("Unauthorized");
    });

    it("getSkuMappings throws when unauthenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
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

  // === reactivateClientStoreConnection (Phase 0.8) ===

  describe("reactivateClientStoreConnection", () => {
    const validId = "11111111-1111-4111-8111-111111111111";

    it("flips do_not_fanout=false, status=active, clears errors, writes audit log", async () => {
      // Connection lookup
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                workspace_id: "ws-1",
                platform: "shopify",
                store_url: "https://shop.example.com",
              },
              error: null,
            }),
          }),
        }),
      });

      const updateEq = vi.fn().mockResolvedValue({ error: null });
      const updateFn = vi.fn().mockReturnValue({ eq: updateEq });
      mockServiceFrom.mockReturnValueOnce({ update: updateFn });

      const insertFn = vi.fn().mockResolvedValue({ error: null });
      mockServiceFrom.mockReturnValueOnce({ insert: insertFn });

      const result = await reactivateClientStoreConnection({ connectionId: validId });

      expect(result).toEqual({ success: true });
      expect(updateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          do_not_fanout: false,
          connection_status: "active",
          last_error: null,
          last_error_at: null,
        }),
      );
      expect(updateEq).toHaveBeenCalledWith("id", validId);
      expect(insertFn).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "multi-store",
          sync_type: "reactivate",
          metadata: expect.objectContaining({
            connection_id: validId,
            actor_user_id: "user-1",
            action: "reactivate",
          }),
        }),
      );
    });

    it("rejects non-staff callers", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        supabase: { from: mockFrom } as never,
        authUserId: "auth-2",
        userRecord: {
          id: "user-2",
          workspace_id: "ws-1",
          org_id: "org-1",
          role: "client",
          email: "client@test.com",
          name: "Client",
        },
        isStaff: false,
      });

      await expect(reactivateClientStoreConnection({ connectionId: validId })).rejects.toThrow(
        /staff only/i,
      );
    });

    it("rejects malformed connection ids before touching the database", async () => {
      await expect(
        reactivateClientStoreConnection({ connectionId: "not-a-uuid" }),
      ).rejects.toThrow();
      expect(mockServiceFrom).not.toHaveBeenCalled();
    });

    it("throws when connection is missing", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } }),
          }),
        }),
      });

      await expect(reactivateClientStoreConnection({ connectionId: validId })).rejects.toThrow(
        "Connection not found",
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
