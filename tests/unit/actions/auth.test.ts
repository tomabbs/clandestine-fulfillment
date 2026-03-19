import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAuth = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: () => mockRequireAuth(),
}));

import { getUserContext } from "@/actions/auth";

describe("auth Server Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getUserContext", () => {
    it("returns workspaceId, orgId, and isStaff for a staff user", async () => {
      mockRequireAuth.mockResolvedValue({
        authUserId: "auth-1",
        userRecord: {
          id: "user-1",
          workspace_id: "ws-1",
          org_id: null,
          role: "admin",
          email: "admin@example.com",
          name: "Admin User",
        },
        isStaff: true,
        supabase: {},
      });

      const result = await getUserContext();

      expect(result).toEqual({
        workspaceId: "ws-1",
        orgId: null,
        isStaff: true,
        userId: "user-1",
        userName: "Admin User",
      });
    });

    it("returns orgId for a client user", async () => {
      mockRequireAuth.mockResolvedValue({
        authUserId: "auth-2",
        userRecord: {
          id: "user-2",
          workspace_id: "ws-1",
          org_id: "org-123",
          role: "client",
          email: "client@label.com",
          name: "Client User",
        },
        isStaff: false,
        supabase: {},
      });

      const result = await getUserContext();

      expect(result).toEqual({
        workspaceId: "ws-1",
        orgId: "org-123",
        isStaff: false,
        userId: "user-2",
        userName: "Client User",
      });
    });

    it("throws when user is not authenticated", async () => {
      mockRequireAuth.mockRejectedValue(new Error("Unauthorized"));

      await expect(getUserContext()).rejects.toThrow("Unauthorized");
    });

    it("throws when user record is not found", async () => {
      mockRequireAuth.mockRejectedValue(new Error("User record not found"));

      await expect(getUserContext()).rejects.toThrow("User record not found");
    });

    it("throws when user has no workspace", async () => {
      mockRequireAuth.mockRejectedValue(new Error("User has no workspace assigned"));

      await expect(getUserContext()).rejects.toThrow("User has no workspace assigned");
    });
  });
});
