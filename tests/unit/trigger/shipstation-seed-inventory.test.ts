import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockAdjust, mockBegin, mockSuccess, mockError } = vi.hoisted(() => ({
  mockAdjust: vi.fn(),
  mockBegin: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("@/lib/clients/shipstation-inventory-v2", () => ({
  adjustInventoryV2: mockAdjust,
}));

vi.mock("@/lib/server/external-sync-events", () => ({
  beginExternalSync: mockBegin,
  markExternalSyncSuccess: mockSuccess,
  markExternalSyncError: mockError,
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: (...args: unknown[]) => unknown }) => def,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: { name: "shipstation" },
}));

// ── Shared Supabase chain stub ───────────────────────────────────────────────

interface ChainResult {
  data: unknown;
  error?: unknown;
}

function chain(result: ChainResult) {
  const obj: Record<string, unknown> = {
    select: () => chain(result),
    eq: () => chain(result),
    in: () => chain(result),
    order: () => chain(result),
    limit: () => chain(result),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    insert: () => Promise.resolve({ error: null }),
    update: () => chain({ data: null }),
    // Make the chain thenable so `await supabase.from(...).select(...).eq(...)`
    // resolves to { data, error } directly (the PostgREST behavior).
    // biome-ignore lint/suspicious/noThenProperty: PostgREST chain mimics PromiseLike on purpose.
    then: (resolve: (v: ChainResult) => unknown) => resolve(result),
  };
  return obj;
}

interface TableResults {
  warehouse_product_variants?: ChainResult;
  bundle_components?: ChainResult;
  bandcamp_product_mappings?: ChainResult;
  warehouse_inventory_levels?: ChainResult;
}

function makeSupabase(results: TableResults) {
  const calls: string[] = [];
  return {
    _calls: calls,
    from: vi.fn((table: string) => {
      calls.push(table);
      switch (table) {
        case "warehouse_product_variants":
          return chain(results.warehouse_product_variants ?? { data: [] });
        case "bundle_components":
          return chain(results.bundle_components ?? { data: [] });
        case "bandcamp_product_mappings":
          return chain(results.bandcamp_product_mappings ?? { data: [] });
        case "warehouse_inventory_levels":
          return chain(results.warehouse_inventory_levels ?? { data: [] });
        case "channel_sync_log":
          return {
            insert: () => Promise.resolve({ error: null }),
            update: () => chain({ data: null }),
          };
        default:
          return chain({ data: [] });
      }
    }),
  };
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => makeSupabase(__currentResults),
}));

let __currentResults: TableResults = {};

function setResults(results: TableResults) {
  __currentResults = results;
}

// Import the inner runner AFTER mocks are wired (the task() wrapper
// returns the def object so .run is callable, but TS doesn't see .run on
// the public Task<...> type — exercising the inner function is cleaner).
import { runShipstationSeedInventory } from "@/trigger/tasks/shipstation-seed-inventory";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const WAREHOUSE_ID = "se-214575";
const LOCATION_ID = "se-3213662";
const RUN_ID = "run_phase3_seed_test";

const taskCtx = { run: { id: RUN_ID } };

describe("shipstationSeedInventoryTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResults({});
    mockBegin.mockResolvedValue({ acquired: true, id: "ledger_row_1" });
    mockSuccess.mockResolvedValue(undefined);
    mockError.mockResolvedValue(undefined);
    mockAdjust.mockResolvedValue({ ok: true });
  });

  it("returns zero counts when workspace has no fulfillment variants", async () => {
    setResults({
      warehouse_product_variants: { data: [] },
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.candidates).toBe(0);
    expect(result.seeded).toBe(0);
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("excludes distro variants (org_id IS NULL)", async () => {
    setResults({
      warehouse_product_variants: {
        data: [
          { id: "v1", sku: "DISTRO-1", warehouse_products: { org_id: null } },
          { id: "v2", sku: "FULFIL-1", warehouse_products: { org_id: "org-1" } },
        ],
      },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "v2",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 5 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: {
        data: [{ variant_id: "v2", available: 5 }],
      },
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.candidates).toBe(1);
    expect(result.seeded).toBe(1);
    expect(mockAdjust).toHaveBeenCalledTimes(1);
    expect(mockAdjust).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "FULFIL-1",
        transaction_type: "increment",
        quantity: 5,
        inventory_warehouse_id: WAREHOUSE_ID,
        inventory_location_id: LOCATION_ID,
      }),
    );
  });

  it("excludes bundle parents (Phase 2.5 (a))", async () => {
    setResults({
      warehouse_product_variants: {
        data: [
          { id: "bundle-v", sku: "BUNDLE-1", warehouse_products: { org_id: "org-1" } },
          { id: "comp-v", sku: "COMP-1", warehouse_products: { org_id: "org-1" } },
        ],
      },
      bundle_components: { data: [{ bundle_variant_id: "bundle-v" }] },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "bundle-v",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 10 }] },
            ],
          },
          {
            variant_id: "comp-v",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 10 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "bundle-v", available: 10 },
          { variant_id: "comp-v", available: 10 },
        ],
      },
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.bundle_excluded).toBe(1);
    expect(result.seeded).toBe(1);
    expect(mockAdjust).toHaveBeenCalledTimes(1);
    expect(mockAdjust).toHaveBeenCalledWith(expect.objectContaining({ sku: "COMP-1" }));
  });

  it("blocks variants whose mapping is missing or push_mode != normal", async () => {
    setResults({
      warehouse_product_variants: {
        data: [
          { id: "v-blocked", sku: "BLOCKED", warehouse_products: { org_id: "org-1" } },
          { id: "v-nomap", sku: "NOMAP", warehouse_products: { org_id: "org-1" } },
        ],
      },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "v-blocked",
            push_mode: "blocked_baseline",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 5 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "v-blocked", available: 5 },
          { variant_id: "v-nomap", available: 5 },
        ],
      },
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.blocked_by_push_mode).toBe(2);
    expect(result.seeded).toBe(0);
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("blocks variants whose Bandcamp origin sum is zero", async () => {
    setResults({
      warehouse_product_variants: {
        data: [{ id: "v1", sku: "ZERO-ORIGIN", warehouse_products: { org_id: "org-1" } }],
      },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "v1",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 0 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: { data: [{ variant_id: "v1", available: 5 }] },
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.blocked_zero_origin_sum).toBe(1);
    expect(result.seeded).toBe(0);
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("blocks variants whose warehouse stock is zero (zero-stock policy)", async () => {
    setResults({
      warehouse_product_variants: {
        data: [{ id: "v1", sku: "ZERO-WH", warehouse_products: { org_id: "org-1" } }],
      },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "v1",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 5 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: { data: [{ variant_id: "v1", available: 0 }] },
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.blocked_zero_warehouse_stock).toBe(1);
    expect(result.seeded).toBe(0);
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("dryRun does not call adjust or claim ledger rows", async () => {
    setResults({
      warehouse_product_variants: {
        data: [{ id: "v1", sku: "DRY-1", warehouse_products: { org_id: "org-1" } }],
      },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "v1",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 7 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: { data: [{ variant_id: "v1", available: 7 }] },
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
        dryRun: true,
      },
      taskCtx,
    );

    expect(result.dry_run).toBe(true);
    expect(result.seeded).toBe(1);
    expect(mockAdjust).not.toHaveBeenCalled();
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it("skips SKUs whose ledger row already exists (idempotent retry)", async () => {
    setResults({
      warehouse_product_variants: {
        data: [{ id: "v1", sku: "RETRY-1", warehouse_products: { org_id: "org-1" } }],
      },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "v1",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 4 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: { data: [{ variant_id: "v1", available: 4 }] },
    });

    mockBegin.mockResolvedValueOnce({
      acquired: false,
      reason: "already_succeeded",
      existing_id: "ledger_existing",
      existing_status: "success",
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.ledger_skipped).toBe(1);
    expect(result.seeded).toBe(0);
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("counts errors and continues processing when adjust fails for one SKU", async () => {
    setResults({
      warehouse_product_variants: {
        data: [
          { id: "v1", sku: "OK-1", warehouse_products: { org_id: "org-1" } },
          { id: "v2", sku: "FAIL-1", warehouse_products: { org_id: "org-1" } },
        ],
      },
      bandcamp_product_mappings: {
        data: [
          {
            variant_id: "v1",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 3 }] },
            ],
          },
          {
            variant_id: "v2",
            push_mode: "normal",
            bandcamp_origin_quantities: [
              { origin_id: 1, option_quantities: [{ option_id: null, quantity_available: 8 }] },
            ],
          },
        ],
      },
      warehouse_inventory_levels: {
        data: [
          { variant_id: "v1", available: 3 },
          { variant_id: "v2", available: 8 },
        ],
      },
    });

    mockAdjust.mockImplementation((params: { sku: string }) => {
      if (params.sku === "FAIL-1") {
        return Promise.reject(new Error("simulated v2 500"));
      }
      return Promise.resolve({ ok: true });
    });

    const result = await runShipstationSeedInventory(
      {
        workspaceId: WORKSPACE_ID,
        inventoryWarehouseId: WAREHOUSE_ID,
        inventoryLocationId: LOCATION_ID,
      },
      taskCtx,
    );

    expect(result.seeded).toBe(1);
    expect(result.errors).toBe(1);
    expect(mockSuccess).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});
