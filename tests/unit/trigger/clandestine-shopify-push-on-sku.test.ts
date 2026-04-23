/**
 * Phase 1 §9.2 D2 + Pass 2 D5 — companion test for `clandestine-shopify-push-on-sku`.
 *
 * Pass 2 swap: the task now writes via `setShopifyInventoryCas`
 * (absolute CAS) instead of `inventoryAdjustQuantities` (delta). Skip
 * cascade is preserved EXCEPT `skipped_zero_delta`, which is removed
 * (CAS is absolute — a zero-delta upstream event still needs to push
 * the absolute truth to ensure Shopify converges).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetCas, mockComputeSellable, mockBegin, mockError, mockLoadGuard } = vi.hoisted(() => ({
  mockSetCas: vi.fn(),
  mockComputeSellable: vi.fn(),
  mockBegin: vi.fn(),
  mockError: vi.fn(),
  mockLoadGuard: vi.fn(),
}));

vi.mock("@/lib/server/shopify-cas-retry", () => ({
  setShopifyInventoryCas: mockSetCas,
}));

vi.mock("@/lib/server/effective-sellable", () => ({
  computeEffectiveSellable: mockComputeSellable,
}));

vi.mock("@/lib/server/external-sync-events", () => ({
  beginExternalSync: mockBegin,
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
const ORG_ID = "33333333-3333-3333-3333-333333333333";
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
    orgId: ORG_ID,
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

describe("clandestineShopifyPushOnSkuTask (Pass 2 — CAS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResults({});
    mockBegin.mockResolvedValue({ acquired: true, id: "ledger_cs_1" });
    mockError.mockResolvedValue(undefined);
    mockLoadGuard.mockResolvedValue(makeGuard(true));
    mockComputeSellable.mockResolvedValue({
      effectiveSellable: 7,
      available: 10,
      committedQuantity: 0,
      safetyStock: 3,
      safetySource: "workspace_default",
      committedSource: "absent_phase5_pending",
      reason: null,
      variantId: VARIANT_ID,
    });
    mockSetCas.mockResolvedValue({
      ok: true,
      finalNewQuantity: 7,
      adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/abc",
      attempts: [
        {
          attempt: 1,
          expectedQuantity: 5,
          desiredQuantity: 7,
          idempotencyKey: `clandestine_shopify:${CORR}:${SKU}`,
          durationMs: 100,
          outcome: "success",
          adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/abc",
          newQuantity: 7,
        },
      ],
    });
  });

  it("skips when fanout-guard blocks", async () => {
    mockLoadGuard.mockResolvedValueOnce(makeGuard(false, "integration_paused"));
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_guard");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockSetCas).not.toHaveBeenCalled();
  });

  it("skips when variant cannot be resolved", async () => {
    setResults({ warehouse_product_variants: { data: null } });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_unknown_variant");
    expect(mockSetCas).not.toHaveBeenCalled();
  });

  it("skips when variant has no shopify_inventory_item_id (not yet synced)", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: null },
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_no_shopify_item");
    expect(mockSetCas).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit on zero delta in Pass 2 — CAS is absolute, still needs to converge", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    const result = await runTask(basePayload({ delta: 0 }));
    // Pass 1 would have returned 'skipped_zero_delta' here — Pass 2
    // proceeds to CAS so a stale Shopify number gets reconciled.
    expect(result.status).toBe("ok");
    expect(mockSetCas).toHaveBeenCalledTimes(1);
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
    expect(mockSetCas).not.toHaveBeenCalled();
  });

  it("happy path — wires CAS helper with env-singleton transport, location, and ledger", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pushedQuantity).toBe(7);
    expect(result.attempts).toBe(1);
    expect(result.ledgerId).toBe("ledger_cs_1");

    // Ledger acquired with action='cas_set', NOT 'adjust'.
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        system: "clandestine_shopify",
        action: "cas_set",
        sku: SKU,
        correlation_id: CORR,
      }),
    );

    // CAS helper called with env-singleton transport + the right inventory item + location.
    expect(mockSetCas).toHaveBeenCalledTimes(1);
    const casCall = mockSetCas.mock.calls[0][0];
    expect(casCall.transport).toEqual({ kind: "env_singleton" });
    expect(casCall.inventoryItemId).toBe(INVENTORY_ITEM_ID);
    expect(casCall.locationId).toBe(CLANDESTINE_SHOPIFY_LOCATION_ID);
    expect(casCall.system).toBe("clandestine_shopify");
    expect(casCall.workspaceId).toBe(WORKSPACE_ID);
    expect(casCall.orgId).toBe(ORG_ID);
    expect(casCall.sku).toBe(SKU);
    expect(casCall.correlationId).toBe(CORR);
    expect(casCall.ledgerId).toBe("ledger_cs_1");
    expect(typeof casCall.computeDesired).toBe("function");
  });

  it("computeDesired callback delegates to computeEffectiveSellable for clandestine_shopify channel", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    await runTask(basePayload());
    const casCall = mockSetCas.mock.calls[0][0];
    // Invoke the callback the helper would call — it must read Postgres
    // truth via computeEffectiveSellable, NOT use the Shopify-side value.
    const desired = await casCall.computeDesired(999); // remote=999 should be ignored
    expect(desired).toBe(7);
    expect(mockComputeSellable).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        sku: SKU,
        channel: "clandestine_shopify",
      }),
    );
  });

  it("returns cas_exhausted (NOT throws) when CAS retry loop exhausts", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    mockSetCas.mockResolvedValueOnce({
      ok: false,
      reason: "exhausted",
      attempts: [
        { attempt: 1, outcome: "compare_mismatch" },
        { attempt: 2, outcome: "compare_mismatch" },
        { attempt: 3, outcome: "compare_mismatch" },
      ],
      lastActualQuantity: 11,
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("cas_exhausted");
    if (result.status !== "cas_exhausted") return;
    expect(result.attempts).toBe(3);
    expect(result.lastActualQuantity).toBe(11);
    // Helper marks the ledger error itself; task should NOT double-mark.
    expect(mockError).not.toHaveBeenCalled();
  });

  it("re-throws AND defensively marks ledger error when CAS helper throws on a non-CAS path", async () => {
    setResults({
      warehouse_product_variants: {
        data: { id: VARIANT_ID, shopify_inventory_item_id: INVENTORY_ITEM_ID },
      },
    });
    mockSetCas.mockRejectedValueOnce(new Error("Shopify 503"));
    await expect(runTask(basePayload())).rejects.toThrow(/Shopify 503/);
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});
