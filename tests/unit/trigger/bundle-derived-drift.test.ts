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
}));

vi.mock("@/lib/server/auth-context", () => ({
  getAllWorkspaceIds: vi.fn(async () => ["ws-1"]),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({}),
}));

import { runBundleDerivedDriftSensor } from "@/trigger/tasks/bundle-derived-drift";

interface ChainResult {
  data: unknown;
  error?: unknown;
}

function chain(result: ChainResult) {
  const obj: Record<string, unknown> = {
    select: () => chain(result),
    eq: () => chain(result),
    in: () => chain(result),
    update: () => chain({ data: null }),
    insert: () => Promise.resolve({ error: null }),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    // biome-ignore lint/suspicious/noThenProperty: PostgREST chain mimics PromiseLike.
    then: (resolve: (v: ChainResult) => unknown) => resolve(result),
  };
  return obj;
}

interface TableResults {
  bundle_components?: ChainResult;
  warehouse_product_variants?: ChainResult;
  warehouse_inventory_levels?: ChainResult;
  warehouse_review_queue?: ChainResult;
}

function makeSupabase(results: TableResults) {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const updates: Array<{ table: string; row: unknown }> = [];
  const channelLogs: unknown[] = [];

  return {
    _inserts: inserts,
    _updates: updates,
    _channelLogs: channelLogs,
    from: vi.fn((table: string) => {
      switch (table) {
        case "bundle_components":
          return chain(results.bundle_components ?? { data: [] });
        case "warehouse_product_variants":
          return chain(results.warehouse_product_variants ?? { data: [] });
        case "warehouse_inventory_levels":
          return chain(results.warehouse_inventory_levels ?? { data: [] });
        case "warehouse_review_queue":
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve(results.warehouse_review_queue ?? { data: null }),
                }),
              }),
            }),
            insert: (row: unknown) => {
              inserts.push({ table, row });
              return Promise.resolve({ error: null });
            },
            update: (row: unknown) => {
              updates.push({ table, row });
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        case "channel_sync_log":
          return {
            insert: (row: unknown) => {
              channelLogs.push(row);
              return Promise.resolve({ error: null });
            },
          };
        default:
          return chain({ data: [] });
      }
    }),
  };
}

const ctx = { run: { id: "run_drift_test" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bundle-derived-drift sensor (Phase 2.5(c))", () => {
  it("returns 'no_bundles' note and writes channel_sync_log when workspace has no bundles", async () => {
    const supabase = makeSupabase({ bundle_components: { data: [] } });

    const result = await runBundleDerivedDriftSensor({ workspaceIds: ["ws-1"] }, ctx, {
      supabase: supabase as never,
      inventoryFetcher: vi.fn(async () => []) as never,
    });

    expect(result.workspaces[0].notes).toBe("no_bundles");
    expect(result.workspaces[0].bundlesEvaluated).toBe(0);
    expect(supabase._channelLogs).toHaveLength(1);
  });

  it("flags drift > tolerance and inserts a review-queue row keyed on group_key", async () => {
    const supabase = makeSupabase({
      bundle_components: {
        data: [
          { bundle_variant_id: "bundle-v", component_variant_id: "comp-a", quantity: 1 },
          { bundle_variant_id: "bundle-v", component_variant_id: "comp-b", quantity: 2 },
        ],
      },
      warehouse_product_variants: { data: [{ id: "bundle-v", sku: "BUNDLE-001" }] },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "bundle-v", available: 100 },
          { variant_id: "comp-a", available: 5 },
          { variant_id: "comp-b", available: 10 },
        ],
      },
      warehouse_review_queue: { data: null },
    });

    const inventoryFetcher = vi.fn(async () => [
      {
        sku: "BUNDLE-001",
        on_hand: 0,
        allocated: 0,
        available: 50,
        inventory_warehouse_id: "wh-1",
        inventory_location_id: "loc-1",
        last_updated_at: "now",
      },
    ]);

    const result = await runBundleDerivedDriftSensor({ workspaceIds: ["ws-1"] }, ctx, {
      supabase: supabase as never,
      inventoryFetcher: inventoryFetcher as never,
    });

    // derived = MIN(100 bundle stock, MIN(comp-a/1=5, comp-b/2=5)) = 5
    // v2.available = 50 → drift = 45 → above tolerance (2)
    const ws = result.workspaces[0];
    expect(ws.bundlesEvaluated).toBe(1);
    expect(ws.v2RowsFound).toBe(1);
    expect(ws.driftDetected).toBe(1);
    expect(ws.drifts[0]).toMatchObject({
      sku: "BUNDLE-001",
      derived: 5,
      v2_available: 50,
      drift: 45,
    });
    expect(ws.reviewItemsUpserted).toBe(1);
    const insert = supabase._inserts[0]?.row as { group_key: string; metadata: { sku: string } };
    expect(insert.group_key).toBe("bundle.derived_drift:ws-1:BUNDLE-001");
    expect(insert.metadata.sku).toBe("BUNDLE-001");
  });

  it("ignores drift within tolerance (race-window noise)", async () => {
    const supabase = makeSupabase({
      bundle_components: {
        data: [{ bundle_variant_id: "b", component_variant_id: "c", quantity: 1 }],
      },
      warehouse_product_variants: { data: [{ id: "b", sku: "BUNDLE-NOISE" }] },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "b", available: 9 },
          { variant_id: "c", available: 9 },
        ],
      },
    });

    const inventoryFetcher = vi.fn(async () => [
      {
        sku: "BUNDLE-NOISE",
        on_hand: 0,
        allocated: 0,
        available: 11, // |11-9|=2 == tolerance, NOT a drift
        inventory_warehouse_id: "wh-1",
        inventory_location_id: "loc-1",
        last_updated_at: "now",
      },
    ]);

    const result = await runBundleDerivedDriftSensor({ workspaceIds: ["ws-1"] }, ctx, {
      supabase: supabase as never,
      inventoryFetcher: inventoryFetcher as never,
    });
    expect(result.workspaces[0].driftDetected).toBe(0);
    expect(supabase._inserts).toHaveLength(0);
  });

  it("skips bundle SKUs that v2 does NOT return (Phase 2.5(a) exclusion case)", async () => {
    const supabase = makeSupabase({
      bundle_components: {
        data: [{ bundle_variant_id: "b", component_variant_id: "c", quantity: 1 }],
      },
      warehouse_product_variants: { data: [{ id: "b", sku: "BUNDLE-NOT-IN-V2" }] },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "b", available: 0 },
          { variant_id: "c", available: 100 },
        ],
      },
    });

    // v2 returns no rows for our SKU — this is the (a) exclusion case
    const inventoryFetcher = vi.fn(async () => []);

    const result = await runBundleDerivedDriftSensor({ workspaceIds: ["ws-1"] }, ctx, {
      supabase: supabase as never,
      inventoryFetcher: inventoryFetcher as never,
    });
    expect(result.workspaces[0].v2RowsFound).toBe(0);
    expect(result.workspaces[0].driftDetected).toBe(0);
  });

  it("bumps occurrence_count on an existing open review row instead of inserting a duplicate", async () => {
    const supabase = makeSupabase({
      bundle_components: {
        data: [{ bundle_variant_id: "b", component_variant_id: "c", quantity: 1 }],
      },
      warehouse_product_variants: { data: [{ id: "b", sku: "BUNDLE-EXIST" }] },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "b", available: 0 },
          { variant_id: "c", available: 0 },
        ],
      },
      warehouse_review_queue: { data: { id: "rq-1", occurrence_count: 4 } },
    });

    const inventoryFetcher = vi.fn(async () => [
      {
        sku: "BUNDLE-EXIST",
        on_hand: 0,
        allocated: 0,
        available: 99, // huge drift
        inventory_warehouse_id: "wh-1",
        inventory_location_id: "loc-1",
        last_updated_at: "now",
      },
    ]);

    const result = await runBundleDerivedDriftSensor({ workspaceIds: ["ws-1"] }, ctx, {
      supabase: supabase as never,
      inventoryFetcher: inventoryFetcher as never,
    });
    expect(result.workspaces[0].driftDetected).toBe(1);
    expect(result.workspaces[0].reviewItemsUpserted).toBe(0);
    expect(supabase._inserts).toHaveLength(0);
    expect(supabase._updates).toHaveLength(1);
    const upd = supabase._updates[0]?.row as { occurrence_count: number };
    expect(upd.occurrence_count).toBe(5);
  });
});
