import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeMatchSuggestions } from "@/lib/shared/store-match";

// --- Mocks ---

const mockGetUser = vi.fn();
const mockServerClient = {
  auth: { getUser: mockGetUser },
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
  autoMatchStores,
  getStoreMappings,
  unmapStore,
  updateStoreMapping,
} from "@/actions/store-mapping";

// === computeMatchSuggestions unit tests (pure function, no mocks needed) ===

describe("computeMatchSuggestions", () => {
  it("returns high confidence (1.0) for exact name match", () => {
    const stores = [{ id: "s1", store_name: "Acme Records" }];
    const orgs = [{ id: "o1", name: "Acme Records" }];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(1.0);
    expect(result[0].suggestedOrgId).toBe("o1");
    expect(result[0].suggestedOrgName).toBe("Acme Records");
  });

  it("is case insensitive for exact matches", () => {
    const stores = [{ id: "s1", store_name: "ACME RECORDS" }];
    const orgs = [{ id: "o1", name: "acme records" }];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(1.0);
  });

  it("returns medium confidence for partial/contains match", () => {
    const stores = [{ id: "s1", store_name: "Acme Records Bandcamp Store" }];
    const orgs = [{ id: "o1", name: "Acme Records" }];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBeGreaterThan(0.5);
    expect(result[0].confidence).toBeLessThan(1.0);
  });

  it("returns empty suggestions when no match found", () => {
    const stores = [{ id: "s1", store_name: "Totally Different Name" }];
    const orgs = [{ id: "o1", name: "Acme Records" }];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(0);
  });

  it("handles multiple stores matching the same org", () => {
    const stores = [
      { id: "s1", store_name: "Acme Records Shopify" },
      { id: "s2", store_name: "Acme Records Bandcamp" },
    ];
    const orgs = [{ id: "o1", name: "Acme Records" }];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(2);
    expect(result[0].suggestedOrgId).toBe("o1");
    expect(result[1].suggestedOrgId).toBe("o1");
  });

  it("skips stores with null store_name", () => {
    const stores = [{ id: "s1", store_name: null }];
    const orgs = [{ id: "o1", name: "Acme Records" }];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(0);
  });

  it("picks the best match when multiple orgs could match", () => {
    const stores = [{ id: "s1", store_name: "Acme Records" }];
    const orgs = [
      { id: "o1", name: "Acme" },
      { id: "o2", name: "Acme Records" },
    ];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedOrgId).toBe("o2");
    expect(result[0].confidence).toBe(1.0);
  });

  it("handles case-insensitive contains match", () => {
    const stores = [{ id: "s1", store_name: "MY STORE - ACME RECORDS" }];
    const orgs = [{ id: "o1", name: "Acme Records" }];

    const result = computeMatchSuggestions(stores, orgs);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBeGreaterThan(0.5);
  });
});

// === Server Action tests (with mocks) ===

describe("store mapping server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  describe("getStoreMappings", () => {
    it("returns stores with org names", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "store-1",
                  workspace_id: "ws-1",
                  org_id: "org-1",
                  store_id: 100,
                  store_name: "Test Store",
                  marketplace_name: "Shopify",
                  created_at: "2026-01-01T00:00:00Z",
                  organizations: { name: "Test Org" },
                },
              ],
              error: null,
            }),
          }),
        }),
      });

      const result = await getStoreMappings("ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].store_name).toBe("Test Store");
      expect(result[0].org_name).toBe("Test Org");
    });

    it("returns 'null' org_name for unmapped stores", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "store-1",
                  workspace_id: "ws-1",
                  org_id: null,
                  store_id: 100,
                  store_name: "Unmapped Store",
                  marketplace_name: "eBay",
                  created_at: "2026-01-01T00:00:00Z",
                  organizations: null,
                },
              ],
              error: null,
            }),
          }),
        }),
      });

      const result = await getStoreMappings("ws-1");

      expect(result[0].org_name).toBeNull();
    });

    it("throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(getStoreMappings("ws-1")).rejects.toThrow("Unauthorized");
    });
  });

  describe("updateStoreMapping", () => {
    it("updates the org_id on the store row", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      mockServiceFrom.mockReturnValue({ update: mockUpdate });

      await updateStoreMapping("store-1", "org-1");

      expect(mockServiceFrom).toHaveBeenCalledWith("warehouse_shipstation_stores");
      expect(mockUpdate).toHaveBeenCalledWith({ org_id: "org-1" });
    });

    it("throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(updateStoreMapping("store-1", "org-1")).rejects.toThrow("Unauthorized");
    });
  });

  describe("unmapStore", () => {
    it("sets org_id to null", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      mockServiceFrom.mockReturnValue({ update: mockUpdate });

      await unmapStore("store-1");

      expect(mockUpdate).toHaveBeenCalledWith({ org_id: null });
    });

    it("throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(unmapStore("store-1")).rejects.toThrow("Unauthorized");
    });
  });

  describe("autoMatchStores", () => {
    it("returns suggestions for unmapped stores", async () => {
      mockServiceFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockResolvedValue({
                data: [{ id: "s1", store_name: "Cool Label" }],
                error: null,
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: "o1", name: "Cool Label" }],
              error: null,
            }),
          }),
        });

      const result = await autoMatchStores("ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBe(1.0);
      expect(result[0].suggestedOrgId).toBe("o1");
    });

    it("returns empty array when no unmapped stores", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            is: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        }),
      });

      const result = await autoMatchStores("ws-1");

      expect(result).toHaveLength(0);
    });

    it("throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      await expect(autoMatchStores("ws-1")).rejects.toThrow("Unauthorized");
    });
  });
});
