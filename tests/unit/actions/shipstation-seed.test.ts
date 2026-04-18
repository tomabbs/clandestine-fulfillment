import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockTrigger, mockRetrieve, mockRequireAuth } = vi.hoisted(() => ({
  mockTrigger: vi.fn(),
  mockRetrieve: vi.fn(),
  mockRequireAuth: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
  runs: { retrieve: mockRetrieve },
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: mockRequireAuth,
}));

const supabaseChain = {
  data: [] as unknown,
  error: null as unknown,
};

const fromMock = vi.fn(() => {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(supabaseChain),
  };
  return chain;
});

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: fromMock }),
}));

// Import the actions AFTER mocks are wired
import {
  listShipStationSeedRuns,
  previewShipStationSeed,
  triggerShipStationSeed,
} from "@/actions/shipstation-seed";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VALID_INPUT = {
  workspaceId: WORKSPACE_ID,
  inventoryWarehouseId: "se-214575",
  inventoryLocationId: "se-3213662",
};

function staffCtx(workspaceId = WORKSPACE_ID) {
  return {
    isStaff: true,
    userRecord: { workspace_id: workspaceId },
  };
}

describe("shipstation-seed Server Actions (Rule #41 + #48)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseChain.data = [];
    supabaseChain.error = null;
    mockRequireAuth.mockResolvedValue(staffCtx());
  });

  // ── Auth gate ──────────────────────────────────────────────────────────────

  it("triggerShipStationSeed throws for non-staff users", async () => {
    mockRequireAuth.mockResolvedValue({
      isStaff: false,
      userRecord: { workspace_id: WORKSPACE_ID },
    });
    await expect(triggerShipStationSeed(VALID_INPUT)).rejects.toThrow("Staff access required");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("triggerShipStationSeed rejects cross-workspace input", async () => {
    mockRequireAuth.mockResolvedValue(staffCtx(OTHER_WORKSPACE_ID));
    await expect(triggerShipStationSeed(VALID_INPUT)).rejects.toThrow(
      "Cross-workspace seed not permitted",
    );
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("previewShipStationSeed enforces the same staff/workspace gate", async () => {
    mockRequireAuth.mockResolvedValue({
      isStaff: false,
      userRecord: { workspace_id: WORKSPACE_ID },
    });
    await expect(previewShipStationSeed(VALID_INPUT)).rejects.toThrow("Staff access required");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("listShipStationSeedRuns enforces the same staff/workspace gate", async () => {
    mockRequireAuth.mockResolvedValue({
      isStaff: false,
      userRecord: { workspace_id: WORKSPACE_ID },
    });
    await expect(listShipStationSeedRuns({ workspaceId: WORKSPACE_ID })).rejects.toThrow(
      "Staff access required",
    );
  });

  // ── Zod validation ────────────────────────────────────────────────────────

  it("triggerShipStationSeed rejects non-uuid workspaceId", async () => {
    await expect(
      triggerShipStationSeed({ ...VALID_INPUT, workspaceId: "not-a-uuid" }),
    ).rejects.toThrow();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("triggerShipStationSeed rejects empty inventory ids", async () => {
    await expect(
      triggerShipStationSeed({ ...VALID_INPUT, inventoryWarehouseId: "" }),
    ).rejects.toThrow();
    await expect(
      triggerShipStationSeed({ ...VALID_INPUT, inventoryLocationId: "" }),
    ).rejects.toThrow();
  });

  // ── Trigger contract (Rule #48 — never call ShipStation directly) ─────────

  it("triggerShipStationSeed enqueues the task with dryRun: false", async () => {
    mockTrigger.mockResolvedValue({ id: "run_real_123" });
    const result = await triggerShipStationSeed(VALID_INPUT);

    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith("shipstation-seed-inventory", {
      ...VALID_INPUT,
      dryRun: false,
    });
    expect(result).toEqual({
      status: "queued",
      taskRunId: "run_real_123",
      workspaceId: WORKSPACE_ID,
    });
  });

  it("previewShipStationSeed enqueues the task with dryRun: true", async () => {
    mockTrigger.mockResolvedValue({ id: "run_preview_456" });
    mockRetrieve.mockResolvedValue({
      status: "COMPLETED",
      output: { seeded: 12 } as Record<string, unknown>,
    });

    const result = await previewShipStationSeed(VALID_INPUT);

    expect(mockTrigger).toHaveBeenCalledWith("shipstation-seed-inventory", {
      ...VALID_INPUT,
      dryRun: true,
    });
    expect(result.status).toBe("completed");
    expect(result.taskRunId).toBe("run_preview_456");
  });

  it("previewShipStationSeed surfaces task failure", async () => {
    mockTrigger.mockResolvedValue({ id: "run_preview_fail" });
    mockRetrieve.mockResolvedValue({ status: "FAILED" });
    await expect(previewShipStationSeed(VALID_INPUT)).rejects.toThrow("Preview failed");
  });

  // ── Recent runs read path ─────────────────────────────────────────────────

  it("listShipStationSeedRuns returns rows from channel_sync_log", async () => {
    supabaseChain.data = [
      {
        id: "row_1",
        status: "completed",
        items_processed: 5,
        items_failed: 0,
        started_at: "2025-01-01T00:00:00Z",
        completed_at: "2025-01-01T00:00:05Z",
        metadata: { run_id: "abc" },
      },
    ];
    const rows = await listShipStationSeedRuns({ workspaceId: WORKSPACE_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("row_1");
    expect(fromMock).toHaveBeenCalledWith("channel_sync_log");
  });

  it("listShipStationSeedRuns surfaces Supabase errors", async () => {
    supabaseChain.data = null;
    supabaseChain.error = { message: "boom" };
    await expect(listShipStationSeedRuns({ workspaceId: WORKSPACE_ID })).rejects.toThrow("boom");
  });
});
