/**
 * Phase 5 — `shipstation-bandcamp-reconcile-{hot,warm,cold}` test suite.
 *
 * The reconcile task is purposely deterministic at the inner-runner layer
 * (`runShipstationBandcampReconcile`). All Trigger.dev wrappers are mocked
 * away so each test exercises the real selection / drift / auto-fix /
 * review-queue logic against an in-memory Supabase chain mock and
 * an injectable `inventoryFetcher` + `recordInventoryChange` stub.
 *
 * Coverage map (one assertion family per `it`):
 *   1. Workspace without v2 defaults → entire workspace skipped.
 *   2. Bundle parent SKUs are excluded from the candidate set (cold tier).
 *   3. Hot-tier candidate selection unions "low stock" + "recently sold".
 *   4. Warm-tier candidate selection uses 30-day activity window only.
 *   5. SKU at 0 in our DB + missing v2 row → treated as equal (no drift).
 *   6. Silent fix path: |drift| ≤ 1 → auto-fix written, NO review item.
 *   7. Low-severity review path: 2 ≤ |drift| ≤ 5 → auto-fix + low review.
 *   8. High-severity review path: |drift| > 5 → auto-fix + high review.
 *   9. Re-detection on an open group_key bumps occurrence_count, not insert.
 *  10. listInventory is called with the workspace's v2 warehouse + location ids.
 *  11. recordInventoryChange uses correlationId `reconcile:{tier}:{run}:{sku}`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: (...args: unknown[]) => unknown }) => def,
  schedules: { task: (def: { run: (...args: unknown[]) => unknown }) => def },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: { name: "shipstation" },
}));

vi.mock("@/lib/clients/shipstation-inventory-v2", () => ({
  listInventory: vi.fn(),
  V2_INVENTORY_LIST_BATCH_LIMIT: 50,
}));

vi.mock("@/lib/server/auth-context", () => ({
  getAllWorkspaceIds: vi.fn(async () => ["ws-1"]),
}));

vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: vi.fn(async () => ({
    success: true,
    newQuantity: 0,
    alreadyProcessed: false,
  })),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({}),
}));

import {
  HIGH_SEVERITY_DRIFT_THRESHOLD,
  HOT_LOW_STOCK_THRESHOLD,
  type ReconcileDeps,
  type ReconcilePayload,
  type ReconcileTier,
  runShipstationBandcampReconcile,
  SILENT_DRIFT_TOLERANCE,
} from "@/trigger/tasks/shipstation-bandcamp-reconcile";

// ─── Supabase chain mock ─────────────────────────────────────────────────────

interface ChainResult {
  data?: unknown;
  error?: unknown;
}

interface QueryShape {
  filters: Record<string, unknown>;
}

function thenable(result: ChainResult) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: PostgREST chain mimics PromiseLike.
    then: (resolve: (v: ChainResult) => unknown) => resolve(result),
  };
}

interface TableHandlers {
  workspaces?: ChainResult;
  bundle_components?: ChainResult;
  warehouse_inventory_levels_cold?: ChainResult; // ws-scoped, full corpus
  warehouse_inventory_levels_lookup?: ChainResult; // .in(sku, [...])
  warehouse_inventory_levels_lowstock?: ChainResult; // hot tier low stock
  warehouse_inventory_activity?: ChainResult; // hot/warm tier sold-since
  warehouse_review_queue_existing?: ChainResult;
  channel_sync_log?: ChainResult;
}

function makeSupabase(handlers: TableHandlers) {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const updates: Array<{ table: string; row: unknown; id?: string }> = [];

  const inventoryLevelsBuilder = () => {
    const captured: QueryShape = { filters: {} };
    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        captured.filters[col] = val;
        return builder;
      },
      lte: (col: string, val: unknown) => {
        captured.filters[`${col}__lte`] = val;
        return builder;
      },
      lt: (_col: string, _val: unknown) => builder,
      gte: (_col: string, _val: unknown) => builder,
      in: (_col: string, _arr: unknown) => {
        // Levels lookup by SKU list — return the lookup result.
        return thenable(handlers.warehouse_inventory_levels_lookup ?? { data: [] });
      },
      // biome-ignore lint/suspicious/noThenProperty: resolve as the chain terminator.
      then: (resolve: (v: ChainResult) => unknown) => {
        if (captured.filters.available__lte !== undefined) {
          return resolve(handlers.warehouse_inventory_levels_lowstock ?? { data: [] });
        }
        return resolve(handlers.warehouse_inventory_levels_cold ?? { data: [] });
      },
    };
    return builder;
  };

  const activityBuilder = () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      lt: () => builder,
      gte: () => builder,
      // biome-ignore lint/suspicious/noThenProperty: resolve as the chain terminator.
      then: (resolve: (v: ChainResult) => unknown) =>
        resolve(handlers.warehouse_inventory_activity ?? { data: [] }),
    };
    return builder;
  };

  const workspacesBuilder = () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      single: () => Promise.resolve(handlers.workspaces ?? { data: null }),
    };
    return builder;
  };

  const bundleComponentsBuilder = () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      // biome-ignore lint/suspicious/noThenProperty: resolve as the chain terminator.
      then: (resolve: (v: ChainResult) => unknown) =>
        resolve(handlers.bundle_components ?? { data: [] }),
    };
    return builder;
  };

  const reviewQueueBuilder = () => {
    const lastInsertedId = "review-q-id-fresh";
    const builder = {
      select: (_cols?: string) => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve(handlers.warehouse_review_queue_existing ?? { data: null }),
          }),
        }),
      }),
      insert: (row: unknown) => {
        inserts.push({ table: "warehouse_review_queue", row });
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: lastInsertedId } }),
          }),
        };
      },
      update: (row: unknown) => {
        updates.push({ table: "warehouse_review_queue", row });
        return {
          eq: () => Promise.resolve({ error: null }),
        };
      },
    };
    return builder;
  };

  const channelLogBuilder = () => ({
    insert: (row: unknown) => {
      inserts.push({ table: "channel_sync_log", row });
      return Promise.resolve({ error: null });
    },
  });

  return {
    _inserts: inserts,
    _updates: updates,
    from: vi.fn((table: string) => {
      switch (table) {
        case "workspaces":
          return workspacesBuilder();
        case "bundle_components":
          return bundleComponentsBuilder();
        case "warehouse_inventory_levels":
          return inventoryLevelsBuilder();
        case "warehouse_inventory_activity":
          return activityBuilder();
        case "warehouse_review_queue":
          return reviewQueueBuilder();
        case "channel_sync_log":
          return channelLogBuilder();
        default:
          return inventoryLevelsBuilder();
      }
    }),
  };
}

// ─── Shared test fixtures ────────────────────────────────────────────────────

const WS_DEFAULTS = {
  data: {
    shipstation_v2_inventory_warehouse_id: "wh-7",
    shipstation_v2_inventory_location_id: "loc-3",
  },
};

function buildDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    supabase: overrides.supabase ?? (makeSupabase({}) as never),
    inventoryFetcher: overrides.inventoryFetcher ?? vi.fn(async () => []),
    getWorkspaceIds: overrides.getWorkspaceIds ?? (async () => ["ws-1"]),
    recordInventoryChange:
      overrides.recordInventoryChange ??
      vi.fn(async () => ({ success: true, newQuantity: 0, alreadyProcessed: false })),
  };
}

const ctx = { run: { id: "run-xyz" } };

async function runTier(tier: ReconcileTier, deps: ReconcileDeps, payload: ReconcilePayload = {}) {
  return runShipstationBandcampReconcile(tier, payload, ctx, deps);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runShipstationBandcampReconcile", () => {
  it("skips workspaces missing v2 defaults", async () => {
    const supabase = makeSupabase({
      workspaces: {
        data: {
          shipstation_v2_inventory_warehouse_id: null,
          shipstation_v2_inventory_location_id: null,
        },
      },
    });
    const inventoryFetcher = vi.fn(async () => []);
    const recordInventoryChange = vi.fn();

    const result = await runTier(
      "cold",
      buildDeps({ supabase: supabase as never, inventoryFetcher, recordInventoryChange }),
    );

    expect(result.workspaces[0].notes).toBe("skipped_no_v2_defaults");
    expect(result.workspaces[0].candidatesEvaluated).toBe(0);
    expect(inventoryFetcher).not.toHaveBeenCalled();
    expect(recordInventoryChange).not.toHaveBeenCalled();
  });

  it("excludes bundle parent SKUs from cold-tier candidates", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      bundle_components: { data: [{ bundle_variant_id: "var-bundle" }] },
      warehouse_inventory_levels_cold: {
        data: [
          { sku: "BUNDLE-1", variant_id: "var-bundle" },
          { sku: "REG-1", variant_id: "var-1" },
        ],
      },
      warehouse_inventory_levels_lookup: {
        data: [{ sku: "REG-1", variant_id: "var-1", available: 5 }],
      },
    });
    const inventoryFetcher = vi.fn(async () => []);
    const recordInventoryChange = vi.fn();

    const result = await runTier(
      "cold",
      buildDeps({
        supabase: supabase as never,
        inventoryFetcher,
        recordInventoryChange,
      }),
    );

    expect(inventoryFetcher).toHaveBeenCalledTimes(1);
    expect(inventoryFetcher).toHaveBeenCalledWith({
      skus: ["REG-1"],
      inventory_warehouse_id: "wh-7",
      inventory_location_id: "loc-3",
    });
    expect(result.workspaces[0].candidatesEvaluated).toBe(1);
  });

  it("hot tier unions low-stock SKUs with recently-sold SKUs", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_levels_lowstock: {
        data: [
          { sku: "LOW-1", variant_id: "var-1", available: HOT_LOW_STOCK_THRESHOLD - 2 },
          { sku: "LOW-2", variant_id: "var-2", available: 0 },
        ],
      },
      warehouse_inventory_activity: {
        data: [{ sku: "SOLD-1" }, { sku: "LOW-1" } /* dedupe */],
      },
      warehouse_inventory_levels_lookup: {
        data: [
          { sku: "LOW-1", variant_id: "var-1", available: 8 },
          { sku: "LOW-2", variant_id: "var-2", available: 0 },
          { sku: "SOLD-1", variant_id: "var-3", available: 4 },
        ],
      },
    });
    const inventoryFetcher = vi.fn(async () => []);
    await runTier("hot", buildDeps({ supabase: supabase as never, inventoryFetcher }));

    expect(inventoryFetcher).toHaveBeenCalledTimes(1);
    const calls = inventoryFetcher.mock.calls as Array<Array<{ skus: string[] }>>;
    const firstCall = calls[0]?.[0] ?? { skus: [] };
    expect(new Set(firstCall.skus)).toEqual(new Set(["LOW-1", "LOW-2", "SOLD-1"]));
  });

  it("warm tier uses 30-day activity window only", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_activity: {
        data: [{ sku: "SOLD-30D-A" }, { sku: "SOLD-30D-B" }],
      },
      warehouse_inventory_levels_lookup: {
        data: [
          { sku: "SOLD-30D-A", variant_id: "var-a", available: 1 },
          { sku: "SOLD-30D-B", variant_id: "var-b", available: 1 },
        ],
      },
    });
    const inventoryFetcher = vi.fn(async () => []);
    await runTier("warm", buildDeps({ supabase: supabase as never, inventoryFetcher }));

    const calls = inventoryFetcher.mock.calls as Array<Array<{ skus: string[] }>>;
    const firstCall = calls[0]?.[0] ?? { skus: [] };
    expect(new Set(firstCall.skus)).toEqual(new Set(["SOLD-30D-A", "SOLD-30D-B"]));
  });

  it("treats SKU at 0 in our DB + missing v2 row as equal (no drift)", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_levels_cold: {
        data: [{ sku: "ZERO-A", variant_id: "var-z" }],
      },
      warehouse_inventory_levels_lookup: {
        data: [{ sku: "ZERO-A", variant_id: "var-z", available: 0 }],
      },
    });
    const inventoryFetcher = vi.fn(async () => []); // v2 returns no row
    const recordInventoryChange = vi.fn();

    const result = await runTier(
      "cold",
      buildDeps({ supabase: supabase as never, inventoryFetcher, recordInventoryChange }),
    );

    expect(result.workspaces[0].driftDetected).toBe(0);
    expect(recordInventoryChange).not.toHaveBeenCalled();
  });

  it("silent fix when |drift| <= SILENT_DRIFT_TOLERANCE — no review item", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_levels_cold: {
        data: [{ sku: "DRIFT-1", variant_id: "var-d" }],
      },
      warehouse_inventory_levels_lookup: {
        data: [{ sku: "DRIFT-1", variant_id: "var-d", available: 10 }],
      },
    });
    const inventoryFetcher = vi.fn(async () => [
      { sku: "DRIFT-1", available: 10 + SILENT_DRIFT_TOLERANCE } as never,
    ]);
    const recordInventoryChange = vi.fn(async () => ({
      success: true,
      newQuantity: 11,
      alreadyProcessed: false,
    }));

    const result = await runTier(
      "cold",
      buildDeps({ supabase: supabase as never, inventoryFetcher, recordInventoryChange }),
    );

    expect(result.workspaces[0].silentFixes).toBe(1);
    expect(result.workspaces[0].lowReviewItemsUpserted).toBe(0);
    expect(result.workspaces[0].highReviewItemsUpserted).toBe(0);
    expect(recordInventoryChange).toHaveBeenCalledTimes(1);
    const reviewInsert = supabase._inserts.find((i) => i.table === "warehouse_review_queue");
    expect(reviewInsert).toBeUndefined();
  });

  it("low-severity review when 2 <= |drift| <= 5", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_levels_cold: {
        data: [{ sku: "DRIFT-3", variant_id: "var-d" }],
      },
      warehouse_inventory_levels_lookup: {
        data: [{ sku: "DRIFT-3", variant_id: "var-d", available: 10 }],
      },
    });
    const inventoryFetcher = vi.fn(async () => [{ sku: "DRIFT-3", available: 7 } as never]); // |drift|=3
    const recordInventoryChange = vi.fn(async () => ({
      success: true,
      newQuantity: 7,
      alreadyProcessed: false,
    }));

    const result = await runTier(
      "cold",
      buildDeps({ supabase: supabase as never, inventoryFetcher, recordInventoryChange }),
    );

    expect(result.workspaces[0].lowReviewItemsUpserted).toBe(1);
    expect(result.workspaces[0].highReviewItemsUpserted).toBe(0);
    const reviewInsert = supabase._inserts.find((i) => i.table === "warehouse_review_queue");
    expect((reviewInsert?.row as { severity: string }).severity).toBe("low");
  });

  it("high-severity review when |drift| > HIGH_SEVERITY_DRIFT_THRESHOLD", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_levels_cold: {
        data: [{ sku: "DRIFT-BIG", variant_id: "var-d" }],
      },
      warehouse_inventory_levels_lookup: {
        data: [{ sku: "DRIFT-BIG", variant_id: "var-d", available: 20 }],
      },
    });
    const inventoryFetcher = vi.fn(async () => [
      { sku: "DRIFT-BIG", available: 20 - (HIGH_SEVERITY_DRIFT_THRESHOLD + 1) } as never,
    ]);
    const recordInventoryChange = vi.fn(async () => ({
      success: true,
      newQuantity: 14,
      alreadyProcessed: false,
    }));

    const result = await runTier(
      "cold",
      buildDeps({ supabase: supabase as never, inventoryFetcher, recordInventoryChange }),
    );

    expect(result.workspaces[0].highReviewItemsUpserted).toBe(1);
    expect(result.workspaces[0].lowReviewItemsUpserted).toBe(0);
    const reviewInsert = supabase._inserts.find((i) => i.table === "warehouse_review_queue");
    expect((reviewInsert?.row as { severity: string }).severity).toBe("high");
  });

  it("re-detection on an open group_key updates instead of inserting a duplicate", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_levels_cold: {
        data: [{ sku: "DRIFT-DUP", variant_id: "var-d" }],
      },
      warehouse_inventory_levels_lookup: {
        data: [{ sku: "DRIFT-DUP", variant_id: "var-d", available: 10 }],
      },
      warehouse_review_queue_existing: {
        data: { id: "existing-q-id", occurrence_count: 4, severity: "low" },
      },
    });
    const inventoryFetcher = vi.fn(async () => [{ sku: "DRIFT-DUP", available: 7 } as never]);

    await runTier("cold", buildDeps({ supabase: supabase as never, inventoryFetcher }));

    const reviewInsert = supabase._inserts.find((i) => i.table === "warehouse_review_queue");
    expect(reviewInsert).toBeUndefined();
    const reviewUpdate = supabase._updates.find((u) => u.table === "warehouse_review_queue");
    expect((reviewUpdate?.row as { occurrence_count: number }).occurrence_count).toBe(5);
  });

  it("recordInventoryChange uses correlationId reconcile:{tier}:{run}:{sku} and source 'reconcile'", async () => {
    const supabase = makeSupabase({
      workspaces: WS_DEFAULTS,
      warehouse_inventory_activity: { data: [{ sku: "FIX-CORR" }] },
      warehouse_inventory_levels_lookup: {
        data: [{ sku: "FIX-CORR", variant_id: "var-c", available: 10 }],
      },
    });
    const inventoryFetcher = vi.fn(async () => [{ sku: "FIX-CORR", available: 11 } as never]);
    const recordInventoryChange = vi.fn(async () => ({
      success: true,
      newQuantity: 11,
      alreadyProcessed: false,
    }));

    await runTier(
      "warm",
      buildDeps({ supabase: supabase as never, inventoryFetcher, recordInventoryChange }),
    );

    expect(recordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "FIX-CORR",
        delta: 1,
        source: "reconcile",
        correlationId: "reconcile:warm:run-xyz:FIX-CORR",
      }),
    );
  });
});
