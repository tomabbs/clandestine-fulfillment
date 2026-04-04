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

vi.mock("@/lib/server/auth-context", () => ({
  requireClient: vi
    .fn()
    .mockResolvedValue({ userId: "user-1", orgId: "org-1", workspaceId: "ws-1" }),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => mockServerClient,
  createServiceRoleClient: () => mockServiceClient,
}));

// Mock Shopify client — Rule #1: ensure productSet is NEVER called
const mockProductUpdate = vi.fn();
const mockProductVariantsBulkUpdate = vi.fn();
const mockProductSet = vi.fn();

vi.mock("@/lib/clients/shopify", () => ({
  productUpdate: (...args: unknown[]) => mockProductUpdate(...args),
  productVariantsBulkUpdate: (...args: unknown[]) => mockProductVariantsBulkUpdate(...args),
  // productSet should never be imported for edits
  productSet: (...args: unknown[]) => mockProductSet(...args),
}));

// Import after mocks
import {
  getClientReleases,
  getProductDetail,
  getProducts,
  updateProduct,
  updateVariants,
} from "@/actions/catalog";

describe("catalog server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockServiceFrom.mockReset();
  });

  // === Auth tests ===

  describe("authentication", () => {
    it("getProducts returns empty result when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(getProducts({ page: 1, pageSize: 25 })).resolves.toEqual({
        products: [],
        total: 0,
        page: 1,
        pageSize: 25,
      });
    });

    it("getProductDetail throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(getProductDetail("prod-1")).rejects.toThrow("Unauthorized");
    });

    it("updateProduct throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(updateProduct("prod-1", { title: "New" })).rejects.toThrow("Unauthorized");
    });

    it("updateVariants throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(
        updateVariants("prod-1", [{ id: "v-1", shopifyVariantId: "gid://1" }]),
      ).rejects.toThrow("Unauthorized");
    });

    it("getClientReleases returns empty release groups when user is not authenticated", async () => {
      const { requireClient } = await import("@/lib/server/auth-context");
      vi.mocked(requireClient).mockRejectedValueOnce(new Error("Authentication required"));
      await expect(getClientReleases()).resolves.toEqual({
        preorders: [],
        newReleases: [],
        catalog: [],
        total: 0,
      });
    });
  });

  // === Product filtering ===

  describe("getProducts", () => {
    it("applies status filter", async () => {
      const selectMock = vi.fn();
      const eqMock = vi.fn();
      const orderMock = vi.fn();
      const rangeMock = vi.fn();

      mockServiceFrom.mockReturnValueOnce({
        select: selectMock.mockReturnValue({
          order: orderMock.mockReturnValue({
            range: rangeMock.mockReturnValue({
              eq: eqMock.mockResolvedValue({
                data: [],
                error: null,
                count: 0,
              }),
            }),
          }),
        }),
      });

      await getProducts({ page: 1, pageSize: 25, status: "active" });

      expect(mockServiceFrom).toHaveBeenCalledWith("warehouse_products");
      expect(eqMock).toHaveBeenCalledWith("status", "active");
    });

    it("validates page size is one of 25, 50, 100", async () => {
      await expect(getProducts({ page: 1, pageSize: 30 as never })).rejects.toThrow();
    });
  });

  // === Rule #1: productSet NEVER used for edits ===

  describe("updateProduct (Rule #1: uses productUpdate, NOT productSet)", () => {
    it("calls shopify productUpdate when product has shopify_product_id", async () => {
      // Mock product fetch
      mockServiceFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  shopify_product_id: "gid://shopify/Product/123",
                  title: "Old Title",
                  product_type: "LP",
                  tags: ["vinyl"],
                },
                error: null,
              }),
            }),
          }),
        })
        // Mock DB update
        .mockReturnValueOnce({
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        });

      mockProductUpdate.mockResolvedValue({
        id: "gid://shopify/Product/123",
        title: "New Title",
      });

      await updateProduct("prod-1", { title: "New Title" });

      // productUpdate MUST be called
      expect(mockProductUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "gid://shopify/Product/123",
          title: "New Title",
        }),
      );

      // productSet must NEVER be called
      expect(mockProductSet).not.toHaveBeenCalled();
    });

    it("skips Shopify call when product has no shopify_product_id", async () => {
      mockServiceFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  shopify_product_id: null,
                  title: "Local Only",
                  product_type: null,
                  tags: [],
                },
                error: null,
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        });

      await updateProduct("prod-1", { title: "Updated" });

      expect(mockProductUpdate).not.toHaveBeenCalled();
      expect(mockProductSet).not.toHaveBeenCalled();
    });
  });

  describe("updateVariants (Rule #1: uses productVariantsBulkUpdate, NOT productSet)", () => {
    it("calls shopify productVariantsBulkUpdate, never productSet", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { shopify_product_id: "gid://shopify/Product/123" },
              error: null,
            }),
          }),
        }),
      });

      // Mock the per-variant DB update (use mockImplementation that handles multiple calls)
      mockServiceFrom.mockImplementation(() => ({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }));

      mockProductVariantsBulkUpdate.mockResolvedValue([
        { id: "gid://shopify/ProductVariant/456", price: "29.99" },
      ]);

      await updateVariants("prod-1", [
        {
          id: "v-1",
          shopifyVariantId: "gid://shopify/ProductVariant/456",
          price: "29.99",
        },
      ]);

      // productVariantsBulkUpdate MUST be called
      expect(mockProductVariantsBulkUpdate).toHaveBeenCalledWith(
        "gid://shopify/Product/123",
        expect.arrayContaining([
          expect.objectContaining({
            id: "gid://shopify/ProductVariant/456",
            price: "29.99",
          }),
        ]),
      );

      // productSet must NEVER be called
      expect(mockProductSet).not.toHaveBeenCalled();
    });
  });

  // === Validation ===

  describe("input validation", () => {
    it("getProductDetail rejects empty productId", async () => {
      await expect(getProductDetail("")).rejects.toThrow("Product ID is required");
    });

    it("updateProduct validates input with Zod", async () => {
      // Empty title should fail Zod min(1)
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { shopify_product_id: null, title: "T", product_type: null, tags: [] },
              error: null,
            }),
          }),
        }),
      });

      await expect(updateProduct("prod-1", { title: "" })).rejects.toThrow();
    });
  });

  // === Client releases ===

  describe("getClientReleases", () => {
    it("fetches pre-orders and new releases using service role client", async () => {
      const preorderData = [
        {
          id: "v-1",
          sku: "PRE-001",
          title: "Pre-Order LP",
          street_date: "2026-04-01",
          is_preorder: true,
          warehouse_products: {
            id: "p-1",
            title: "Album",
            status: "active",
            org_id: "org-1",
            warehouse_product_images: [],
          },
          warehouse_inventory_levels: [{ available: 0, committed: 50, incoming: 200 }],
        },
      ];

      // Use a Proxy-based chainable mock for all three service queries
      const handler: ProxyHandler<Record<string, unknown>> = {
        get(target, prop) {
          if (prop === "then") {
            const callIdx = (target._callIdx as number) ?? 0;
            const results = [
              { data: preorderData, error: null },
              { data: [], error: null },
              { data: [], error: null, count: 0 },
            ];
            return (resolve: (v: unknown) => void) => resolve(results[callIdx]);
          }
          return (..._args: unknown[]) => new Proxy({ ...target }, handler);
        },
      };

      let callCount = 0;
      mockServiceFrom.mockImplementation(() => {
        const idx = callCount++;
        return new Proxy({ _callIdx: idx }, handler);
      });

      const result = await getClientReleases();

      expect(result.preorders).toHaveLength(1);
      expect(result.preorders[0].sku).toBe("PRE-001");
      expect(result.newReleases).toHaveLength(0);
    });
  });
});
