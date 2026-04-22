import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockServiceClient = {
  from: mockServiceFrom,
};

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: vi.fn(() =>
    Promise.resolve({
      supabase: { from: mockFrom },
      authUserId: "auth-1",
      userRecord: {
        id: "user-1",
        workspace_id: "ws-1",
        org_id: null,
        role: "admin",
        email: "admin@test.com",
        name: "Admin",
      },
      isStaff: true,
    }),
  ),
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
  requireClient: vi.fn(() =>
    Promise.resolve({ userId: "user-1", orgId: "org-1", workspaceId: "ws-1" }),
  ),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: vi.fn() }, from: vi.fn() }),
  createServiceRoleClient: () => mockServiceClient,
}));

const mockTrigger = vi.fn();
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

import {
  createBandcampConnection,
  deleteBandcampConnection,
  flipBandcampPrimaryToDirect,
  getBandcampAccounts,
  getOrganizationsForWorkspace,
  triggerBandcampSync,
} from "@/actions/bandcamp";
// Import after mocks
import { requireAuth } from "@/lib/server/auth-context";

describe("bandcamp server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue({
      supabase: { from: mockFrom } as never,
      authUserId: "auth-1",
      userRecord: {
        id: "user-1",
        workspace_id: "ws-1",
        org_id: null,
        role: "admin",
        email: "admin@test.com",
        name: "Admin",
      },
      isStaff: true,
    });
  });

  describe("triggerBandcampSync", () => {
    it("enqueues a bandcamp-sync task via Trigger (Rule #48)", async () => {
      mockTrigger.mockResolvedValue({ id: "run-123" });

      const result = await triggerBandcampSync("ws-1");

      expect(mockTrigger).toHaveBeenCalledWith("bandcamp-sync", { workspaceId: "ws-1" });
      expect(result.taskRunId).toBe("run-123");
    });

    it("throws when user is not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));

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
            // memberBandIds.length > 0 in this fixture (band_id 1 + 2) so production
            // takes the `.in("bandcamp_member_band_id", memberBandIds)` branch, not
            // `.eq(...)`. Both are stubbed for defense against future fixture edits.
            in: vi.fn().mockResolvedValue({ count: 15 }),
            eq: vi.fn().mockResolvedValue({ count: 15 }),
          }),
        });

      const result = await getBandcampAccounts("ws-1");

      expect(result).toHaveLength(1);
      expect(result[0].band_name).toBe("Test Band");
      expect(result[0].memberArtistCount).toBe(2);
      expect(result[0].merchItemCount).toBe(15);
    });

    it("returns empty list when user is not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));

      await expect(getBandcampAccounts("ws-1")).resolves.toEqual([]);
    });
  });

  describe("createBandcampConnection", () => {
    it("creates a connection with org_id properly set", async () => {
      const orgId = "11111111-1111-4111-a111-111111111111";
      const wsId = "22222222-2222-4222-a222-222222222222";

      // Mock org lookup
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: orgId, workspace_id: wsId },
              error: null,
            }),
          }),
        }),
      });

      // Mock upsert
      mockServiceFrom.mockReturnValueOnce({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: "conn-new",
                workspace_id: wsId,
                org_id: orgId,
                band_id: 1430196613,
                band_name: "Across the Horizon",
                band_url: null,
                is_active: true,
                member_bands_cache: null,
                last_synced_at: null,
                created_at: "2026-03-17T00:00:00Z",
                updated_at: "2026-03-17T00:00:00Z",
              },
              error: null,
            }),
          }),
        }),
      });

      const result = await createBandcampConnection({
        workspaceId: wsId,
        orgId,
        bandId: 1430196613,
        bandName: "Across the Horizon",
      });

      expect(result.org_id).toBe(orgId);
      expect(result.band_id).toBe(1430196613);
      expect(result.band_name).toBe("Across the Horizon");
    });

    it("throws when org is not found", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } }),
          }),
        }),
      });

      await expect(
        createBandcampConnection({
          workspaceId: "22222222-2222-4222-a222-222222222222",
          orgId: "11111111-1111-4111-a111-111111111111",
          bandId: 123,
          bandName: "Test",
        }),
      ).rejects.toThrow("Organization not found");
    });

    it("throws when org belongs to a different workspace", async () => {
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: "11111111-1111-4111-a111-111111111111",
                workspace_id: "99999999-9999-4999-a999-999999999999",
              },
              error: null,
            }),
          }),
        }),
      });

      await expect(
        createBandcampConnection({
          workspaceId: "22222222-2222-4222-a222-222222222222",
          orgId: "11111111-1111-4111-a111-111111111111",
          bandId: 123,
          bandName: "Test",
        }),
      ).rejects.toThrow("Organization does not belong to this workspace");
    });

    it("rejects when org_id is omitted (Zod validation)", async () => {
      await expect(
        createBandcampConnection({
          workspaceId: "22222222-2222-4222-a222-222222222222",
          bandId: 123,
          bandName: "Test",
        } as Parameters<typeof createBandcampConnection>[0]),
      ).rejects.toThrow();
    });

    it("rejects when org_id is empty string (invalid UUID)", async () => {
      await expect(
        createBandcampConnection({
          workspaceId: "22222222-2222-4222-a222-222222222222",
          orgId: "",
          bandId: 123,
          bandName: "Test",
        } as Parameters<typeof createBandcampConnection>[0]),
      ).rejects.toThrow();
    });

    it("throws when user is not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));

      await expect(
        createBandcampConnection({
          workspaceId: "22222222-2222-4222-a222-222222222222",
          orgId: "11111111-1111-4111-a111-111111111111",
          bandId: 123,
          bandName: "Test",
        }),
      ).rejects.toThrow("Unauthorized");
    });
  });

  // Note: orgId is required (NOT NULL in DB). Zod rejects missing or empty values
  // before the insert is ever attempted, preventing null org_id constraint violations.

  describe("deleteBandcampConnection", () => {
    it("soft-deletes by setting is_active to false", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      mockServiceFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await deleteBandcampConnection({
        connectionId: "33333333-3333-4333-a333-333333333333",
      });

      expect(result).toEqual({ success: true });
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    });

    it("throws when user is not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));

      await expect(
        deleteBandcampConnection({ connectionId: "33333333-3333-4333-a333-333333333333" }),
      ).rejects.toThrow("Unauthorized");
    });
  });

  describe("getOrganizationsForWorkspace", () => {
    it("returns organizations sorted by name", async () => {
      const mockOrder = vi.fn().mockResolvedValue({
        data: [
          { id: "org-1", name: "Alpha Records" },
          { id: "org-2", name: "Beta Music" },
        ],
        error: null,
      });
      mockServiceFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: mockOrder,
          }),
        }),
      });

      const result = await getOrganizationsForWorkspace("ws-1");

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Alpha Records");
    });

    it("returns empty list when user is not authenticated", async () => {
      vi.mocked(requireAuth).mockRejectedValueOnce(new Error("Unauthorized"));

      await expect(getOrganizationsForWorkspace("ws-1")).resolves.toEqual([]);
    });
  });

  describe("flipBandcampPrimaryToDirect (Phase 5 / HRD-11.1)", () => {
    const wsUuid = "44444444-4444-4444-a444-444444444444";

    function stubWorkspaceLookup(row: Record<string, unknown> | null) {
      mockServiceFrom.mockImplementationOnce((table: string) => {
        expect(table).toBe("workspaces");
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
            }),
          }),
        };
      });
    }

    function stubSsActivityCount(count: number) {
      mockServiceFrom.mockImplementationOnce((table: string) => {
        expect(table).toBe("warehouse_shipments");
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              not: vi.fn().mockReturnValue({
                gte: vi.fn().mockResolvedValue({ count, error: null }),
              }),
            }),
          }),
        };
      });
    }

    function stubWorkspaceUpdate() {
      mockServiceFrom.mockImplementationOnce((table: string) => {
        expect(table).toBe("workspaces");
        return {
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      });
    }

    function stubSensorInsert(captured: { row: unknown }) {
      mockServiceFrom.mockImplementationOnce((table: string) => {
        expect(table).toBe("sensor_readings");
        return {
          insert: vi.fn((row: unknown) => {
            captured.row = row;
            return Promise.resolve({ error: null });
          }),
        };
      });
    }

    function stubReviewQueueInsert(captured: { row: unknown }) {
      mockServiceFrom.mockImplementationOnce((table: string) => {
        expect(table).toBe("warehouse_review_queue");
        return {
          insert: vi.fn((row: unknown) => {
            captured.row = row;
            return Promise.resolve({ error: null });
          }),
        };
      });
    }

    it("requires staff role", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        supabase: { from: mockFrom } as never,
        authUserId: "auth-1",
        userRecord: {
          id: "client-1",
          workspace_id: wsUuid,
          org_id: "org-1",
          role: "client",
          email: "client@test.com",
          name: "Client",
        },
        isStaff: false,
      });
      await expect(
        flipBandcampPrimaryToDirect({
          workspaceId: wsUuid,
          direction: "enable_direct_primary",
          reason: "rollout",
        }),
      ).rejects.toThrow("Staff access required");
    });

    it("blocks enable when shipstation_sync_paused=false", async () => {
      stubWorkspaceLookup({
        id: wsUuid,
        shipstation_sync_paused: false,
        bc_verify_direct_primary: false,
      });
      stubSsActivityCount(0);

      const result = await flipBandcampPrimaryToDirect({
        workspaceId: wsUuid,
        direction: "enable_direct_primary",
        reason: "rollout",
      });

      expect(result.ok).toBe(false);
      expect(result.preconditionsPassed).toBe(false);
      expect(result.blockedBy.some((b) => b.includes("shipstation_sync_paused"))).toBe(true);
    });

    it("blocks enable when SS connector pushed BC shipments in last 48h", async () => {
      stubWorkspaceLookup({
        id: wsUuid,
        shipstation_sync_paused: true,
        bc_verify_direct_primary: false,
      });
      stubSsActivityCount(7);

      const result = await flipBandcampPrimaryToDirect({
        workspaceId: wsUuid,
        direction: "enable_direct_primary",
        reason: "rollout",
      });

      expect(result.ok).toBe(false);
      expect(result.blockedBy.some((b) => b.includes("48h"))).toBe(true);
    });

    it("flips polarity when both preconditions pass and emits a healthy sensor reading", async () => {
      stubWorkspaceLookup({
        id: wsUuid,
        shipstation_sync_paused: true,
        bc_verify_direct_primary: false,
      });
      stubSsActivityCount(0);
      stubWorkspaceUpdate();
      const sensorCap: { row: unknown } = { row: null };
      stubSensorInsert(sensorCap);

      const result = await flipBandcampPrimaryToDirect({
        workspaceId: wsUuid,
        direction: "enable_direct_primary",
        reason: "northern-spy go-live",
      });

      expect(result.ok).toBe(true);
      expect(result.preconditionsPassed).toBe(true);
      expect(result.newValue).toBe(true);
      expect(result.bypassed).toBe(false);
      const sensor = sensorCap.row as { sensor_name: string; status: string };
      expect(sensor.sensor_name).toBe("bandcamp.polarity_flip");
      expect(sensor.status).toBe("healthy");
    });

    it("force=true bypasses preconditions, sets warning sensor, and writes a review queue item", async () => {
      stubWorkspaceLookup({
        id: wsUuid,
        shipstation_sync_paused: false,
        bc_verify_direct_primary: false,
      });
      stubSsActivityCount(3);
      stubWorkspaceUpdate();
      const sensorCap: { row: unknown } = { row: null };
      const queueCap: { row: unknown } = { row: null };
      stubSensorInsert(sensorCap);
      stubReviewQueueInsert(queueCap);

      const result = await flipBandcampPrimaryToDirect({
        workspaceId: wsUuid,
        direction: "enable_direct_primary",
        reason: "manual emergency override",
        force: true,
      });

      expect(result.ok).toBe(true);
      expect(result.preconditionsPassed).toBe(false);
      expect(result.bypassed).toBe(true);
      expect((sensorCap.row as { status: string }).status).toBe("warning");
      const q = queueCap.row as { category: string; severity: string; title: string };
      expect(q.category).toBe("bandcamp_polarity_force_flip");
      expect(q.severity).toBe("high");
      expect(q.title).toContain("force-flipped");
    });

    it("disable direction is always allowed even when SS has been active (rollback path)", async () => {
      stubWorkspaceUpdate();
      const sensorCap: { row: unknown } = { row: null };
      stubSensorInsert(sensorCap);

      const result = await flipBandcampPrimaryToDirect({
        workspaceId: wsUuid,
        direction: "disable_direct_primary",
        reason: "rolling back due to incident",
      });

      expect(result.ok).toBe(true);
      expect(result.newValue).toBe(false);
      expect(result.preconditionsPassed).toBe(true);
    });

    it("idempotent: returns ok without changes when already enabled", async () => {
      stubWorkspaceLookup({
        id: wsUuid,
        shipstation_sync_paused: true,
        bc_verify_direct_primary: true,
      });

      const result = await flipBandcampPrimaryToDirect({
        workspaceId: wsUuid,
        direction: "enable_direct_primary",
        reason: "double-tap",
      });

      expect(result.ok).toBe(true);
      expect(result.newValue).toBe(true);
      expect(result.preconditionsPassed).toBe(true);
    });
  });
});
