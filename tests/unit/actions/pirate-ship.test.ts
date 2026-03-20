import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

const mockSupabaseClient = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: vi.fn(async () => mockSupabaseClient),
}));

const mockTrigger = vi.fn();
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

// --- Helpers ---

function setupAuthenticatedUser(userId: string, workspaceId: string) {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } } });

  // Mock users query for workspace_id
  const userQuery = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { workspace_id: workspaceId },
        }),
      }),
    }),
  };

  return userQuery;
}

describe("pirate-ship server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initiateImport", () => {
    it("creates import record and triggers task", async () => {
      const userQuery = setupAuthenticatedUser("user-1", "ws-1");
      const importId = "import-uuid-1";

      mockFrom.mockImplementation((table: string) => {
        if (table === "users") return userQuery;
        if (table === "warehouse_pirate_ship_imports") {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: importId },
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      mockTrigger.mockResolvedValue({ id: "run-1" });

      const { initiateImport } = await import("@/actions/pirate-ship");
      const result = await initiateImport("imports/test.xlsx", "test.xlsx");

      expect(result.importId).toBe(importId);
      expect(mockTrigger).toHaveBeenCalledWith("pirate-ship-import", {
        importId,
        workspaceId: "ws-1",
      });
    });

    it("throws on unauthenticated access", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      mockFrom.mockReturnValue({ select: vi.fn() });

      const { initiateImport } = await import("@/actions/pirate-ship");
      await expect(initiateImport("path", "file.xlsx")).rejects.toThrow("Unauthorized");
    });

    it("validates input with Zod", async () => {
      setupAuthenticatedUser("user-1", "ws-1");
      mockFrom.mockReturnValue({ select: vi.fn() });

      const { initiateImport } = await import("@/actions/pirate-ship");
      await expect(initiateImport("", "file.xlsx")).rejects.toThrow();
    });
  });

  describe("getImportHistory", () => {
    it("returns paginated imports", async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

      const mockData = [
        { id: "imp-1", file_name: "test.xlsx", status: "completed" },
        { id: "imp-2", file_name: "test2.xlsx", status: "pending" },
      ];

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            range: vi.fn().mockResolvedValue({
              data: mockData,
              count: 2,
              error: null,
            }),
          }),
        }),
      });

      const { getImportHistory } = await import("@/actions/pirate-ship");
      const result = await getImportHistory();

      expect(result.imports).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
    });

    it("returns empty paginated response on unauthenticated access", async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } });
      mockFrom.mockReturnValue({ select: vi.fn() });

      const { getImportHistory } = await import("@/actions/pirate-ship");
      await expect(getImportHistory()).resolves.toEqual({
        imports: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });
    });
  });

  describe("getImportDetail", () => {
    it("returns import with matched shipments and unmatched items", async () => {
      mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

      const importData = {
        id: "imp-1",
        file_name: "test.xlsx",
        status: "completed",
        row_count: 10,
        processed_count: 8,
        error_count: 2,
        errors: [],
      };

      const shipments = [{ id: "ship-1", tracking_number: "TRACK1", carrier: "UPS" }];

      const reviewItems = [{ id: "review-1", metadata: { recipient_name: "Unknown" } }];

      mockFrom.mockImplementation((table: string) => {
        if (table === "warehouse_pirate_ship_imports") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: importData,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_review_queue") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                filter: vi.fn().mockResolvedValue({
                  data: reviewItems,
                }),
              }),
            }),
          };
        }
        if (table === "warehouse_shipments") {
          return {
            select: vi.fn().mockReturnValue({
              filter: vi.fn().mockResolvedValue({
                data: shipments,
              }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const { getImportDetail } = await import("@/actions/pirate-ship");
      const result = await getImportDetail("a0000000-0000-4000-a000-000000000001");

      expect(result.import).toEqual(importData);
      expect(result.matchedShipments).toHaveLength(1);
      expect(result.unmatchedItems).toHaveLength(1);
    });
  });
});
