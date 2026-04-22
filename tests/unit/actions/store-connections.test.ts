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

// HRD-35 step 6 — autoDiscoverShopifySkus walks Shopify variants via this
// generator. We provide a mockable async generator per-test.
const mockIterateAllVariants =
  vi.fn<
    (...args: unknown[]) => AsyncGenerator<
      Array<{
        productId: string;
        productTitle: string;
        productStatus: string;
        variantId: string;
        sku: string | null;
        inventoryItemId: string | null;
        inventoryTracked: boolean | null;
      }>
    >
  >();

vi.mock("@/lib/server/shopify-connection-graphql", () => ({
  iterateAllVariants: (...args: unknown[]) => mockIterateAllVariants(...args),
  ShopifyScopeError: class ShopifyScopeError extends Error {},
}));

import {
  autoDiscoverShopifySkus,
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

  // === HRD-35 step 6 — autoDiscoverShopifySkus ===

  describe("autoDiscoverShopifySkus", () => {
    /** Helper — yields one page of Shopify variants and stops. */
    function singlePage(
      variants: Array<{
        productId: string;
        variantId: string;
        sku: string | null;
        inventoryItemId: string | null;
      }>,
    ) {
      return (async function* () {
        yield variants.map((v) => ({
          productId: v.productId,
          productTitle: "Test Product",
          productStatus: "ACTIVE",
          variantId: v.variantId,
          sku: v.sku,
          inventoryItemId: v.inventoryItemId,
          inventoryTracked: true,
        }));
      })();
    }

    /** Helper — set up the mockServiceFrom chain for a typical happy-path call. */
    function setupConnectionAndVariants(opts: {
      conn: {
        id: string;
        workspace_id: string;
        store_url: string;
        platform: string;
        api_key: string | null;
      } | null;
      warehouseSkus?: Array<{ id: string; sku: string }>;
      existingMappings?: Array<{ id: string; remote_inventory_item_id: string | null }>;
    }) {
      const calls: string[] = [];

      mockServiceFrom.mockImplementation((table: string) => {
        calls.push(table);
        if (table === "client_store_connections") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: opts.conn, error: null }),
              }),
            }),
          };
        }
        if (table === "warehouse_product_variants") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockResolvedValue({ data: opts.warehouseSkus ?? [], error: null }),
              }),
            }),
          };
        }
        if (table === "client_store_sku_mappings") {
          // Pre-load existing query AND the upsert chain
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockResolvedValue({ data: opts.existingMappings ?? [], error: null }),
              }),
            }),
            upsert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return { select: vi.fn() };
      });

      return calls;
    }

    it("throws when not staff", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        supabase: { from: mockFrom } as never,
        authUserId: "auth-1",
        userRecord: {
          id: "user-1",
          workspace_id: "ws-1",
          org_id: "org-1",
          role: "client",
          email: "client@test.com",
          name: "Client",
        },
        isStaff: false,
      });
      await expect(
        autoDiscoverShopifySkus({ connectionId: "3790114f-f1ba-43fa-b5fa-269e513c2a37" }),
      ).rejects.toThrow("Forbidden");
    });

    it("throws when connection is not Shopify", async () => {
      setupConnectionAndVariants({
        conn: {
          id: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
          workspace_id: "ws-1",
          store_url: "https://shop.example.com",
          platform: "woocommerce",
          api_key: "wc_key",
        },
      });
      await expect(
        autoDiscoverShopifySkus({ connectionId: "3790114f-f1ba-43fa-b5fa-269e513c2a37" }),
      ).rejects.toThrow("only applies to Shopify");
    });

    it("throws when connection has no api_key", async () => {
      setupConnectionAndVariants({
        conn: {
          id: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: null,
        },
      });
      await expect(
        autoDiscoverShopifySkus({ connectionId: "3790114f-f1ba-43fa-b5fa-269e513c2a37" }),
      ).rejects.toThrow("OAuth install");
    });

    it("matches Shopify variants to warehouse SKUs and reports counts", async () => {
      setupConnectionAndVariants({
        conn: {
          id: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
        },
        warehouseSkus: [
          { id: "var-1", sku: "LP-001" },
          { id: "var-2", sku: "LP-002" },
          { id: "var-3", sku: "BANDCAMP-ONLY-001" },
        ],
        existingMappings: [],
      });
      mockIterateAllVariants.mockReturnValueOnce(
        singlePage([
          {
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/11",
            sku: "LP-001",
            inventoryItemId: "gid://shopify/InventoryItem/111",
          },
          {
            productId: "gid://shopify/Product/2",
            variantId: "gid://shopify/ProductVariant/22",
            sku: "LP-002",
            inventoryItemId: "gid://shopify/InventoryItem/222",
          },
          {
            productId: "gid://shopify/Product/3",
            variantId: "gid://shopify/ProductVariant/33",
            sku: "ORPHAN-001",
            inventoryItemId: "gid://shopify/InventoryItem/333",
          },
        ]),
      );

      const r = await autoDiscoverShopifySkus({
        connectionId: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
      });

      expect(r.shopifyVariantsScanned).toBe(3);
      expect(r.shopifyProductsScanned).toBe(3);
      expect(r.warehouseSkusInWorkspace).toBe(3);
      expect(r.matched).toBe(2);
      expect(r.newMappingsCreated).toBe(2);
      expect(r.existingMappingsUpdated).toBe(0);
      expect(r.unmatchedShopifySkus).toEqual(["ORPHAN-001"]);
      expect(r.warehouseSkusNotInShopify).toEqual(["BANDCAMP-ONLY-001"]);
      expect(r.duplicateShopifySkus).toEqual([]);
    });

    it("detects duplicate Shopify SKUs (Rule #8 violation)", async () => {
      setupConnectionAndVariants({
        conn: {
          id: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
        },
        warehouseSkus: [{ id: "var-1", sku: "DUP-001" }],
      });
      mockIterateAllVariants.mockReturnValueOnce(
        singlePage([
          {
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/11",
            sku: "DUP-001",
            inventoryItemId: "gid://shopify/InventoryItem/111",
          },
          {
            productId: "gid://shopify/Product/2",
            variantId: "gid://shopify/ProductVariant/22",
            sku: "DUP-001",
            inventoryItemId: "gid://shopify/InventoryItem/222",
          },
        ]),
      );

      const r = await autoDiscoverShopifySkus({
        connectionId: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
      });

      expect(r.duplicateShopifySkus).toHaveLength(1);
      expect(r.duplicateShopifySkus[0]).toEqual({
        sku: "DUP-001",
        variantIds: ["gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/22"],
      });
    });

    it("counts variants without SKU and without inventoryItem separately", async () => {
      setupConnectionAndVariants({
        conn: {
          id: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
        },
        warehouseSkus: [],
      });
      mockIterateAllVariants.mockReturnValueOnce(
        singlePage([
          {
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/11",
            sku: null,
            inventoryItemId: "gid://shopify/InventoryItem/111",
          },
          {
            productId: "gid://shopify/Product/2",
            variantId: "gid://shopify/ProductVariant/22",
            sku: "HAS-SKU",
            inventoryItemId: null,
          },
        ]),
      );

      const r = await autoDiscoverShopifySkus({
        connectionId: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
      });

      expect(r.shopifyVariantsWithoutSku).toBe(1);
      expect(r.shopifyVariantsWithoutInventoryItem).toBe(1);
      expect(r.matched).toBe(0);
    });

    it("flags new vs updated mappings using existing remote_inventory_item_id set", async () => {
      setupConnectionAndVariants({
        conn: {
          id: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
        },
        warehouseSkus: [
          { id: "var-1", sku: "LP-001" },
          { id: "var-2", sku: "LP-002" },
        ],
        existingMappings: [
          { id: "map-1", remote_inventory_item_id: "gid://shopify/InventoryItem/111" },
        ],
      });
      mockIterateAllVariants.mockReturnValueOnce(
        singlePage([
          {
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/11",
            sku: "LP-001",
            inventoryItemId: "gid://shopify/InventoryItem/111",
          },
          {
            productId: "gid://shopify/Product/2",
            variantId: "gid://shopify/ProductVariant/22",
            sku: "LP-002",
            inventoryItemId: "gid://shopify/InventoryItem/222",
          },
        ]),
      );

      const r = await autoDiscoverShopifySkus({
        connectionId: "3790114f-f1ba-43fa-b5fa-269e513c2a37",
      });

      expect(r.matched).toBe(2);
      expect(r.existingMappingsUpdated).toBe(1);
      expect(r.newMappingsCreated).toBe(1);
    });
  });
});
