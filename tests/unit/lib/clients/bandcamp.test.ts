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
  getShippingOriginDetails,
  matchSkuToVariants,
  normalizeFormat,
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

  describe("normalizeFormat", () => {
    it("normalizes vinyl variants to LP", () => {
      expect(normalizeFormat("Vinyl LP")).toBe("LP");
      expect(normalizeFormat('12" Vinyl')).toBe("LP");
      expect(normalizeFormat("2 x Vinyl LP")).toBe("LP");
      expect(normalizeFormat("150gm Colored Vinyl LP")).toBe("LP");
    });

    it("normalizes cassette variants", () => {
      expect(normalizeFormat("Cassette")).toBe("Cassette");
      expect(normalizeFormat("CASSETTE")).toBe("Cassette");
      expect(normalizeFormat("Limited Edition Cassette")).toBe("Cassette");
    });

    it("normalizes CD variants", () => {
      expect(normalizeFormat("Compact Disc (CD)")).toBe("CD");
      expect(normalizeFormat("CD in Digipack")).toBe("CD");
      expect(normalizeFormat("Digipak CD")).toBe("CD");
    });

    it("returns null for non-music formats", () => {
      expect(normalizeFormat("T-Shirt/Shirt")).toBeNull();
      expect(normalizeFormat("Bag")).toBeNull();
      expect(normalizeFormat("Poster/Print")).toBeNull();
      expect(normalizeFormat(null)).toBeNull();
      expect(normalizeFormat(undefined)).toBeNull();
    });
  });

  describe("assembleBandcampTitle", () => {
    it("builds title with artist, album, and format", () => {
      expect(assembleBandcampTitle("Lionmilk", "Visions in Paraíso", "CASSETTE", "Cassette")).toBe(
        "Lionmilk - Visions in Paraíso Cassette",
      );
    });

    it("builds title with artist and album but no format", () => {
      expect(assembleBandcampTitle("Artist", "Album Title", "LP")).toBe("Artist - Album Title");
    });

    it("omits format when format is null", () => {
      expect(assembleBandcampTitle("Artist", "Album", "LP", null)).toBe("Artist - Album");
    });

    it("includes format even when itemTitle equals formatType", () => {
      expect(assembleBandcampTitle("Artist", "Album", "Cassette", "Cassette")).toBe(
        "Artist - Album Cassette",
      );
    });

    it("omits format when album already contains it", () => {
      expect(assembleBandcampTitle("Artist", "Album Vinyl LP", "VINYL", "Vinyl LP")).toBe(
        "Artist - Album Vinyl LP",
      );
    });

    it("uses item title for merch without album", () => {
      expect(assembleBandcampTitle("LEAVING RECORDS", null, "Rainbow Bridge Magnet")).toBe(
        "LEAVING RECORDS - Rainbow Bridge Magnet",
      );
    });

    it("uses item alone when artist matches item", () => {
      expect(assembleBandcampTitle("Tape", undefined, "Tape")).toBe("Tape");
    });

    it("uses item alone when artist is empty", () => {
      expect(assembleBandcampTitle("", null, "Some Item")).toBe("Some Item");
    });

    it("uses normalized format from normalizeFormat", () => {
      expect(
        assembleBandcampTitle(
          "Nico Georis",
          "Music Belongs To The Universe",
          "BLACK VINYL",
          "Vinyl LP",
        ),
      ).toBe("Nico Georis - Music Belongs To The Universe LP");
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

  // Phase 1 — `getShippingOriginDetails` is the multi-origin probe used by
  // `bandcamp-baseline-audit`. The wrapper must POST to the documented
  // endpoint, parse the `origins[]` array, and surface any API-level error
  // (the API returns 200 + `{ error: true }` for application errors).
  describe("getShippingOriginDetails", () => {
    it("returns parsed origins on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          origins: [
            { origin_id: 1, name: "Default", is_default: true, country_code: "US" },
            { origin_id: 2, name: "EU warehouse", country_code: "DE" },
          ],
        }),
      });

      const origins = await getShippingOriginDetails(123, "tok");

      expect(origins).toHaveLength(2);
      expect(origins[0].origin_id).toBe(1);
      expect(origins[1].country_code).toBe("DE");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://bandcamp.com/api/merchorders/1/get_shipping_origin_details",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        }),
      );
    });

    it("treats missing `origins` as empty array (single-origin merchant default)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const origins = await getShippingOriginDetails(123, "tok");
      expect(origins).toEqual([]);
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      await expect(getShippingOriginDetails(123, "tok")).rejects.toThrow(/503/);
    });

    it("throws on application-level `{ error: true }`", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: true, error_message: "permission denied" }),
      });
      await expect(getShippingOriginDetails(123, "tok")).rejects.toThrow(/permission denied/);
    });
  });
});
