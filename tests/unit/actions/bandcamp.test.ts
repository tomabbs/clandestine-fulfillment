import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

const mockServerClient = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

const mockServiceFrom = vi.fn();
const mockServiceClient = {
  from: mockServiceFrom,
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => mockServerClient,
  createServiceRoleClient: () => mockServiceClient,
}));

const mockTrigger = vi.fn();
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

// Import after mocks
import { getBandcampAccounts, triggerBandcampSync } from "@/actions/bandcamp";

describe("bandcamp server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  describe("triggerBandcampSync", () => {
    it("enqueues a bandcamp-sync task via Trigger (Rule #48)", async () => {
      mockTrigger.mockResolvedValue({ id: "run-123" });

      const result = await triggerBandcampSync("ws-1");

      expect(mockTrigger).toHaveBeenCalledWith("bandcamp-sync", { workspaceId: "ws-1" });
      expect(result.taskRunId).toBe("run-123");
    });

    it("throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      await expect(triggerBandcampSync("ws-1")).rejects.toThrow("Unauthorized");
    });
  });

  describe("getBandcampAccounts", () => {
    it("returns accounts with member count and merch count", async () => {
      mockServiceFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: "conn-1",
                    workspace_id: "ws-1",
                    org_id: "org-1",
                    band_id: 12345,
                    band_name: "Test Band",
                    band_url: null,
                    is_active: true,
                    member_bands_cache: {
                      member_bands: [{ band_id: 1 }, { band_id: 2 }],
                    },
                    last_synced_at: "2026-03-16T00:00:00Z",
                    created_at: "2026-01-01T00:00:00Z",
                    updated_at: "2026-03-16T00:00:00Z",
                  },
                ],
                error: null,
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 15 }),
          }),
        });

      const result = await getBandcampAccounts("ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].band_name).toBe("Test Band");
      expect(result[0].memberArtistCount).toBe(2);
      expect(result[0].merchItemCount).toBe(15);
    });

    it("throws when user is not authenticated", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });

      await expect(getBandcampAccounts("ws-1")).rejects.toThrow("Unauthorized");
    });
  });
});
