import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockAdjust, mockBegin, mockSuccess, mockError, mockLoadGuard } = vi.hoisted(() => ({
  mockAdjust: vi.fn(),
  mockBegin: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
  mockLoadGuard: vi.fn(),
}));

vi.mock("@/lib/clients/shipstation-inventory-v2", () => ({
  adjustInventoryV2: mockAdjust,
}));

vi.mock("@/lib/server/external-sync-events", () => ({
  beginExternalSync: mockBegin,
  markExternalSyncSuccess: mockSuccess,
  markExternalSyncError: mockError,
}));

vi.mock("@/lib/server/fanout-guard", () => ({
  loadFanoutGuard: mockLoadGuard,
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: unknown) => def,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: { name: "shipstation" },
}));

// ── Supabase chain stub ──────────────────────────────────────────────────────

interface ChainResult {
  data: unknown;
  error?: unknown;
}

function chain(result: ChainResult) {
  const obj: Record<string, unknown> = {
    select: () => chain(result),
    eq: () => chain(result),
    limit: () => chain(result),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    // biome-ignore lint/suspicious/noThenProperty: PostgREST chain mimics PromiseLike on purpose.
    then: (resolve: (v: ChainResult) => unknown) => resolve(result),
  };
  return obj;
}

interface TableResults {
  workspaces?: ChainResult;
  warehouse_product_variants?: ChainResult;
  bundle_components?: ChainResult;
}

let __currentResults: TableResults = {};

function setResults(r: TableResults) {
  __currentResults = r;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      switch (table) {
        case "workspaces":
          return chain(__currentResults.workspaces ?? { data: null });
        case "warehouse_product_variants":
          return chain(__currentResults.warehouse_product_variants ?? { data: null });
        case "bundle_components":
          return chain(__currentResults.bundle_components ?? { data: null });
        default:
          return chain({ data: null });
      }
    },
  }),
}));

import { shipstationV2DecrementTask } from "@/trigger/tasks/shipstation-v2-decrement";

const runTask = (
  shipstationV2DecrementTask as unknown as {
    run: (
      payload: import("@/trigger/tasks/shipstation-v2-decrement").ShipstationV2DecrementPayload,
    ) => Promise<import("@/trigger/tasks/shipstation-v2-decrement").ShipstationV2DecrementResult>;
  }
).run;

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const VARIANT_ID = "22222222-2222-2222-2222-222222222222";
const SKU = "TEST-SKU-001";
const CORR = "sale:bandX:42:5:TEST-SKU-001";

function basePayload() {
  return {
    workspaceId: WORKSPACE_ID,
    sku: SKU,
    quantity: 1,
    correlationId: CORR,
    reason: "bandcamp_sale",
    metadata: { test: true },
  };
}

function makeGuard(allow: boolean, reason?: string) {
  return {
    row: {
      shipstation_sync_paused: false,
      bandcamp_sync_paused: false,
      clandestine_shopify_sync_paused: false,
      client_store_sync_paused: false,
      inventory_sync_paused: false,
      fanout_rollout_percent: 100,
    },
    shouldFanout: () => allow,
    evaluate: () =>
      allow ? { allow: true } : { allow: false, reason: reason ?? "rollout_excluded" },
  };
}

describe("shipstationV2DecrementTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResults({});
    mockBegin.mockResolvedValue({ acquired: true, id: "ledger_v2_1" });
    mockSuccess.mockResolvedValue(undefined);
    mockError.mockResolvedValue(undefined);
    mockAdjust.mockResolvedValue({ ok: true });
    mockLoadGuard.mockResolvedValue(makeGuard(true));
  });

  it("rejects non-positive quantity at the entry boundary", async () => {
    await expect(runTask({ ...basePayload(), quantity: 0 })).rejects.toThrow(/invalid quantity/);
    await expect(runTask({ ...basePayload(), quantity: -3 })).rejects.toThrow(/invalid quantity/);
  });

  it("skips when fanout-guard blocks (rollout_excluded)", async () => {
    mockLoadGuard.mockResolvedValueOnce(makeGuard(false, "rollout_excluded"));
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_guard");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("skips when fanout-guard blocks (integration_paused via shipstation kill switch)", async () => {
    mockLoadGuard.mockResolvedValueOnce(makeGuard(false, "integration_paused"));
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_guard");
    expect(result.status === "skipped_guard" && result.reason).toBe("integration_paused");
  });

  it("skips when workspace has no v2 defaults configured", async () => {
    setResults({
      workspaces: {
        data: {
          shipstation_v2_inventory_warehouse_id: null,
          shipstation_v2_inventory_location_id: null,
        },
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_no_v2_defaults");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("skips when variant cannot be resolved by sku", async () => {
    setResults({
      workspaces: {
        data: {
          shipstation_v2_inventory_warehouse_id: "se-214575",
          shipstation_v2_inventory_location_id: "se-3213662",
        },
      },
      warehouse_product_variants: { data: null },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_unknown_variant");
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("skips bundle parents (Phase 2.5(a) — bundles excluded from v2)", async () => {
    setResults({
      workspaces: {
        data: {
          shipstation_v2_inventory_warehouse_id: "se-214575",
          shipstation_v2_inventory_location_id: "se-3213662",
        },
      },
      warehouse_product_variants: { data: { id: VARIANT_ID } },
      bundle_components: { data: { bundle_variant_id: VARIANT_ID } },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_bundle_parent");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("short-circuits on duplicate ledger row (already_succeeded)", async () => {
    setResults({
      workspaces: {
        data: {
          shipstation_v2_inventory_warehouse_id: "se-214575",
          shipstation_v2_inventory_location_id: "se-3213662",
        },
      },
      warehouse_product_variants: { data: { id: VARIANT_ID } },
      bundle_components: { data: null },
    });
    mockBegin.mockResolvedValueOnce({
      acquired: false,
      reason: "already_succeeded",
      existing_id: "ledger_v2_existing",
      existing_status: "success",
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_ledger_duplicate");
    expect(mockAdjust).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("decrements via adjustInventoryV2 with transaction_type=decrement on the success path", async () => {
    setResults({
      workspaces: {
        data: {
          shipstation_v2_inventory_warehouse_id: "se-214575",
          shipstation_v2_inventory_location_id: "se-3213662",
        },
      },
      warehouse_product_variants: { data: { id: VARIANT_ID } },
      bundle_components: { data: null },
    });
    const result = await runTask({ ...basePayload(), quantity: 3 });
    expect(result.status).toBe("ok");
    expect(mockAdjust).toHaveBeenCalledTimes(1);
    const call = mockAdjust.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      sku: SKU,
      inventory_warehouse_id: "se-214575",
      inventory_location_id: "se-3213662",
      transaction_type: "decrement",
      quantity: 3,
      reason: "bandcamp_sale",
    });
    // Phase 0 Patch D2 guarantee — never `modify` to zero a SKU
    expect((call as { transaction_type: string }).transaction_type).not.toBe("modify");
    expect(mockSuccess).toHaveBeenCalledTimes(1);
    expect(mockError).not.toHaveBeenCalled();
  });

  it("marks ledger error and rethrows when adjustInventoryV2 fails", async () => {
    setResults({
      workspaces: {
        data: {
          shipstation_v2_inventory_warehouse_id: "se-214575",
          shipstation_v2_inventory_location_id: "se-3213662",
        },
      },
      warehouse_product_variants: { data: { id: VARIANT_ID } },
      bundle_components: { data: null },
    });
    mockAdjust.mockRejectedValueOnce(new Error("ShipStation v2 429 throttled"));
    await expect(runTask(basePayload())).rejects.toThrow(/throttled/);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockSuccess).not.toHaveBeenCalled();
  });
});
