import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockTrigger, mockRequireAuth, fromMock, storageFromMock, lastInserted } = vi.hoisted(
  () => ({
    mockTrigger: vi.fn(),
    mockRequireAuth: vi.fn(),
    fromMock: vi.fn(),
    storageFromMock: vi.fn(),
    lastInserted: { value: null as unknown },
  }),
);

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: mockRequireAuth,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: fromMock,
    storage: { from: storageFromMock },
  }),
}));

import {
  getShipstationExportDownloadUrls,
  listShipstationExportRuns,
  triggerShipstationExport,
} from "@/actions/shipstation-export";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

function staffCtx(workspaceId = WORKSPACE_ID) {
  return {
    isStaff: true,
    userRecord: { id: USER_ID, workspace_id: workspaceId },
  };
}

/**
 * Build a "from" mock that returns a fluent chain whose `.insert(...).select().single()`
 * resolves to `{ data: { id: RUN_ID }, error: null }` and whose
 * `.update(...).eq(...)` resolves with no error.
 *
 * Also captures the row passed to `insert(...)` for assertions and supports
 * a queryable "previous run" lookup branch for incremental mode.
 */
function setupFromMock(
  opts: { previousDataMaxTs?: string | null; runRow?: Record<string, unknown> } = {},
) {
  fromMock.mockImplementation((table: string) => {
    if (table === "shipstation_export_runs") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        // Previous-run lookup
        maybeSingle: () =>
          Promise.resolve({
            data: opts.previousDataMaxTs ? { data_max_ts: opts.previousDataMaxTs } : null,
            error: null,
          }),
        // INSERT path
        insert: (row: unknown) => {
          lastInserted.value = row;
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: RUN_ID }, error: null }),
            }),
          };
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        // Fetching a single run for download links
        single: () =>
          Promise.resolve({
            data: opts.runRow ?? {
              workspace_id: WORKSPACE_ID,
              status: "completed",
              csv_storage_path: "ws/20260420/abc.csv",
              xlsx_storage_path: "ws/20260420/abc.xlsx",
              summary_storage_path: "ws/20260420/abc.summary.json",
            },
            error: null,
          }),
      };
      return chain;
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastInserted.value = null;
  mockRequireAuth.mockResolvedValue(staffCtx());
  mockTrigger.mockResolvedValue({ id: "task_run_abc" });
});

describe("shipstation-export Server Actions (Rule #41 + #48)", () => {
  // ── Auth gate ──────────────────────────────────────────────────────────────

  it("triggerShipstationExport throws for non-staff users", async () => {
    mockRequireAuth.mockResolvedValue({
      isStaff: false,
      userRecord: { id: USER_ID, workspace_id: WORKSPACE_ID },
    });
    setupFromMock();
    await expect(triggerShipstationExport({ mode: "full" })).rejects.toThrow(
      "Staff access required",
    );
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  // ── Full export ────────────────────────────────────────────────────────────

  it("full mode never sets since_ts", async () => {
    setupFromMock();
    const result = await triggerShipstationExport({ mode: "full" });
    expect(result.mode).toBe("full");
    expect(result.sinceTs).toBeNull();
    expect((lastInserted.value as { since_ts: unknown }).since_ts).toBeNull();
    expect(mockTrigger).toHaveBeenCalledWith("shipstation-export", { runId: RUN_ID });
  });

  // ── Incremental export ────────────────────────────────────────────────────

  it("incremental mode falls back to since_ts=null when no prior run exists", async () => {
    setupFromMock({ previousDataMaxTs: null });
    const result = await triggerShipstationExport({ mode: "incremental" });
    expect(result.mode).toBe("incremental");
    expect(result.sinceTs).toBeNull();
  });

  it("incremental mode chains since_ts = previous run's data_max_ts", async () => {
    const prev = "2026-04-19T10:00:00.000Z";
    setupFromMock({ previousDataMaxTs: prev });
    const result = await triggerShipstationExport({ mode: "incremental" });
    expect(result.sinceTs).toBe(prev);
    expect((lastInserted.value as { since_ts: unknown }).since_ts).toBe(prev);
  });

  // ── Cross-workspace download protection ────────────────────────────────────

  it("getShipstationExportDownloadUrls rejects cross-workspace runs", async () => {
    setupFromMock({
      runRow: {
        workspace_id: OTHER_WORKSPACE_ID,
        status: "completed",
        csv_storage_path: "x/y/z.csv",
        xlsx_storage_path: "x/y/z.xlsx",
        summary_storage_path: "x/y/z.json",
      },
    });
    await expect(getShipstationExportDownloadUrls({ runId: RUN_ID })).rejects.toThrow(
      "Cross-workspace download not permitted",
    );
  });

  it("getShipstationExportDownloadUrls rejects non-completed runs", async () => {
    setupFromMock({
      runRow: {
        workspace_id: WORKSPACE_ID,
        status: "running",
        csv_storage_path: null,
        xlsx_storage_path: null,
        summary_storage_path: null,
      },
    });
    await expect(getShipstationExportDownloadUrls({ runId: RUN_ID })).rejects.toThrow(
      /run is not completed/,
    );
  });

  it("getShipstationExportDownloadUrls returns signed URLs for completed runs", async () => {
    setupFromMock();
    storageFromMock.mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://signed.example.com/file" },
        error: null,
      }),
    });
    const urls = await getShipstationExportDownloadUrls({ runId: RUN_ID });
    expect(urls.csv).toBe("https://signed.example.com/file");
    expect(urls.xlsx).toBe("https://signed.example.com/file");
    expect(urls.summary).toBe("https://signed.example.com/file");
  });

  // ── List runs ──────────────────────────────────────────────────────────────

  it("listShipstationExportRuns scopes by workspace and orders desc", async () => {
    fromMock.mockImplementationOnce(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [{ id: RUN_ID, mode: "full", status: "completed" }],
                error: null,
              }),
          }),
        }),
      }),
    }));
    const rows = await listShipstationExportRuns({ limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(RUN_ID);
  });
});
