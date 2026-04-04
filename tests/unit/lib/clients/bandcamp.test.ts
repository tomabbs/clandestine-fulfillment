import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockSupabaseFrom = vi.fn();
const mockServiceClient = {
  from: mockSupabaseFrom,
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => mockServiceClient,
}));

vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    BANDCAMP_CLIENT_ID: "test-client-id",
    BANDCAMP_CLIENT_SECRET: "test-client-secret",
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocks
import {
  assembleBandcampTitle,
  matchSkuToVariants,
  refreshBandcampToken,
} from "@/lib/clients/bandcamp";

describe("bandcamp client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("refreshBandcampToken", () => {
    it("exchanges refresh token and stores new tokens", async () => {
      // Mock reading credentials
      mockSupabaseFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                refresh_token: "old-refresh-token",
                workspace_id: "ws-1",
              },
              error: null,
            }),
          }),
        }),
      });

      // Mock token exchange response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      });

      // Mock storing new tokens
      mockSupabaseFrom.mockReturnValueOnce({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      });

      const result = await refreshBandcampToken("ws-1");

      expect(result).toBe("new-access-token");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://bandcamp.com/oauth_token",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("throws and creates review item on HTTP failure", async () => {
      // Mock reading credentials
      mockSupabaseFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { refresh_token: "bad-token", workspace_id: "ws-1" },
              error: null,
            }),
          }),
        }),
      });

      // Mock failed response
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "invalid_grant",
      });

      // Mock review queue upsert
      mockSupabaseFrom.mockReturnValueOnce({
        upsert: vi.fn().mockResolvedValue({ error: null }),
      });

      await expect(refreshBandcampToken("ws-1")).rejects.toThrow(
        "Bandcamp token refresh failed: 401",
      );
    });

    it("throws when no credentials found", async () => {
      mockSupabaseFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { message: "not found" },
            }),
          }),
        }),
      });

      await expect(refreshBandcampToken("ws-1")).rejects.toThrow("No Bandcamp credentials found");
    });
  });

  describe("assembleBandcampTitle", () => {
    it("builds title with artist and item", () => {
      expect(assembleBandcampTitle("Artist", "Album", "LP")).toBe("Artist - LP");
    });

    it("keeps artist even when album matches item", () => {
      expect(assembleBandcampTitle("Artist", "Same Title", "Same Title")).toBe(
        "Artist - Same Title",
      );
    });

    it("keeps artist when album is null", () => {
      expect(assembleBandcampTitle("Artist", null, "CD")).toBe("Artist - CD");
    });

    it("uses item alone when artist matches item", () => {
      expect(assembleBandcampTitle("Tape", undefined, "Tape")).toBe("Tape");
    });

    it("uses item alone when artist is empty", () => {
      expect(assembleBandcampTitle("", null, "Some Item")).toBe("Some Item");
    });
  });

  describe("matchSkuToVariants", () => {
    const variants = [
      { id: "v1", sku: "ABC-001" },
      { id: "v2", sku: "ABC-002" },
      { id: "v3", sku: "XYZ-001" },
    ];

    it("matches merch items by SKU", () => {
      const merchItems = [
        { package_id: 1, title: "Item 1", sku: "ABC-001" },
        { package_id: 2, title: "Item 2", sku: "ABC-002" },
      ] as Parameters<typeof matchSkuToVariants>[0];

      const result = matchSkuToVariants(merchItems, variants);

      expect(result.matched).toHaveLength(2);
      expect(result.matched[0].variantId).toBe("v1");
      expect(result.matched[1].variantId).toBe("v2");
      expect(result.unmatched).toHaveLength(0);
    });

    it("separates unmatched items", () => {
      const merchItems = [
        { package_id: 1, title: "Known", sku: "ABC-001" },
        { package_id: 2, title: "Unknown", sku: "NOPE-999" },
      ] as Parameters<typeof matchSkuToVariants>[0];

      const result = matchSkuToVariants(merchItems, variants);

      expect(result.matched).toHaveLength(1);
      expect(result.unmatched).toHaveLength(1);
      expect(result.unmatched[0].title).toBe("Unknown");
    });

    it("puts items without SKU into unmatched for auto-generation", () => {
      const merchItems = [
        { package_id: 1, title: "No SKU", sku: null },
        { package_id: 2, title: "Also no SKU" },
      ] as Parameters<typeof matchSkuToVariants>[0];

      const result = matchSkuToVariants(merchItems, variants);

      expect(result.matched).toHaveLength(0);
      expect(result.unmatched).toHaveLength(2);
    });
  });
});
