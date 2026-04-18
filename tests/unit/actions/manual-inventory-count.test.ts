import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
}));

const mockRecordInventoryChange = vi.fn();
vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: (...args: unknown[]) => mockRecordInventoryChange(...args),
}));

const mockTasksTrigger = vi.fn();
vi.mock("@trigger.dev/sdk", () => ({
  tasks: {
    trigger: (...args: unknown[]) => mockTasksTrigger(...args),
  },
}));

// Builder for a chained Supabase response that resolves on `.in()` (used by
// the pre-fetch path) or on a thenable returned from chain end.
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

const upsertCalls: Array<{ table: string; payload: unknown; conflict: unknown }> = [];

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve(levelsResponse),
        upsert: (payload: unknown, options: unknown) => {
          upsertCalls.push({ table, payload, conflict: options });
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  }),
  createServerSupabaseClient: async () => ({}),
}));

import { submitManualInventoryCounts } from "@/actions/manual-inventory-count";

// Use a valid UUID v4 (version digit `4`, variant digit in [89abAB]).
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const VALID_SKU_A = "SKU-A";
const VALID_SKU_B = "SKU-B";
const SKU_OTHER_ORG = "SKU-OTHER-ORG";
const SKU_IN_PROGRESS = "SKU-IN-PROGRESS";
const SKU_UNKNOWN = "SKU-UNKNOWN";

function levelRow(
  sku: string,
  available: number,
  orgId: string = ORG_ID,
  countStatus: "idle" | "count_in_progress" = "idle",
): LevelRow {
  return {
    sku,
    available,
    count_status: countStatus,
    warehouse_product_variants: {
      id: `variant-${sku}`,
      warehouse_products: { org_id: orgId },
    },
  };
}

describe("submitManualInventoryCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertCalls.length = 0;
    levelsResponse = {
      data: [
        levelRow(VALID_SKU_A, 50),
        levelRow(VALID_SKU_B, 5),
        levelRow(SKU_OTHER_ORG, 10, "22222222-2222-4222-8222-222222222222"),
        levelRow(SKU_IN_PROGRESS, 15, ORG_ID, "count_in_progress"),
      ],
      error: null,
    };
    mockRecordInventoryChange.mockResolvedValue({
      success: true,
      newQuantity: 1,
      alreadyProcessed: false,
    });
    mockTasksTrigger.mockResolvedValue({ id: "run-1" });
  });

  it("applies a within-threshold change and triggers ShipStation v2 sync", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_A, newAvailable: 47 }], // delta = -3, within threshold
    });

    expect(result.appliedCount).toBe(1);
    expect(result.results[0].status).toBe("applied");
    expect(result.results[0].delta).toBe(-3);
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: VALID_SKU_A,
        delta: -3,
        source: "manual_inventory_count",
        workspaceId: "ws-1",
      }),
    );
    expect(mockTasksTrigger).toHaveBeenCalledWith(
      "shipstation-v2-adjust-on-sku",
      expect.objectContaining({ sku: VALID_SKU_A, delta: -3, workspaceId: "ws-1" }),
    );
  });

  it("requires confirmation when |delta| exceeds the threshold", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_A, newAvailable: 80 }], // delta = +30
    });

    expect(result.appliedCount).toBe(0);
    expect(result.requiresConfirmCount).toBe(1);
    expect(result.results[0].status).toBe("requires_confirm");
    expect(result.results[0].reason).toBe("high_delta");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(mockTasksTrigger).not.toHaveBeenCalled();
  });

  it("requires confirmation when current is zero and new is positive", async () => {
    levelsResponse = { data: [levelRow(VALID_SKU_A, 0)], error: null };
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_A, newAvailable: 5 }],
    });
    expect(result.results[0].status).toBe("requires_confirm");
    expect(result.results[0].reason).toBe("rising_from_zero");
  });

  it("requires confirmation when crossing down to zero", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_B, newAvailable: 0 }], // current 5 → 0
    });
    expect(result.results[0].status).toBe("requires_confirm");
    expect(result.results[0].reason).toBe("falling_to_zero");
  });

  it("applies high-delta when force:true is set", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_A, newAvailable: 80, force: true }],
    });
    expect(result.appliedCount).toBe(1);
    expect(result.results[0].status).toBe("applied");
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
  });

  it("returns no_change when delta is zero", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_A, newAvailable: 50 }],
    });
    expect(result.noChangeCount).toBe(1);
    expect(result.results[0].status).toBe("no_change");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(mockTasksTrigger).not.toHaveBeenCalled();
  });

  it("flags unknown SKUs as unknown_sku and skips them", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [
        { sku: SKU_UNKNOWN, newAvailable: 10 },
        { sku: VALID_SKU_A, newAvailable: 47 },
      ],
    });
    expect(result.unknownCount).toBe(1);
    expect(result.appliedCount).toBe(1);
    const unknown = result.results.find((r) => r.sku === SKU_UNKNOWN);
    expect(unknown?.status).toBe("unknown_sku");
    expect(unknown?.reason).toBe("sku_not_in_workspace");
  });

  it("flags SKUs from other orgs as unknown_sku (defense in depth)", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: SKU_OTHER_ORG, newAvailable: 9 }],
    });
    expect(result.results[0].status).toBe("unknown_sku");
    expect(result.results[0].reason).toBe("sku_not_in_org");
  });

  it("skips SKUs with active count session", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: SKU_IN_PROGRESS, newAvailable: 12 }],
    });
    expect(result.results[0].status).toBe("skipped_count_in_progress");
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("does not crash if ShipStation v2 enqueue fails (drift sensor backstop)", async () => {
    mockTasksTrigger.mockRejectedValueOnce(new Error("trigger.dev unreachable"));
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_A, newAvailable: 47 }],
    });
    expect(result.appliedCount).toBe(1);
    expect(result.results[0].status).toBe("applied");
  });

  it("returns error status when recordInventoryChange returns success:false", async () => {
    mockRecordInventoryChange.mockResolvedValueOnce({
      success: false,
      newQuantity: null,
      alreadyProcessed: false,
    });
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [{ sku: VALID_SKU_A, newAvailable: 47 }],
    });
    expect(result.errorCount).toBe(1);
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].reason).toBe("record_inventory_change_failed");
  });

  it("rejects payloads exceeding MAX_ENTRIES_PER_BATCH via Zod", async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      sku: `SKU-${i}`,
      newAvailable: 1,
    }));
    await expect(
      submitManualInventoryCounts({ orgId: ORG_ID, entries: tooMany }),
    ).rejects.toThrow();
  });

  it("uses a stable correlationId per (user, batch, sku)", async () => {
    const result = await submitManualInventoryCounts({
      orgId: ORG_ID,
      entries: [
        { sku: VALID_SKU_A, newAvailable: 47 },
        { sku: VALID_SKU_B, newAvailable: 4 },
      ],
    });
    expect(result.appliedCount).toBe(2);
    const calls = mockRecordInventoryChange.mock.calls;
    expect(calls).toHaveLength(2);
    const corrA = calls[0][0].correlationId;
    const corrB = calls[1][0].correlationId;
    expect(corrA).toMatch(/^manual-count:user-1:[0-9a-f-]+:SKU-A$/);
    expect(corrB).toMatch(/^manual-count:user-1:[0-9a-f-]+:SKU-B$/);
    // Same batchId across both rows
    expect(corrA.split(":")[2]).toBe(corrB.split(":")[2]);
  });
});
