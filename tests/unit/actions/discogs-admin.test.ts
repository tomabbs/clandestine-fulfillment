import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve()),
}));

const mockServerFrom = vi.fn();
const mockServerClient = { from: mockServerFrom };

const mockServiceFrom = vi.fn();
const mockServiceClient = { from: mockServiceFrom };

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(async () => mockServerClient),
  createServiceRoleClient: vi.fn(() => mockServiceClient),
}));

import {
  confirmMapping,
  getDiscogsCredentials,
  getDiscogsOverview,
  getProductMappings,
  rejectMapping,
  saveDiscogsCredentials,
} from "@/actions/discogs-admin";

describe("discogs-admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getDiscogsOverview", () => {
    it("returns aggregate counts", async () => {
      mockServerFrom.mockImplementation((table: string) => {
        if (table === "discogs_credentials") {
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: "c1", username: "seller", created_at: "2026-01-01T00:00:00Z" },
                error: null,
              }),
            }),
          };
        }
        if (table === "discogs_listings") {
          return {
            select: vi.fn().mockResolvedValue({
              data: [
                { id: "l1", status: "For Sale" },
                { id: "l2", status: "Sold" },
                { id: "l3", status: "For Sale" },
              ],
              error: null,
            }),
          };
        }
        if (table === "mailorder_orders") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  { id: "o1", fulfillment_status: "unfulfilled" },
                  { id: "o2", fulfillment_status: "fulfilled" },
                  { id: "o3", fulfillment_status: "unfulfilled" },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === "discogs_order_messages") {
          return {
            select: vi.fn().mockResolvedValue({ count: 7, data: null, error: null }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      });

      const result = await getDiscogsOverview();

      expect(result).toEqual({
        hasCredentials: true,
        username: "seller",
        activeListings: 2,
        totalOrders: 3,
        unfulfilledOrders: 2,
        totalMessages: 7,
      });
    });
  });

  describe("getDiscogsCredentials", () => {
    it("returns null when no credentials exist", async () => {
      mockServerFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: "PGRST116" } }),
        }),
      });

      const result = await getDiscogsCredentials();

      expect(result.credentials).toBeNull();
    });
  });

  describe("saveDiscogsCredentials", () => {
    it("calls upsert with workspace_id conflict", async () => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      mockServiceFrom.mockImplementation((table: string) => {
        if (table === "workspaces") {
          return {
            select: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: "ws-1" }, error: null }),
              }),
            }),
          };
        }
        if (table === "discogs_credentials") {
          return { upsert };
        }
        throw new Error(`unexpected table: ${table}`);
      });

      await saveDiscogsCredentials({ accessToken: "tok", username: "u1" });

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: "ws-1",
          username: "u1",
          access_token: "tok",
        }),
        { onConflict: "workspace_id" },
      );
    });
  });

  describe("getProductMappings", () => {
    it("returns filtered mappings array", async () => {
      const mappings = [{ id: "m1", is_active: false }];
      const mockEq = vi.fn().mockResolvedValue({ data: mappings, error: null });
      const chain = {
        select: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        eq: mockEq,
      };
      chain.select.mockReturnValue(chain);
      chain.order.mockReturnValue(chain);
      chain.limit.mockReturnValue(chain);

      mockServerFrom.mockReturnValue(chain);

      const result = await getProductMappings({ status: "pending" });

      expect(mockEq).toHaveBeenCalledWith("is_active", false);
      expect(result.mappings).toEqual(mappings);
    });
  });

  describe("confirmMapping", () => {
    it("calls update with is_active: true", async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const update = vi.fn().mockReturnValue({ eq: mockEq });
      mockServiceFrom.mockReturnValue({ update });

      await confirmMapping("map-1");

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: true, updated_at: expect.any(String) }),
      );
      expect(mockEq).toHaveBeenCalledWith("id", "map-1");
    });
  });

  describe("rejectMapping", () => {
    it("calls delete", async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const del = vi.fn().mockReturnValue({ eq: mockEq });
      mockServiceFrom.mockReturnValue({ delete: del });

      await rejectMapping("map-2");

      expect(del).toHaveBeenCalled();
      expect(mockEq).toHaveBeenCalledWith("id", "map-2");
    });
  });
});
