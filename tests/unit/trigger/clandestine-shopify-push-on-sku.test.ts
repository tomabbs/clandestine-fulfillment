/**
 * Phase 1 §9.2 D2 — companion test for `clandestine-shopify-push-on-sku`.
 *
 * Pins the skip cascade and the happy-path delta forward to
 * `inventoryAdjustQuantities`. Pass 1 is delta-based (matches the
 * previously-inlined fanout block) — the absolute-set semantics land
 * in Pass 2 with `shopify-cas.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdjust, mockBegin, mockSuccess, mockError, mockLoadGuard } = vi.hoisted(() => ({
  mockAdjust: vi.fn(),
  mockBegin: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
  mockLoadGuard: vi.fn(),
}));

vi.mock("@/lib/clients/shopify-client", () => ({
  inventoryAdjustQuantities: mockAdjust,
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
  queue: (def: unknown) => def,
}));

vi.mock("@/trigger/lib/client-store-push-queues", () => ({
  clandestineShopifyPushQueue: { name: "clandestine-shopify-push" },
}));

interface ChainResult {
  data: unknown;
  error?: unknown;
}

function chain(result: ChainResult) {
  const obj: Record<string, unknown> = {
    select: () => chain(result),
    eq: () => chain(result),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    // biome-ignore lint/suspicious/noThenProperty: PostgREST chain mimics PromiseLike.
    then: (resolve: (v: ChainResult) => unknown) => resolve(result),
  };
  return obj;
}

interface TableResults {
  warehouse_product_variants?: ChainResult;
}

let __currentResults: TableResults = {};

function setResults(r: TableResults) {
  __currentResults = r;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      switch (table) {
        case "warehouse_product_variants":
          return chain(__currentResults.warehouse_product_variants ?? { data: null });
        default:
          return chain({ data: null });
      }
    },
  }),
}));

import {
  CLANDESTINE_SHOPIFY_LOCATION_ID,
  clandestineShopifyPushOnSkuTask,
} from "@/trigger/tasks/clandestine-shopify-push-on-sku";

const runTask = (
  clandestineShopifyPushOnSkuTask as unknown as {
    run: (
      payload: import("@/trigger/tasks/clandestine-shopify-push-on-sku").ClandestineShopifyPushOnSkuPayload,
    ) => Promise<
      import("@/trigger/tasks/clandestine-shopify-push-on-sku").ClandestineShopifyPushOnSkuResult
    >;
  }
).run;

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const VARIANT_ID = "22222222-2222-4222-8222-222222222222";
const INVENTORY_ITEM_ID = "gid://shopify/InventoryItem/9999";
const SKU = "CL-LP-001";
const CORR = "fanout:CL-LP-001:1700000000000";

function basePayload(overrides: Partial<{ delta: number }> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    sku: SKU,
    delta: -2,
    correlationId: CORR,
    reason: "fanout:shopify_webhook",
    metadata: { origin: "test" },
    ...overrides,
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

describe("clandestineShopifyPushOnSkuTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResults({});
    mockBegin.mockResolvedValue({ acquired: true, id: "ledger_cs_1" });
    mockSuccess.mockResolvedValue(undefined);
    mockError.mockResolvedValue(undefined);
    mockAdjust.mockResolvedValue(undefined);
    mockLoadGuard.mockResolvedValue(makeGuard(true));
  });

  it("skips when fanout-guard blocks", async () => {
    mockLoadGuard.mockResolvedValueOnce(makeGuard(false, "integration_paused"));
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_guard");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("skips when variant cannot be resolved", async () => {
    setResults({ warehouse_product_variants: { data: null } });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_unknown_variant");
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("skips when variant has no shopify_inventory_item_id (not yet synced)", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: null },
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_no_shopify_item");
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("skips zero-delta payloads", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    const result = await runTask(basePayload({ delta: 0 }));
    expect(result.status).toBe("skipped_zero_delta");
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it("short-circuits on duplicate ledger row", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    mockBegin.mockResolvedValueOnce({
      acquired: false,
      reason: "already_succeeded",
      existing_id: "ledger_existing",
      existing_status: "success",
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_ledger_duplicate");
    expect(mockAdjust).not.toHaveBeenCalled();
  });

  it("forwards delta to inventoryAdjustQuantities on the happy path", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    const result = await runTask(basePayload({ delta: -3 }));
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.delta).toBe(-3);
    expect(mockAdjust).toHaveBeenCalledTimes(1);
    expect(mockAdjust).toHaveBeenCalledWith(
      INVENTORY_ITEM_ID,
      CLANDESTINE_SHOPIFY_LOCATION_ID,
      -3,
      CORR,
    );
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        system: "clandestine_shopify",
        action: "adjust",
        sku: SKU,
        correlation_id: CORR,
      }),
    );
    expect(mockSuccess).toHaveBeenCalledTimes(1);
  });

  it("marks ledger error and rethrows when push fails", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    mockAdjust.mockRejectedValueOnce(new Error("Shopify 503"));
    await expect(runTask(basePayload())).rejects.toThrow(/Shopify 503/);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockSuccess).not.toHaveBeenCalled();
  });
});
