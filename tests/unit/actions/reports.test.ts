import { beforeEach, describe, expect, it, vi } from "vitest";

const { WS_ID } = vi.hoisted(() => ({
  WS_ID: "11111111-1111-4111-a111-111111111111",
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    supabase: {},
    authUserId: "auth-user-1",
    userRecord: {
      id: "u1",
      workspace_id: WS_ID,
      org_id: null,
      role: "admin",
      email: "t@t.com",
      name: "T",
    },
    isStaff: true,
  }),
}));

const mockServiceClient = { from: vi.fn() };

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => mockServiceClient,
}));

import { getTopSellers, getTopSellersSummary } from "@/actions/reports";
import { requireAuth } from "@/lib/server/auth-context";

describe("reports server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({
      supabase: {} as never,
      authUserId: "auth-user-1",
      userRecord: {
        id: "u1",
        workspace_id: WS_ID,
        org_id: null,
        role: "admin",
        email: "t@t.com",
        name: "T",
      },
      isStaff: true,
    });
  });

  describe("getTopSellers", () => {
    it("returns ranked sellers with revenue", async () => {
      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "bandcamp_product_mappings") {
          return {
            select: vi.fn().mockReturnValue({
              gt: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      {
                        last_quantity_sold: 100,
                        warehouse_product_variants: {
                          sku: "LP-001",
                          title: "Vinyl",
                          price: 25,
                          warehouse_products: {
                            title: "Test Album",
                            vendor: "Test Label",
                            org_id: "org-1",
                            images: [{ src: "https://img.jpg" }],
                            organizations: { name: "Test Label" },
                          },
                        },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return undefined;
      });

      const result = await getTopSellers();
      expect(result).toHaveLength(1);
      expect(result[0].rank).toBe(1);
      expect(result[0].qtySold).toBe(100);
      expect(result[0].revenue).toBe(2500);
      expect(result[0].sku).toBe("LP-001");
    });

    it("throws when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(getTopSellers()).rejects.toThrow("Unauthorized");
    });
  });

  describe("getTopSellersSummary", () => {
    it("calculates totals", async () => {
      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "bandcamp_product_mappings") {
          return {
            select: vi.fn().mockReturnValue({
              gt: vi.fn().mockResolvedValue({
                data: [
                  { last_quantity_sold: 50, warehouse_product_variants: { price: 20 } },
                  { last_quantity_sold: 30, warehouse_product_variants: { price: 15 } },
                ],
                error: null,
              }),
            }),
          };
        }
        return undefined;
      });

      const result = await getTopSellersSummary();
      expect(result.totalUnitsSold).toBe(80);
      expect(result.totalRevenue).toBe(1450); // 50*20 + 30*15
      expect(result.productsWithSales).toBe(2);
    });
  });
});
