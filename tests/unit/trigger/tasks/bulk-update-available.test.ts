import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecordInventoryChange = vi.fn();
vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: (...args: unknown[]) => mockRecordInventoryChange(...args),
}));

type LevelRow = {
  sku: string;
  available: number;
  count_status: "idle" | "count_in_progress";
  warehouse_product_variants: { id: string; warehouse_products: { org_id: string } };
};

let levelsResponse: { data: LevelRow[] | null; error: { message: string } | null } = {
  data: [],
  error: null,
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve(levelsResponse),
      };
      return chain;
    },
  }),
}));

vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: { name: "shipstation" },
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: (payload: unknown) => unknown }) => def,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  type BulkUpdateAvailablePayload,
  type BulkUpdateAvailableResult,
  bulkUpdateAvailableTask,
} from "@/trigger/tasks/bulk-update-available";

// The trigger SDK mock above returns the raw definition object; expose .run
// for direct invocation in tests by casting through unknown.
const taskDef = bulkUpdateAvailableTask as unknown as {
  run: (payload: BulkUpdateAvailablePayload) => Promise<BulkUpdateAvailableResult>;
};

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const WS_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const BATCH_ID = "44444444-4444-4444-8444-444444444444";

function levelRow(
  sku: string,
  available: number,
  opts: { orgId?: string; countStatus?: "idle" | "count_in_progress" } = {},
): LevelRow {
  return {
    sku,
    available,
    count_status: opts.countStatus ?? "idle",
    warehouse_product_variants: {
      id: `variant-${sku}`,
      warehouse_products: { org_id: opts.orgId ?? ORG_ID },
    },
  };
}

const runTask = (payload: BulkUpdateAvailablePayload) => taskDef.run(payload);

describe("bulk-update-available task", () => {
  beforeEach(() => {
    mockRecordInventoryChange.mockReset();
    mockRecordInventoryChange.mockResolvedValue({
      success: true,
      newQuantity: 0,
      alreadyProcessed: false,
    });
    levelsResponse = { data: [], error: null };
  });

  it("returns empty summary on empty entries (no Supabase call)", async () => {
    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [],
    });
    expect(result.appliedCount).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("applies an in-range delta and uses the stable correlation_id", async () => {
    levelsResponse = { data: [levelRow("SKU-A", 5)], error: null };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [{ sku: "SKU-A", newAvailable: 8 }],
    });

    expect(result.appliedCount).toBe(1);
    expect(result.results[0].status).toBe("applied");
    expect(result.results[0].delta).toBe(3);
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS_ID,
        sku: "SKU-A",
        delta: 3,
        source: "manual_inventory_count",
        correlationId: `manual-count:${USER_ID}:${BATCH_ID}:SKU-A`,
      }),
    );
  });

  it("requires confirmation for high-delta (>10) without force", async () => {
    levelsResponse = { data: [levelRow("SKU-A", 5)], error: null };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [{ sku: "SKU-A", newAvailable: 50 }],
    });

    expect(result.requiresConfirmCount).toBe(1);
    expect(result.results[0].status).toBe("requires_confirm");
    expect(result.results[0].reason).toBe("high_delta");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("force:true bypasses confirmation and applies high-delta writes", async () => {
    levelsResponse = { data: [levelRow("SKU-A", 5)], error: null };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [{ sku: "SKU-A", newAvailable: 50, force: true }],
    });

    expect(result.appliedCount).toBe(1);
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        delta: 45,
        metadata: expect.objectContaining({ force: true, batch_id: BATCH_ID }),
      }),
    );
  });

  it("requires confirmation for rising-from-zero and falling-to-zero", async () => {
    levelsResponse = {
      data: [levelRow("SKU-RISE", 0), levelRow("SKU-FALL", 3)],
      error: null,
    };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [
        { sku: "SKU-RISE", newAvailable: 4 },
        { sku: "SKU-FALL", newAvailable: 0 },
      ],
    });

    expect(result.requiresConfirmCount).toBe(2);
    const rise = result.results.find((r) => r.sku === "SKU-RISE");
    const fall = result.results.find((r) => r.sku === "SKU-FALL");
    expect(rise?.reason).toBe("rising_from_zero");
    expect(fall?.reason).toBe("falling_to_zero");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("blocks negative targets and skips count_in_progress rows", async () => {
    levelsResponse = {
      data: [
        levelRow("SKU-NEG", 5),
        levelRow("SKU-LOCKED", 5, { countStatus: "count_in_progress" }),
      ],
      error: null,
    };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [
        { sku: "SKU-NEG", newAvailable: -1 },
        { sku: "SKU-LOCKED", newAvailable: 4 },
      ],
    });

    expect(result.blockedCount).toBe(1);
    expect(result.results.find((r) => r.sku === "SKU-NEG")?.status).toBe("blocked_negative");
    expect(result.results.find((r) => r.sku === "SKU-LOCKED")?.status).toBe(
      "skipped_count_in_progress",
    );
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("flags unknown SKUs and SKUs from other orgs without writing", async () => {
    levelsResponse = {
      data: [levelRow("SKU-OTHER", 5, { orgId: "other-org" })],
      error: null,
    };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [
        { sku: "SKU-MISSING", newAvailable: 1 },
        { sku: "SKU-OTHER", newAvailable: 1 },
      ],
    });

    expect(result.unknownCount).toBe(2);
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("treats no-delta entries as no_change and skips the write path", async () => {
    levelsResponse = { data: [levelRow("SKU-A", 7)], error: null };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [{ sku: "SKU-A", newAvailable: 7 }],
    });

    expect(result.noChangeCount).toBe(1);
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("records error rows when recordInventoryChange returns success:false", async () => {
    levelsResponse = { data: [levelRow("SKU-A", 5)], error: null };
    mockRecordInventoryChange.mockResolvedValue({
      success: false,
      newQuantity: null,
      alreadyProcessed: false,
    });

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [{ sku: "SKU-A", newAvailable: 6 }],
    });

    expect(result.errorCount).toBe(1);
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].reason).toBe("record_inventory_change_failed");
  });

  it("records error rows when recordInventoryChange throws", async () => {
    levelsResponse = { data: [levelRow("SKU-A", 5)], error: null };
    mockRecordInventoryChange.mockRejectedValue(new Error("postgres down"));

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [{ sku: "SKU-A", newAvailable: 6 }],
    });

    expect(result.errorCount).toBe(1);
    expect(result.results[0].reason).toBe("exception");
  });

  it("processes a mixed batch and tallies the summary correctly", async () => {
    levelsResponse = {
      data: [
        levelRow("SKU-OK", 4),
        levelRow("SKU-NOOP", 9),
        levelRow("SKU-NEG", 5),
        levelRow("SKU-CONFIRM", 1),
        levelRow("SKU-OTHER", 1, { orgId: "other-org" }),
      ],
      error: null,
    };

    const result = await runTask({
      workspaceId: WS_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      batchId: BATCH_ID,
      entries: [
        { sku: "SKU-OK", newAvailable: 6 },
        { sku: "SKU-NOOP", newAvailable: 9 },
        { sku: "SKU-NEG", newAvailable: -2 },
        { sku: "SKU-CONFIRM", newAvailable: 50 },
        { sku: "SKU-OTHER", newAvailable: 2 },
        { sku: "SKU-MISSING", newAvailable: 7 },
      ],
    });

    expect(result.appliedCount).toBe(1);
    expect(result.noChangeCount).toBe(1);
    expect(result.blockedCount).toBe(1);
    expect(result.requiresConfirmCount).toBe(1);
    expect(result.unknownCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
  });
});
