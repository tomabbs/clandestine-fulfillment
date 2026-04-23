/**
 * Phase 1 §9.2 D1 — companion test for `client-store-push-on-sku`.
 *
 * Covers the full skip cascade (guard → connection missing → dormant →
 * unsupported platform → no Shopify default location → no mapping →
 * unknown variant → ledger duplicate → unchanged quantity) and the
 * happy-path push (which must update `last_pushed_quantity` /
 * `last_pushed_at` for Rule #65 echo-cancellation and the future Pass 2
 * Shopify CAS baseline).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientStoreConnection } from "@/lib/shared/types";

const {
  mockPushInventory,
  mockCreateStoreSyncClient,
  mockBegin,
  mockSuccess,
  mockError,
  mockLoadGuard,
  mockComputeEffectiveSellable,
} = vi.hoisted(() => ({
  mockPushInventory: vi.fn(),
  mockCreateStoreSyncClient: vi.fn(),
  mockBegin: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
  mockLoadGuard: vi.fn(),
  mockComputeEffectiveSellable: vi.fn(),
}));

vi.mock("@/lib/clients/store-sync-client", () => ({
  createStoreSyncClient: mockCreateStoreSyncClient,
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

// ── Supabase chain stub ──────────────────────────────────────────────────────

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
    default_location_id: "gid://shopify/Location/123456",
    shopify_app_client_id: null,
    shopify_app_client_secret_encrypted: null,
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

describe("clientStorePushOnSkuTask", () => {
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
  });

  it("skips when fanout-guard blocks (rollout_excluded)", async () => {
    mockLoadGuard.mockResolvedValueOnce(makeGuard(false, "rollout_excluded"));
    const result = await runTask(basePayload());
    expect(result.status).toBe("skipped_guard");
    expect(mockBegin).not.toHaveBeenCalled();
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

  it("elides the push when effective_sellable equals last_pushed_quantity (Rule #65 echo)", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
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
    expect(mockPushInventory).not.toHaveBeenCalled();
    expect(mappingUpdate).not.toHaveBeenCalled();
  });

  it("pushes effective_sellable on the happy path and updates last_pushed_*", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.pushedQuantity).toBe(7);
    expect(mockCreateStoreSyncClient).toHaveBeenCalledTimes(1);
    expect(mockPushInventory).toHaveBeenCalledTimes(1);
    const [calledSku, calledQty, idemKey] = mockPushInventory.mock.calls[0];
    expect(calledSku).toBe(REMOTE_SKU);
    expect(calledQty).toBe(7);
    expect(idemKey).toContain(CONNECTION_ID);
    expect(idemKey).toContain("mapping_1");
    expect(idemKey).toContain("7");
    expect(mappingUpdate).toHaveBeenCalledTimes(1);
    expect(mockSuccess).toHaveBeenCalledTimes(1);
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        system: "client_store_shopify",
        action: "set",
        correlation_id: CORR,
        sku: SKU,
      }),
    );
  });

  it("uses client_store_squarespace ledger system for Squarespace connections", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({
          platform: "squarespace",
          default_location_id: null, // not required for non-Shopify
        }),
      },
      client_store_sku_mappings: { data: makeMapping() },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: "client_store_squarespace" }),
    );
  });

  it("uses client_store_woocommerce ledger system for WooCommerce connections", async () => {
    setResults({
      client_store_connections: {
        data: makeConnection({
          platform: "woocommerce",
          default_location_id: null,
        }),
      },
      client_store_sku_mappings: { data: makeMapping() },
    });
    const result = await runTask(basePayload());
    expect(result.status).toBe("ok");
    expect(mockBegin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: "client_store_woocommerce" }),
    );
  });

  it("skips bigcommerce (not supported in Pass 1)", async () => {
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

  it("marks ledger error and rethrows when pushInventory fails", async () => {
    setResults({
      client_store_connections: { data: makeConnection() },
      client_store_sku_mappings: { data: makeMapping() },
    });
    mockPushInventory.mockRejectedValueOnce(new Error("Shopify 429 rate-limited"));
    await expect(runTask(basePayload())).rejects.toThrow(/rate-limited/);
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mappingUpdate).not.toHaveBeenCalled();
  });
});
