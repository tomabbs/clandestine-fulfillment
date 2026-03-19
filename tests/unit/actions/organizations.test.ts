import { beforeEach, describe, expect, it, vi } from "vitest";

const { WS_ID } = vi.hoisted(() => ({
  WS_ID: "11111111-1111-4111-a111-111111111111",
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    supabase: {},
    authUserId: "auth-user-1",
    userRecord: {
      id: "user-1",
      workspace_id: WS_ID,
      org_id: null,
      role: "admin",
      email: "test@test.com",
      name: "Test User",
    },
    isStaff: true,
  }),
}));

const mockServiceClient = {
  from: vi.fn(),
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => mockServiceClient,
}));

import { createOrganization, getOrganizations } from "@/actions/organizations";
import { requireAuth } from "@/lib/server/auth-context";

describe("organizations server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({
      supabase: {} as never,
      authUserId: "auth-user-1",
      userRecord: {
        id: "user-1",
        workspace_id: WS_ID,
        org_id: null,
        role: "admin",
        email: "test@test.com",
        name: "Test User",
      },
      isStaff: true,
    });
  });

  describe("getOrganizations", () => {
    it("returns organizations for the user's workspace", async () => {
      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "organizations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    { id: "org-1", name: "Alpha Records", slug: "alpha-records" },
                    { id: "org-2", name: "Beta Music", slug: "beta-music" },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        return undefined;
      });

      const result = await getOrganizations();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Alpha Records");
    });

    it("throws when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(getOrganizations()).rejects.toThrow("Unauthorized");
    });
  });

  describe("createOrganization", () => {
    it("creates organization with slugified name", async () => {
      mockServiceClient.from.mockImplementation((table: string) => {
        if (table === "organizations") {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: "new-org", name: "Test Label", slug: "test-label" },
                  error: null,
                }),
              }),
            }),
          };
        }
        return undefined;
      });

      const result = await createOrganization({ name: "Test Label" });
      expect(result.name).toBe("Test Label");
      expect(result.id).toBe("new-org");
    });

    it("rejects empty name", async () => {
      await expect(createOrganization({ name: "" })).rejects.toThrow();
    });

    it("throws when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      await expect(createOrganization({ name: "Test" })).rejects.toThrow("Unauthorized");
    });
  });
});
