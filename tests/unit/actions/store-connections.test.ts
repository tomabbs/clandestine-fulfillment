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

// HRD-04 dry-run uses these helpers in addition to iterateAllVariants.
const mockGetInventoryLevelsAtLocation =
  vi.fn<(...args: unknown[]) => Promise<Map<string, number | null>>>();
const mockEstimateOrderVolume =
  vi.fn<
    (...args: unknown[]) => Promise<{
      windowDays: number;
      ordersInWindow: number;
      avgDailyOrders: number;
      estimatedDailyWebhooks: number;
      peakHourlyRate: number;
      recommendation: "safe_to_proceed" | "gradual_rollout";
    }>
  >();

vi.mock("@/lib/server/shopify-connection-graphql", () => ({
  iterateAllVariants: (...args: unknown[]) => mockIterateAllVariants(...args),
  getInventoryLevelsAtLocation: (...args: unknown[]) => mockGetInventoryLevelsAtLocation(...args),
  estimateOrderVolume: (...args: unknown[]) => mockEstimateOrderVolume(...args),
  ShopifyScopeError: class ShopifyScopeError extends Error {},
}));

import {
  autoDiscoverShopifySkus,
  createStoreConnection,
  deleteStoreConnection,
  disableStoreConnection,
  getSkuMappings,
  getStoreConnectionOrganizations,
  getStoreConnections,
  reactivateClientStoreConnection,
  runDirectShopifyDryRun,
  updateStoreConnection,
} from "@/actions/store-connections";
// Import after mocks
import { requireAuth, requireStaff } from "@/lib/server/auth-context";

const ADMIN_CONN_ID = "11111111-1111-4111-8111-111111111111";

describe("store-connections server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReset();
    mockServiceFrom.mockReset();
    mockIterateAllVariants.mockReset();
    mockGetInventoryLevelsAtLocation.mockReset();
    mockEstimateOrderVolume.mockReset();
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
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
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

    it("updateStoreConnection throws when staff gate fails", async () => {
      vi.mocked(requireStaff).mockRejectedValueOnce(new Error("Authentication required"));
      await expect(
        updateStoreConnection(ADMIN_CONN_ID, { storeUrl: "https://new.example.com" }),
      ).rejects.toThrow("Authentication required");
    });

    it("disableStoreConnection throws when staff gate fails", async () => {
      vi.mocked(requireStaff).mockRejectedValueOnce(new Error("Staff access required"));
      await expect(disableStoreConnection(ADMIN_CONN_ID)).rejects.toThrow("Staff access required");
    });

    it("getSkuMappings throws when unauthenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(getSkuMappings("conn-1")).rejects.toThrow("Unauthorized");
    });
  });

  // === getStoreConnections ===

  describe("getStoreConnections", () => {
    it("returns connections grouped with org name and mapping count", async () => {
      mockServiceFrom.mockReset();
      // First call: connections query
      const connectionsEq = vi.fn().mockResolvedValue({
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
      });
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            eq: connectionsEq,
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
      expect(connectionsEq).toHaveBeenCalledWith("workspace_id", "ws-1");
    });

    it("ignores client-supplied workspace filters and uses the auth workspace", async () => {
      const statusEq = vi.fn().mockResolvedValue({
        data: [],
        error: null,
      });
      const platformEq = vi.fn().mockReturnValue({
        eq: statusEq,
      });
      const workspaceEq = vi.fn().mockReturnValue({
        eq: platformEq,
      });
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            eq: workspaceEq,
          }),
        }),
      });

      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        }),
      });

      await getStoreConnections({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        platform: "shopify",
        status: "pending",
      });

      expect(workspaceEq).toHaveBeenCalledWith("workspace_id", "ws-1");
      expect(platformEq).toHaveBeenCalledWith("platform", "shopify");
      expect(statusEq).toHaveBeenCalledWith("connection_status", "pending");
    });
  });

  describe("getStoreConnectionOrganizations", () => {
    it("returns organizations for the authenticated workspace", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                { id: "org-1", name: "True Panther" },
                { id: "org-2", name: "Northern Spy Records" },
              ],
              error: null,
            }),
          }),
        }),
      });

      const result = await getStoreConnectionOrganizations();

      expect(result).toEqual([
        { id: "org-1", name: "True Panther" },
        { id: "org-2", name: "Northern Spy Records" },
      ]);
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
      // Phase 3 D1 — disable now does a cutover_state lookup first to
      // reject mid-cutover connections.
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { cutover_state: "legacy", workspace_id: "ws-1" },
              error: null,
            }),
          }),
        }),
      });

      const wsEq = vi.fn().mockResolvedValue({ error: null });
      const mockEq = vi.fn().mockReturnValue({ eq: wsEq });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq });
      mockServiceFrom.mockReturnValueOnce({
        update: mockUpdate,
      });

      const result = await disableStoreConnection(ADMIN_CONN_ID);

      expect(result).toEqual({ success: true });
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          connection_status: "error",
          do_not_fanout: true,
        }),
      );
      expect(mockEq).toHaveBeenCalledWith("id", ADMIN_CONN_ID);
      expect(wsEq).toHaveBeenCalledWith("workspace_id", "ws-1");
    });

    // Phase 3 D1 — defensive guard. The DB CHECK constraint
    // `client_store_connections_cutover_dormancy_check` blocks
    // `(cutover_state IN ('shadow','direct'), do_not_fanout=true)`. We
    // surface a clear, actionable error in the action layer rather than
    // letting the operator hit a generic Postgres constraint violation.
    it.each([
      ["shadow"],
      ["direct"],
    ] as const)("throws when cutover_state=%s without performing the update", async (state) => {
      const mockSelectEq = vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { cutover_state: state, workspace_id: "ws-1" },
          error: null,
        }),
      });
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({ eq: mockSelectEq }),
      });

      await expect(disableStoreConnection(ADMIN_CONN_ID)).rejects.toThrow(
        /Roll back cutover_state to 'legacy'/,
      );
      // Only the lookup .from() call should have happened — no update.
      expect(mockServiceFrom).toHaveBeenCalledTimes(1);
    });

    it("throws Connection not found when the lookup row is missing", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } }),
          }),
        }),
      });
      await expect(disableStoreConnection(ADMIN_CONN_ID)).rejects.toThrow("Connection not found");
    });

    it("throws when connection is outside the staff workspace", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { cutover_state: "legacy", workspace_id: "other-ws" },
              error: null,
            }),
          }),
        }),
      });
      await expect(disableStoreConnection(ADMIN_CONN_ID)).rejects.toThrow(/Forbidden/);
      expect(mockServiceFrom).toHaveBeenCalledTimes(1);
    });
  });

  // === updateStoreConnection ===

  describe("updateStoreConnection", () => {
    it("updates when workspace matches", async () => {
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
      const wsEq = vi.fn().mockResolvedValue({ error: null });
      const idEq = vi.fn().mockReturnValue({ eq: wsEq });
      const mockUpdate = vi.fn().mockReturnValue({ eq: idEq });
      mockServiceFrom.mockReturnValueOnce({ update: mockUpdate });

      await updateStoreConnection(ADMIN_CONN_ID, {
        storeUrl: "https://new.example.com",
        webhookUrl: null,
        webhookSecret: "sec",
      });

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          store_url: "https://new.example.com",
          webhook_url: null,
          webhook_secret: "sec",
        }),
      );
      expect(idEq).toHaveBeenCalledWith("id", ADMIN_CONN_ID);
      expect(wsEq).toHaveBeenCalledWith("workspace_id", "ws-1");
    });

    it("throws when workspace mismatches", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { workspace_id: "other" },
              error: null,
            }),
          }),
        }),
      });
      await expect(
        updateStoreConnection(ADMIN_CONN_ID, { storeUrl: "https://new.example.com" }),
      ).rejects.toThrow(/Forbidden/);
      expect(mockServiceFrom).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid connection id", async () => {
      await expect(
        updateStoreConnection("not-a-uuid", { storeUrl: "https://x.example.com" }),
      ).rejects.toThrow();
    });
  });

  // === deleteStoreConnection ===

  describe("deleteStoreConnection", () => {
    it("deletes scoped row and writes channel_sync_log", async () => {
      const mockInsert = vi.fn().mockResolvedValue({ error: null });
      mockServiceFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  workspace_id: "ws-1",
                  cutover_state: "legacy",
                  platform: "woocommerce",
                  store_url: "https://site.example.com",
                },
                error: null,
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: ADMIN_CONN_ID },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({ insert: mockInsert });

      const result = await deleteStoreConnection(ADMIN_CONN_ID);
      expect(result).toEqual({ success: true });
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          sync_type: "connection_deleted",
          channel: "multi-store",
          status: "completed",
        }),
      );
    });

    it("throws when cutover_state blocks delete", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                workspace_id: "ws-1",
                cutover_state: "shadow",
                platform: "shopify",
                store_url: "https://a.myshopify.com",
              },
              error: null,
            }),
          }),
        }),
      });
      await expect(deleteStoreConnection(ADMIN_CONN_ID)).rejects.toThrow(/Roll back cutover_state/);
      expect(mockServiceFrom).toHaveBeenCalledTimes(1);
    });
  });

  // === reactivateClientStoreConnection (Phase 0.8) ===

  describe("reactivateClientStoreConnection", () => {
    const validId = "11111111-1111-4111-8111-111111111111";

    it("flips do_not_fanout=false, status=active, clears errors, writes audit log", async () => {
      // Connection lookup — Phase 3 D1 SELECT now includes cutover_state.
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                workspace_id: "ws-1",
                platform: "shopify",
                store_url: "https://shop.example.com",
                cutover_state: "legacy",
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

    // Phase 3 D1 — defensive guard. The DB CHECK constraint enforces the
    // enum, but a row landed by a hand-fired SQL or a future migration that
    // misses a callsite must still be rejected here so it surfaces with a
    // clear message instead of being silently re-activated.
    it("throws when the row's cutover_state is unrecognized (defensive)", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                workspace_id: "ws-1",
                platform: "shopify",
                store_url: "https://shop.example.com",
                cutover_state: "rolling_back",
              },
              error: null,
            }),
          }),
        }),
      });

      await expect(reactivateClientStoreConnection({ connectionId: validId })).rejects.toThrow(
        /invalid cutover_state='rolling_back'/,
      );
      // Guard short-circuits before update / audit log.
      expect(mockServiceFrom).toHaveBeenCalledTimes(1);
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

  // === HRD-04 + HRD-18 — runDirectShopifyDryRun ===

  describe("runDirectShopifyDryRun", () => {
    const validId = "3790114f-f1ba-43fa-b5fa-269e513c2a37";

    beforeEach(() => {
      // vi.clearAllMocks() in the outer beforeEach only clears CALL history; queued
      // mockResolvedValueOnce values persist across tests. Reset implementations so
      // unconsumed `Once` values from earlier tests don't leak.
      mockEstimateOrderVolume.mockReset();
      mockGetInventoryLevelsAtLocation.mockReset();
      mockIterateAllVariants.mockReset();
    });

    /** Yields a single page of Shopify variants then stops. */
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

    /** Set up the typical happy-path mockServiceFrom chain. */
    function setupConnectionAndMappings(opts: {
      conn: {
        id: string;
        workspace_id: string;
        store_url: string;
        platform: string;
        api_key: string | null;
        default_location_id: string | null;
      } | null;
      warehouseSkus?: Array<{ id: string; sku: string }>;
      mappings?: Array<{ remote_sku: string; remote_inventory_item_id: string | null }>;
      localLevels?: Array<{ sku: string; available: number }>;
    }) {
      mockServiceFrom.mockImplementation((table: string) => {
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
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  not: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({ data: opts.mappings ?? [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_inventory_levels") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: opts.localLevels ?? [], error: null }),
            }),
          };
        }
        return { select: vi.fn() };
      });
    }

    it("rejects non-staff callers", async () => {
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
      await expect(runDirectShopifyDryRun({ connectionId: validId })).rejects.toThrow("Forbidden");
    });

    it("rejects malformed connection ids before touching the database", async () => {
      await expect(runDirectShopifyDryRun({ connectionId: "not-a-uuid" })).rejects.toThrow();
      expect(mockServiceFrom).not.toHaveBeenCalled();
    });

    it("throws when connection is missing", async () => {
      setupConnectionAndMappings({ conn: null });
      await expect(runDirectShopifyDryRun({ connectionId: validId })).rejects.toThrow(
        "Connection not found",
      );
    });

    it("throws when connection is not Shopify", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.example.com",
          platform: "woocommerce",
          api_key: "wc_key",
          default_location_id: "loc-1",
        },
      });
      await expect(runDirectShopifyDryRun({ connectionId: validId })).rejects.toThrow(
        "only applies to Shopify",
      );
    });

    it("throws when connection has no api_key", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: null,
          default_location_id: "loc-1",
        },
      });
      await expect(runDirectShopifyDryRun({ connectionId: validId })).rejects.toThrow(
        "OAuth install",
      );
    });

    it("throws when connection has no default_location_id (Step 3 incomplete)", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
          default_location_id: null,
        },
      });
      await expect(runDirectShopifyDryRun({ connectionId: validId })).rejects.toThrow(
        /default_location_id|Step 3/,
      );
    });

    it("returns ok=true when membership clean and quantities match", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
          default_location_id: "gid://shopify/Location/1",
        },
        warehouseSkus: [
          { id: "var-1", sku: "LP-001" },
          { id: "var-2", sku: "LP-002" },
        ],
        mappings: [
          { remote_sku: "LP-001", remote_inventory_item_id: "gid://shopify/InventoryItem/111" },
          { remote_sku: "LP-002", remote_inventory_item_id: "gid://shopify/InventoryItem/222" },
        ],
        localLevels: [
          { sku: "LP-001", available: 5 },
          { sku: "LP-002", available: 10 },
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
      mockGetInventoryLevelsAtLocation.mockResolvedValueOnce(
        new Map([
          ["gid://shopify/InventoryItem/111", 5],
          ["gid://shopify/InventoryItem/222", 10],
        ]),
      );
      mockEstimateOrderVolume.mockResolvedValueOnce({
        windowDays: 30,
        ordersInWindow: 60,
        avgDailyOrders: 2,
        estimatedDailyWebhooks: 4,
        peakHourlyRate: 0.5,
        recommendation: "safe_to_proceed",
      });

      const r = await runDirectShopifyDryRun({ connectionId: validId });

      expect(r.verdict.ok).toBe(true);
      expect(r.verdict.fatalReasons).toEqual([]);
      expect(r.membership.matchedSkus).toBe(2);
      expect(r.membership.shopifyOnlySkus).toEqual([]);
      expect(r.membership.warehouseOnlySkus).toEqual([]);
      expect(r.drift.matched).toBe(2);
      expect(r.drift.drifted).toBe(0);
      expect(r.bandwidthEstimate?.recommendation).toBe("safe_to_proceed");
      expect(r.defaultLocationId).toBe("gid://shopify/Location/1");
    });

    it("flags duplicate Shopify SKUs and shopify-only SKUs as fatal", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
          default_location_id: "gid://shopify/Location/1",
        },
        warehouseSkus: [{ id: "var-1", sku: "DUP-001" }],
        mappings: [],
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
          {
            productId: "gid://shopify/Product/3",
            variantId: "gid://shopify/ProductVariant/33",
            sku: "ORPHAN-001",
            inventoryItemId: "gid://shopify/InventoryItem/333",
          },
        ]),
      );
      mockEstimateOrderVolume.mockResolvedValueOnce({
        windowDays: 30,
        ordersInWindow: 0,
        avgDailyOrders: 0,
        estimatedDailyWebhooks: 0,
        peakHourlyRate: 0,
        recommendation: "safe_to_proceed",
      });

      const r = await runDirectShopifyDryRun({
        connectionId: validId,
        skipBandwidthEstimate: true,
      });

      expect(r.verdict.ok).toBe(false);
      expect(r.verdict.fatalReasons.some((s) => s.startsWith("duplicate_shopify_skus"))).toBe(true);
      expect(r.verdict.fatalReasons.some((s) => s.startsWith("shopify_only_skus"))).toBe(true);
      expect(r.membership.duplicateShopifySkus).toHaveLength(1);
      expect(r.membership.duplicateShopifySkus[0].sku).toBe("DUP-001");
      expect(r.membership.shopifyOnlySkus).toEqual(["ORPHAN-001"]);
      // No drift sample → empty-sample warning, but no drift fatals.
      expect(r.drift.sampled).toBe(0);
      expect(r.verdict.warnings.some((s) => s.startsWith("drift_sample_empty"))).toBe(true);
    });

    it("flags drift_above_threshold when >2% of sample drifts (SC-1 ceiling)", async () => {
      // Build 3 mappings, force 1 to drift → 33% drift > 2%.
      const mappings = [
        { remote_sku: "A-1", remote_inventory_item_id: "gid://shopify/InventoryItem/1" },
        { remote_sku: "A-2", remote_inventory_item_id: "gid://shopify/InventoryItem/2" },
        { remote_sku: "A-3", remote_inventory_item_id: "gid://shopify/InventoryItem/3" },
      ];
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
          default_location_id: "gid://shopify/Location/1",
        },
        warehouseSkus: [
          { id: "var-1", sku: "A-1" },
          { id: "var-2", sku: "A-2" },
          { id: "var-3", sku: "A-3" },
        ],
        mappings,
        localLevels: [
          { sku: "A-1", available: 5 },
          { sku: "A-2", available: 5 },
          { sku: "A-3", available: 5 },
        ],
      });
      mockIterateAllVariants.mockReturnValueOnce(
        singlePage([
          {
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/11",
            sku: "A-1",
            inventoryItemId: "gid://shopify/InventoryItem/1",
          },
          {
            productId: "gid://shopify/Product/2",
            variantId: "gid://shopify/ProductVariant/22",
            sku: "A-2",
            inventoryItemId: "gid://shopify/InventoryItem/2",
          },
          {
            productId: "gid://shopify/Product/3",
            variantId: "gid://shopify/ProductVariant/33",
            sku: "A-3",
            inventoryItemId: "gid://shopify/InventoryItem/3",
          },
        ]),
      );
      // Remote: A-1 matches (5), A-2 drifts (3 vs local 5), A-3 missing.
      mockGetInventoryLevelsAtLocation.mockResolvedValueOnce(
        new Map([
          ["gid://shopify/InventoryItem/1", 5],
          ["gid://shopify/InventoryItem/2", 3],
          // A-3 deliberately absent → remote_node_missing
        ]),
      );

      const r = await runDirectShopifyDryRun({
        connectionId: validId,
        skipBandwidthEstimate: true,
      });

      expect(r.drift.sampled).toBe(3);
      expect(r.drift.matched).toBe(1);
      expect(r.drift.drifted).toBe(2);
      expect(r.verdict.ok).toBe(false);
      expect(r.verdict.fatalReasons.some((s) => s.startsWith("drift_above_threshold"))).toBe(true);
      // Sorted by |diff| desc: A-3 (diff=5, missing) tied with A-2 (diff=2)
      expect(r.drift.rows[0].sku).toBe("A-3");
      expect(r.drift.rows[0].reason).toBe("remote_node_missing");
    });

    it("classifies remote_not_stocked_at_location when Shopify returns null inventoryLevel (HRD-26 path)", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
          default_location_id: "gid://shopify/Location/1",
        },
        warehouseSkus: [{ id: "var-1", sku: "LP-001" }],
        mappings: [
          { remote_sku: "LP-001", remote_inventory_item_id: "gid://shopify/InventoryItem/111" },
        ],
        localLevels: [{ sku: "LP-001", available: 7 }],
      });
      mockIterateAllVariants.mockReturnValueOnce(
        singlePage([
          {
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/11",
            sku: "LP-001",
            inventoryItemId: "gid://shopify/InventoryItem/111",
          },
        ]),
      );
      // Returned but null = item exists in Shopify but not stocked at this location
      mockGetInventoryLevelsAtLocation.mockResolvedValueOnce(
        new Map([["gid://shopify/InventoryItem/111", null]]),
      );

      const r = await runDirectShopifyDryRun({
        connectionId: validId,
        skipBandwidthEstimate: true,
      });

      expect(r.drift.rows).toHaveLength(1);
      expect(r.drift.rows[0].reason).toBe("remote_not_stocked_at_location");
      expect(r.drift.rows[0].remoteAvailable).toBeNull();
    });

    it("recommends gradual_rollout when bandwidth estimate exceeds 1000 webhooks/day", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
          default_location_id: "gid://shopify/Location/1",
        },
        warehouseSkus: [],
        mappings: [],
      });
      mockIterateAllVariants.mockReturnValueOnce(singlePage([]));
      mockEstimateOrderVolume.mockResolvedValueOnce({
        windowDays: 30,
        ordersInWindow: 30000,
        avgDailyOrders: 1000,
        estimatedDailyWebhooks: 2000,
        peakHourlyRate: 250,
        recommendation: "gradual_rollout",
      });

      const r = await runDirectShopifyDryRun({ connectionId: validId });

      expect(r.bandwidthEstimate?.recommendation).toBe("gradual_rollout");
      expect(r.verdict.warnings.some((s) => s.startsWith("bandwidth_high"))).toBe(true);
    });

    it("does not fail dry-run when ordersCount throws (bandwidth estimate is fail-soft)", async () => {
      setupConnectionAndMappings({
        conn: {
          id: validId,
          workspace_id: "ws-1",
          store_url: "https://shop.myshopify.com",
          platform: "shopify",
          api_key: "shpat_xyz",
          default_location_id: "gid://shopify/Location/1",
        },
        warehouseSkus: [],
        mappings: [],
      });
      mockIterateAllVariants.mockReturnValueOnce(singlePage([]));
      mockEstimateOrderVolume.mockRejectedValueOnce(new Error("ordersCount unavailable"));

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const r = await runDirectShopifyDryRun({ connectionId: validId });
      expect(r.bandwidthEstimate).toBeNull();
      // Empty sample warning still present; no fatal.
      expect(r.verdict.fatalReasons).toEqual([]);
      consoleSpy.mockRestore();
    });
  });
});
