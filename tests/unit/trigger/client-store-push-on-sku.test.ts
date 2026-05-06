/**
 * Phase 1 §9.2 D1 + Pass 2 D5 — companion test for `client-store-push-on-sku`.
 *
 * Pass 2 splits the platform path:
 *   - Shopify routes through `setShopifyInventoryCas` (per-connection
 *     transport) — uses ledger action `cas_set`, skips the
 *     unchanged-quantity elision, requires `remote_inventory_item_id`.
 *   - Squarespace + WooCommerce stay on the legacy
 *     `createStoreSyncClient(...).pushInventory(...)` dispatcher with
 *     ledger action `set`.
 *
 * Coverage:
 *   - skip cascade (guard, connection missing, dormant, unsupported
 *     platform, no Shopify default location, no mapping, missing
 *     remote_inventory_item_id, ledger duplicate, unchanged quantity for
 *     non-Shopify, unknown variant)
 *   - Shopify CAS happy path (transport shape, GID normalisation,
 *     `cas_set` ledger action, `last_pushed_*` write-back)
 *   - Shopify CAS exhaustion (returns `cas_exhausted`, does NOT throw,
 *     does NOT write `last_pushed_*`)
 *   - Squarespace + WooCommerce go through legacy dispatcher
 *   - Legacy dispatcher push failure marks ledger error + rethrows
 *   - alias fanout resolves by mapping/variant identity, not remote_sku=warehouse SKU
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientStoreConnection } from "@/lib/shared/types";

const {
  mockPushInventory,
  mockCreateStoreSyncClient,
  mockSetCas,
  mockBegin,
  mockSuccess,
  mockError,
  mockLoadGuard,
  mockComputeEffectiveSellable,
} = vi.hoisted(() => ({
  mockPushInventory: vi.fn(),
  mockCreateStoreSyncClient: vi.fn(),
  mockSetCas: vi.fn(),
  mockBegin: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
  mockLoadGuard: vi.fn(),
  mockComputeEffectiveSellable: vi.fn(),
}));

vi.mock("@/lib/clients/store-sync-client", () => ({
  createStoreSyncClient: mockCreateStoreSyncClient,
}));

vi.mock("@/lib/server/shopify-cas-retry", () => ({
  setShopifyInventoryCas: mockSetCas,
}));

vi.mock("@/lib/server/external-sync-events", () => ({
  beginExternalSync: mockBegin,
  markExternalSyncSuccess: mockSuccess,
  markExternalSyncError: mockError,
}));

vi.mock("@/lib/server/fanout-guard", () => ({
  loadFanoutGuard: mockLoadGuard,
}));

vi.mock("@/lib/server/effective-sellable", () => ({
  computeEffectiveSellable: mockComputeEffectiveSellable,
}));

vi.mock("@/lib/server/client-store-fanout-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/client-store-fanout-gate")>(
    "@/lib/server/client-store-fanout-gate",
  );
  return actual;
});

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: unknown) => def,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  queue: (def: unknown) => def,
}));

vi.mock("@/trigger/lib/client-store-push-queues", () => ({
  clientStorePushQueue: { name: "client-store-push" },
}));

interface ChainResult {
  data: unknown;
  error?: unknown;
}

const mappingUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null }) }));

function chain(result: ChainResult) {
  const obj: Record<string, unknown> = {
    select: () => chain(result),
    eq: () => chain(result),
    limit: () => chain(result),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    // biome-ignore lint/suspicious/noThenProperty: PostgREST chain mimics PromiseLike.
    then: (resolve: (v: ChainResult) => unknown) => resolve(result),
  };
  return obj;
}

interface TableResults {
  client_store_connections?: ChainResult;
  client_store_sku_mappings?: ChainResult;
}

let __currentResults: TableResults = {};

function setResults(r: TableResults) {
  __currentResults = r;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      switch (table) {
        case "client_store_connections":
          return chain(__currentResults.client_store_connections ?? { data: null });
        case "client_store_sku_mappings":
          return {
            select: () => chain(__currentResults.client_store_sku_mappings ?? { data: null }),
            update: mappingUpdate,
          };
        default:
          return chain({ data: null });
      }
    },
  }),
}));

import { clientStorePushOnSkuTask } from "@/trigger/tasks/client-store-push-on-sku";

const runTask = (
  clientStorePushOnSkuTask as unknown as {
    run: (
      payload: import("@/trigger/tasks/client-store-push-on-sku").ClientStorePushOnSkuPayload,
    ) => Promise<import("@/trigger/tasks/client-store-push-on-sku").ClientStorePushOnSkuResult>;
  }
).run;

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-3333-3333-333333333333";
const SKU = "ACME-LP-001";
const REMOTE_SKU = "ACME-LP-001";
const CORR = "fanout:ACME-LP-001:1700000000000";
const REMOTE_INVENTORY_ITEM_GID = "gid://shopify/InventoryItem/77777";
const SHOPIFY_LOCATION_GID = "gid://shopify/Location/123456";

function basePayload() {
  return {
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    sku: SKU,
    correlationId: CORR,
    reason: "fanout:shopify_webhook",
    metadata: { origin: "test" },
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

function makeConnection(overrides: Partial<ClientStoreConnection> = {}): ClientStoreConnection {
  return {
    id: CONNECTION_ID,
    workspace_id: WORKSPACE_ID,
    org_id: ORG_ID,
    platform: "shopify",
    store_url: "https://acme.myshopify.com",
    api_key: "shpat_test",
    api_secret: null,
    webhook_url: null,
    webhook_secret: null,
    connection_status: "active",
    last_webhook_at: null,
    last_poll_at: null,
    last_error_at: null,
    last_error: null,
    do_not_fanout: false,
    default_location_id: SHOPIFY_LOCATION_GID,
    shopify_app_client_id: null,
    shopify_app_client_secret_encrypted: null,
    cutover_state: "legacy",
    cutover_started_at: null,
    cutover_completed_at: null,
    shadow_mode_log_id: null,
    shadow_window_tolerance_seconds: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMapping(overrides: Record<string, unknown> = {}) {
  return {
    id: "mapping_1",
    variant_id: "44444444-4444-4444-4444-444444444444",
    remote_product_id: "gid://shopify/Product/9999",
    remote_variant_id: "gid://shopify/ProductVariant/1111",
    remote_inventory_item_id: REMOTE_INVENTORY_ITEM_GID,
    remote_sku: REMOTE_SKU,
    last_pushed_quantity: 0,
    safety_stock: 0,
    ...overrides,
  };
}

function sellable(
  overrides: Partial<{
    effectiveSellable: number;
    available: number;
    committedQuantity: number;
    safetyStock: number;
    reason: null | "variant_not_found" | "unknown_channel";
  }> = {},
) {
  return {
    available: 10,
    committedQuantity: 0,
    committedSource: "absent_phase5_pending" as const,
    safetyStock: 3,
    safetySource: "workspace_default" as const,
    effectiveSellable: 7,
    reason: null,
    variantId: "44444444-4444-4444-4444-444444444444",
    ...overrides,
  };
}

function casSuccess(finalQty = 7, attempts = 1) {
  return {
    ok: true,
    finalNewQuantity: finalQty,
    adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/abc",
    attempts: Array.from({ length: attempts }, (_, i) => ({
      attempt: i + 1,
      expectedQuantity: 5,
      desiredQuantity: finalQty,
      idempotencyKey: `client_store_shopify:${CORR}:${SKU}${i === 0 ? "" : `:retry${i}`}`,
      durationMs: 100,
      outcome: "success" as const,
      adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/abc",
      newQuantity: finalQty,
    })),
  };
}

describe("clientStorePushOnSkuTask (Pass 2 — Shopify CAS branch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResults({});
    mockBegin.mockResolvedValue({ acquired: true, id: "ledger_cs_1" });
    mockSuccess.mockResolvedValue(undefined);
    mockError.mockResolvedValue(undefined);
    mockPushInventory.mockResolvedValue(undefined);
    mockCreateStoreSyncClient.mockReturnValue({
      pushInventory: mockPushInventory,
    });
    mockLoadGuard.mockResolvedValue(makeGuard(true));
    mockComputeEffectiveSellable.mockResolvedValue(sellable());
    mockSetCas.mockResolvedValue(casSuccess());
  });

  // ── skip cascade ──────────────────────────────────────────────────────────

  it("skips when fanout-guard blocks (rollout_excluded)", async () => {
    mockLoadGuard.mockResolvedValueOnce(makeGuard(false, "rollout_excluded"));
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_guard");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockSetCas).not.toHaveBeenCalled();
    expect(mockPushInventory).not.toHaveBeenCalled();
  });

  it("skips when the connection row is missing", async () => {
    setResults({ client_store_connections: { data: null } });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_connection_missing");
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it("skips when the connection is dormant (do_not_fanout)", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ do_not_fanout: true }),
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_dormant");
    expect(result.status === "skipped_dormant" && result.reason).toBe("do_not_fanout");
    expect(mockSetCas).not.toHaveBeenCalled();
    expect(mockPushInventory).not.toHaveBeenCalled();
  });

  it("skips when the connection auth has failed", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ connection_status: "disabled_auth_failure" }),
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_dormant");
    expect(result.status === "skipped_dormant" && result.reason).toBe("auth_failed");
  });

  it("skips Shopify connection without default_location_id (HRD-05)", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ default_location_id: null }),
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_no_default_location");
    expect(mockComputeEffectiveSellable).not.toHaveBeenCalled();
  });

  it("skips when no active mapping exists for (connection_id, sku)", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: null },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_no_mapping");
    expect(mockComputeEffectiveSellable).not.toHaveBeenCalled();
  });

  it("Pass 2: skips Shopify mapping without remote_inventory_item_id", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping({ remote_inventory_item_id: null }) },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_no_remote_inventory_item_id");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockSetCas).not.toHaveBeenCalled();
    // Critical: must NOT silently drop into the legacy dispatcher.
    expect(mockPushInventory).not.toHaveBeenCalled();
  });

  it("resolves alias mappings by mapping/variant identity when remote SKU differs from warehouse SKU", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: {
        data: makeMapping({ id: "mapping_alias", remote_sku: "REMOTE-LP-001" }),
      },
    });

    const result = await runTask({
      ...basePayload(),
      sku: "WAREHOUSE-LP-001",
      variantId: "44444444-4444-4444-4444-444444444444",
      mappingId: "mapping_alias",
    });

    expect(result.status).toBe("ok");
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sku: "WAREHOUSE-LP-001",
        request_body: expect.objectContaining({ remote_sku: "REMOTE-LP-001" }),
      }),
    );
    expect(mockSetCas).toHaveBeenCalledTimes(1);
  });

  it("skips when computeEffectiveSellable reports variant_not_found", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
    });
    mockComputeEffectiveSellable.mockResolvedValueOnce(
      sellable({ reason: "variant_not_found", effectiveSellable: 0 }),
    );
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_unknown_variant");
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it("Pass 2: Shopify does NOT short-circuit on unchanged quantity (CAS converges)", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: {
        data: makeMapping({ last_pushed_quantity: 7 }),
      },
    });
    const result = await runTask(basePayload());
    // Pre-Pass-2 this returned 'skipped_unchanged_quantity'. Pass 2
    // proceeds to CAS so a stale Shopify number gets reconciled.
    expect(result.status).toBe("ok");
    expect(mockSetCas).toHaveBeenCalledTimes(1);
  });

  it("non-Shopify still elides on unchanged quantity (Rule #65 echo, dispatcher path)", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ platform: "squarespace", default_location_id: null }),
      },
      client_store_sku_mappings: {
        data: makeMapping({ last_pushed_quantity: 7 }),
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_unchanged_quantity");
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockPushInventory).not.toHaveBeenCalled();
  });

  it("short-circuits on duplicate ledger row", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
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
    expect(mockPushInventory).not.toHaveBeenCalled();
    expect(mappingUpdate).not.toHaveBeenCalled();
  });

  // ── Shopify CAS happy path ────────────────────────────────────────────────

  it("Shopify happy path → CAS (per-connection transport, cas_set ledger, last_pushed_* write-back)", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pushedQuantity).toBe(7);
    expect(result.attempts).toBe(1);

    // CAS called with per-connection transport + correct GIDs.
    expect(mockSetCas).toHaveBeenCalledTimes(1);
    const casCall = mockSetCas.mock.calls[0][0];
    expect(casCall.transport).toEqual({
      kind: "per_connection",
      ctx: { storeUrl: "https://acme.myshopify.com", accessToken: "shpat_test" },
    });
    expect(casCall.inventoryItemId).toBe(REMOTE_INVENTORY_ITEM_GID);
    expect(casCall.locationId).toBe(SHOPIFY_LOCATION_GID);
    expect(casCall.system).toBe("client_store_shopify");
    expect(casCall.sku).toBe(SKU);
    expect(casCall.correlationId).toBe(CORR);
    expect(casCall.workspaceId).toBe(WORKSPACE_ID);
    expect(casCall.orgId).toBe(ORG_ID);
    expect(casCall.ledgerId).toBe("ledger_cs_1");
    expect(typeof casCall.computeDesired).toBe("function");

    // Ledger acquired with cas_set, NOT set.
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        system: "client_store_shopify",
        action: "cas_set",
        sku: SKU,
        correlation_id: CORR,
      }),
    );

    // last_pushed_* write-back happens (echo cancellation Rule #65).
    expect(mappingUpdate).toHaveBeenCalledTimes(1);

    // Legacy dispatcher and markExternalSyncSuccess NOT called for Shopify.
    expect(mockPushInventory).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("Shopify CAS computeDesired callback invokes computeEffectiveSellable per attempt", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
    });
    await runTask(basePayload());
    const casCall = mockSetCas.mock.calls[0][0];
    mockComputeEffectiveSellable.mockClear();
    const desired = await casCall.computeDesired(999); // remote=999 ignored
    expect(desired).toBe(7);
    expect(mockComputeEffectiveSellable).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        sku: SKU,
        channel: "client_store_shopify",
        connectionId: CONNECTION_ID,
      }),
    );
  });

  it("Shopify CAS normalises numeric default_location_id and remote_inventory_item_id to GIDs", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ default_location_id: "987654" }),
      },
      client_store_sku_mappings: {
        data: makeMapping({ remote_inventory_item_id: "555444" }),
      },
    });
    await runTask(basePayload());
    const casCall = mockSetCas.mock.calls[0][0];
    expect(casCall.locationId).toBe("gid://shopify/Location/987654");
    expect(casCall.inventoryItemId).toBe("gid://shopify/InventoryItem/555444");
  });

  it("Shopify CAS exhaustion returns cas_exhausted, does NOT throw, does NOT update last_pushed_*", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
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
    expect(mappingUpdate).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it("Shopify CAS non-CAS error rethrows + defensively marks ledger error", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
    });
    mockSetCas.mockRejectedValueOnce(new Error("Shopify 503"));
    await expect(runTask(basePayload())).rejects.toThrow(/Shopify 503/);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mappingUpdate).not.toHaveBeenCalled();
  });

  // ── Squarespace + WooCommerce: legacy dispatcher path ─────────────────────

  it("Squarespace stays on legacy dispatcher with action=set", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ platform: "squarespace", default_location_id: null }),
      },
      client_store_sku_mappings: { data: makeMapping() },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(mockSetCas).not.toHaveBeenCalled();
    expect(mockPushInventory).toHaveBeenCalledTimes(1);
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: "client_store_squarespace", action: "set" }),
    );
    expect(mappingUpdate).toHaveBeenCalledTimes(1);
    expect(mockSuccess).toHaveBeenCalledTimes(1);
  });

  it("WooCommerce stays on legacy dispatcher with action=set", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ platform: "woocommerce", default_location_id: null }),
      },
      client_store_sku_mappings: { data: makeMapping() },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(mockSetCas).not.toHaveBeenCalled();
    expect(mockPushInventory).toHaveBeenCalledTimes(1);
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: "client_store_woocommerce", action: "set" }),
    );
  });

  it("skips bigcommerce (not supported in Pass 1/2)", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({
          platform: "bigcommerce",
          default_location_id: null,
        }),
      },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_unknown_platform");
    expect(mockComputeEffectiveSellable).not.toHaveBeenCalled();
  });

  it("legacy dispatcher push failure marks ledger error + rethrows", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({ platform: "squarespace", default_location_id: null }),
      },
      client_store_sku_mappings: { data: makeMapping() },
    });
    mockPushInventory.mockRejectedValueOnce(new Error("Squarespace 429 rate-limited"));
    await expect(runTask(basePayload())).rejects.toThrow(/rate-limited/);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mappingUpdate).not.toHaveBeenCalled();
  });
});
