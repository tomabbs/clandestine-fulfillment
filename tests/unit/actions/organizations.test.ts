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
  rpc: vi.fn(),
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => mockServiceClient,
}));

import {
  createOrganization,
  getOrganizations,
  mergeOrganizations,
  previewMerge,
} from "@/actions/organizations";
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

    it("returns empty array when not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));
      const result = await getOrganizations();
      expect(result).toEqual([]);
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

  describe("previewMerge (HRD-36)", () => {
    const SOURCE = "11111111-aaaa-4111-a111-111111111111";
    const TARGET = "22222222-bbbb-4222-b222-222222222222";

    beforeEach(() => {
      mockServiceClient.rpc.mockReset();
    });

    it("requires admin role", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        supabase: {} as never,
        authUserId: "auth-user-1",
        userRecord: {
          id: "user-1",
          workspace_id: WS_ID,
          org_id: null,
          role: "label_staff",
          email: "test@test.com",
          name: "Test User",
        },
        isStaff: true,
      });
      await expect(previewMerge(SOURCE, TARGET)).rejects.toThrow("Only admins");
    });

    it("returns the RPC payload mapped onto the MergePreview shape", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({
        data: {
          source_name: "True Panther Records",
          target_name: "True Panther",
          affected_rows: { warehouse_products: 12, mailorder_orders: 3, oauth_states: 1 },
          total_affected: 16,
          collisions: [],
        },
        error: null,
      });

      const preview = await previewMerge(SOURCE, TARGET);

      expect(mockServiceClient.rpc).toHaveBeenCalledWith("preview_merge_organizations", {
        p_source_org_id: SOURCE,
        p_target_org_id: TARGET,
      });
      expect(preview.sourceOrg).toEqual({ id: SOURCE, name: "True Panther Records" });
      expect(preview.targetOrg).toEqual({ id: TARGET, name: "True Panther" });
      expect(preview.affectedRows).toEqual({
        warehouse_products: 12,
        mailorder_orders: 3,
        oauth_states: 1,
      });
      expect(preview.totalAffected).toBe(16);
      expect(preview.collisions).toEqual([]);
    });

    it("surfaces collisions in the preview payload", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({
        data: {
          source_name: "Duplicate Org",
          target_name: "Canonical Org",
          affected_rows: { warehouse_products: 1 },
          total_affected: 1,
          collisions: [
            {
              table: "client_store_connections",
              constraint: "idx_store_connections_org_platform_url",
              key: { platform: "shopify", store_url: "test.myshopify.com" },
              source_row_id: "src-1",
              target_row_id: "tgt-1",
            },
          ],
        },
        error: null,
      });

      const preview = await previewMerge(SOURCE, TARGET);
      expect(preview.collisions).toHaveLength(1);
      expect(preview.collisions[0].table).toBe("client_store_connections");
    });

    it("translates merge_workspace_mismatch errors into operator-friendly text", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: "merge_workspace_mismatch: source workspace=A target workspace=B" },
      });
      await expect(previewMerge(SOURCE, TARGET)).rejects.toThrow(/different workspaces/);
    });

    it("translates merge_source_not_found errors", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: `merge_source_not_found: ${SOURCE}` },
      });
      await expect(previewMerge(SOURCE, TARGET)).rejects.toThrow("Source organization not found");
    });

    it("throws when RPC returns empty payload", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({ data: null, error: null });
      await expect(previewMerge(SOURCE, TARGET)).rejects.toThrow("empty payload");
    });
  });

  describe("mergeOrganizations (HRD-36)", () => {
    const SOURCE = "11111111-aaaa-4111-a111-111111111111";
    const TARGET = "22222222-bbbb-4222-b222-222222222222";

    beforeEach(() => {
      mockServiceClient.rpc.mockReset();
    });

    it("requires admin role", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        supabase: {} as never,
        authUserId: "auth-user-1",
        userRecord: {
          id: "user-1",
          workspace_id: WS_ID,
          org_id: null,
          role: "warehouse_manager",
          email: "test@test.com",
          name: "Test User",
        },
        isStaff: true,
      });
      await expect(mergeOrganizations(SOURCE, TARGET)).rejects.toThrow("Only admins");
    });

    it("rejects self-merge before hitting the RPC", async () => {
      await expect(mergeOrganizations(SOURCE, SOURCE)).rejects.toThrow("itself");
      expect(mockServiceClient.rpc).not.toHaveBeenCalled();
    });

    it("calls merge_organizations_txn with the right args and returns the rowcount", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({ data: 42, error: null });

      const result = await mergeOrganizations(SOURCE, TARGET);

      expect(mockServiceClient.rpc).toHaveBeenCalledWith("merge_organizations_txn", {
        p_source_org_id: SOURCE,
        p_target_org_id: TARGET,
      });
      expect(result).toEqual({ merged: 42 });
    });

    it("translates merge_collisions_present errors so the UI can surface details", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            'merge_collisions_present: [{"table":"client_store_connections","constraint":"idx_store_connections_org_platform_url"}]',
        },
      });
      await expect(mergeOrganizations(SOURCE, TARGET)).rejects.toThrow(
        /Merge blocked by UNIQUE-constraint collisions/,
      );
    });

    it("translates merge_delete_failed (e.g. new org_id-bearing table not in v_tables)", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: "merge_delete_failed: orphan FK detected on source org abc-123" },
      });
      await expect(mergeOrganizations(SOURCE, TARGET)).rejects.toThrow(
        /Reassignment succeeded but final delete failed/,
      );
    });

    it("returns 0 merged when RPC returns null data (defensive)", async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({ data: null, error: null });
      const result = await mergeOrganizations(SOURCE, TARGET);
      expect(result).toEqual({ merged: 0 });
    });
  });
});
