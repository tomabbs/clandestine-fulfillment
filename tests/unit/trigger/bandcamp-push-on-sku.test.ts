import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockUpdate, mockRefresh, mockBegin, mockSuccess, mockError, mockLoadGuard } = vi.hoisted(
  () => ({
    mockUpdate: vi.fn(),
    mockRefresh: vi.fn(),
    mockBegin: vi.fn(),
    mockSuccess: vi.fn(),
    mockError: vi.fn(),
    mockLoadGuard: vi.fn(),
  }),
);

vi.mock("@/lib/clients/bandcamp", () => ({
  updateQuantities: mockUpdate,
  refreshBandcampToken: mockRefresh,
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

vi.mock("@/trigger/lib/bandcamp-queue", () => ({
  bandcampQueue: { name: "bandcamp-api" },
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
  bandcamp_product_mappings?: ChainResult;
  warehouse_inventory_levels?: ChainResult;
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
        case "bandcamp_product_mappings":
          return chain(__currentResults.bandcamp_product_mappings ?? { data: null });
        case "warehouse_inventory_levels":
          return chain(__currentResults.warehouse_inventory_levels ?? { data: null });
        default:
          return chain({ data: null });
      }
    },
  }),
}));

import { bandcampPushOnSkuTask } from "@/trigger/tasks/bandcamp-push-on-sku";

const runTask = (
  bandcampPushOnSkuTask as unknown as {
    run: (
      payload: import("@/trigger/tasks/bandcamp-push-on-sku").BandcampPushOnSkuPayload,
    ) => Promise<import("@/trigger/tasks/bandcamp-push-on-sku").BandcampPushOnSkuResult>;
  }
).run;

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const VARIANT_ID = "22222222-2222-2222-2222-222222222222";
const ORG_ID = "33333333-3333-3333-3333-333333333333";
const SKU = "TEST-SKU-001";
const CORR = "ship:9001:TEST-SKU-001";

function basePayload() {
  return {
    workspaceId: WORKSPACE_ID,
    sku: SKU,
    correlationId: CORR,
    reason: "shipstation_ship_notify",
    metadata: { shipment_id: "9001" },
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

const variantWithOrg = (orgId: string | null) => ({
  data: { id: VARIANT_ID, sku: SKU, warehouse_products: { org_id: orgId } },
});

const fulfillmentMapping = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: "mapping_1",
    bandcamp_item_id: 12345,
    bandcamp_item_type: "package",
    push_mode: "normal",
    last_quantity_sold: 2,
    bandcamp_origin_quantities: null,
    ...overrides,
  },
});

describe("bandcampPushOnSkuTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResults({});
    mockBegin.mockResolvedValue({ acquired: true, id: "ledger_bc_1" });
    mockSuccess.mockResolvedValue(undefined);
    mockError.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockRefresh.mockResolvedValue("token_abc");
    mockLoadGuard.mockResolvedValue(makeGuard(true));
  });

  it("skips when fanout-guard blocks (rollout_excluded)", async () => {
    mockLoadGuard.mockResolvedValueOnce(makeGuard(false, "rollout_excluded"));
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_guard");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips when variant cannot be resolved by sku", async () => {
    setResults({ warehouse_product_variants: { data: null } });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_unknown_variant");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips distro variants (org_id IS NULL)", async () => {
    setResults({ warehouse_product_variants: variantWithOrg(null) });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_distro");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips bundle parents", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: { bundle_variant_id: VARIANT_ID } },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_bundle_parent");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips when no Bandcamp mapping exists", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: { data: null },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_no_mapping");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips when push_mode is blocked_baseline", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping({ push_mode: "blocked_baseline" }),
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_push_mode");
    expect(result.status === "skipped_push_mode" && result.reason).toBe(
      "push_mode_blocked_baseline",
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips when push_mode is blocked_multi_origin", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping({ push_mode: "blocked_multi_origin" }),
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_push_mode");
  });

  it("defers option-level mappings to the cron path", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping({
        bandcamp_origin_quantities: [
          {
            origin_id: 999,
            option_quantities: [{ option_id: 1 }, { option_id: 2 }],
          },
        ],
      }),
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_option_level");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("short-circuits on duplicate ledger row", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping(),
      warehouse_inventory_levels: { data: { available: 10, safety_stock: null } },
      workspaces: { data: { default_safety_stock: 3 } },
    });
    mockBegin.mockResolvedValueOnce({
      acquired: false,
      reason: "already_succeeded",
      existing_id: "ledger_bc_existing",
      existing_status: "success",
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_ledger_duplicate");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("pushes available - safety on success path (workspace default safety = 3)", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping(),
      warehouse_inventory_levels: { data: { available: 10, safety_stock: null } },
      workspaces: { data: { default_safety_stock: 3 } },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.pushed_quantity).toBe(7);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [items, token] = mockUpdate.mock.calls[0] as [
      Array<{ item_id: number; item_type: string; quantity_available: number }>,
      string,
    ];
    expect(token).toBe("token_abc");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_id: 12345,
      item_type: "package",
      quantity_available: 7,
    });
    expect(mockSuccess).toHaveBeenCalledTimes(1);
  });

  it("clamps pushed_quantity at 0 when safety > available", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping(),
      warehouse_inventory_levels: { data: { available: 1, safety_stock: 5 } },
      workspaces: { data: { default_safety_stock: 3 } },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.pushed_quantity).toBe(0);
  });

  it("respects per-sku safety_stock override over workspace default", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping(),
      warehouse_inventory_levels: { data: { available: 20, safety_stock: 8 } },
      workspaces: { data: { default_safety_stock: 3 } },
    });
    const result = await runTask(basePayload());
    expect(result.status === "ok" && result.pushed_quantity).toBe(12);
  });

  it("marks ledger error and rethrows when updateQuantities fails", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping(),
      warehouse_inventory_levels: { data: { available: 10, safety_stock: null } },
      workspaces: { data: { default_safety_stock: 3 } },
    });
    mockUpdate.mockRejectedValueOnce(new Error("Bandcamp 401 unauthorized"));
    await expect(runTask(basePayload())).rejects.toThrow(/unauthorized/);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("manual_override push_mode is allowed through (operator opt-in)", async () => {
    setResults({
      warehouse_product_variants: variantWithOrg(ORG_ID),
      bundle_components: { data: null },
      bandcamp_product_mappings: fulfillmentMapping({ push_mode: "manual_override" }),
      warehouse_inventory_levels: { data: { available: 5, safety_stock: null } },
      workspaces: { data: { default_safety_stock: 3 } },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.pushed_quantity).toBe(2);
  });
});
