/**
 * Process-client-store-webhook handler tests.
 *
 * Covers the three webhook handlers wired into the topic dispatcher:
 *   - handleInventoryUpdate (Shopify inventory_item_id → SKU resolution
 *     via remote_inventory_item_id, HRD-05 wrong_location guard, echo
 *     cancellation, missing-mapping detection; WC/Squarespace SKU+quantity
 *     legacy path preserved).
 *   - handleRefund (Shopify refunds/create, restock_type === 'return' only,
 *     HRD-07.2 empty-array defense, line-item-id resolution back to
 *     warehouse_order_items.shopify_line_item_id, idempotent recredit).
 *   - handleOrderCancelled (re-credits all warehouse_order_items, marks
 *     warehouse_orders.fulfillment_status = 'cancelled', skip-on-second
 *     delivery via fulfillment_status check).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFrom,
  mockTrigger,
  mockRecordInventoryChange,
  mockTriggerBundleFanout,
  mockShouldFanoutToConnection,
  mockExtractEventContext,
  mockCheckMonotonicGuard,
  mockStashEntityId,
  mockMarkStaleDropped,
  mockWriteLastSeenAt,
  mockCommitOrderItems,
  mockReleaseOrderItems,
  mockRehydrateWebhookInventoryUpdate,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockTrigger: vi.fn().mockResolvedValue({ id: "run-1" }),
  mockRecordInventoryChange: vi.fn().mockResolvedValue({
    success: true,
    newQuantity: 0,
    alreadyProcessed: false,
  }),
  mockTriggerBundleFanout: vi.fn().mockResolvedValue({ error: null }),
  mockShouldFanoutToConnection: vi.fn().mockReturnValue({ allow: true }),
  mockExtractEventContext: vi.fn().mockReturnValue({
    entityId: null,
    eventTimestamp: null,
  }),
  mockCheckMonotonicGuard: vi.fn().mockResolvedValue({ stale: false }),
  mockStashEntityId: vi.fn().mockResolvedValue(undefined),
  mockMarkStaleDropped: vi.fn().mockResolvedValue(undefined),
  mockWriteLastSeenAt: vi.fn().mockResolvedValue(undefined),
  // Phase 5 §9.6 D1.b — handleOrderCreated calls commitOrderItems and
  // handleOrderCancelled calls releaseOrderItems. Default to success
  // so existing tests don't regress; the new tests at the bottom of
  // this file exercise the actual call shapes.
  mockCommitOrderItems: vi.fn().mockResolvedValue({ inserted: 0, alreadyOpen: [] }),
  mockReleaseOrderItems: vi.fn().mockResolvedValue({ released: 0 }),
  // Phase 4 SKU-AUTO-24 — default returns `no_identity_row` so
  // pre-existing missing-mapping tests keep flowing through to the
  // historical `sku_mapping_missing` path. Rehydrate-branch tests
  // override this per-case.
  mockRehydrateWebhookInventoryUpdate: vi.fn().mockResolvedValue({ kind: "no_identity_row" }),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
  task: (def: { run: (payload: unknown) => unknown }) => def,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: mockRecordInventoryChange,
}));

vi.mock("@/lib/server/inventory-commitments", () => ({
  commitOrderItems: mockCommitOrderItems,
  releaseOrderItems: mockReleaseOrderItems,
}));

vi.mock("@/lib/server/bundles", () => ({
  triggerBundleFanout: mockTriggerBundleFanout,
}));

vi.mock("@/lib/server/client-store-fanout-gate", () => ({
  shouldFanoutToConnection: mockShouldFanoutToConnection,
}));

vi.mock("@/lib/server/webhook-monotonic-guard", () => ({
  extractEventContext: mockExtractEventContext,
  checkMonotonicGuard: mockCheckMonotonicGuard,
  stashEntityIdOnCurrentRow: mockStashEntityId,
  markStaleDropped: mockMarkStaleDropped,
  writeLastSeenAt: mockWriteLastSeenAt,
}));

// Phase 4 SKU-AUTO-24 — mock the rehydrate orchestrator so each
// wiring branch in `handleInventoryUpdate` can be driven
// deterministically. The orchestrator itself has its own test suite
// (tests/unit/lib/server/webhook-rehydrate.test.ts); here we only
// assert the handler correctly maps each outcome to a `webhook_events`
// status + return value and, where appropriate, halts before the
// historical `sku_mapping_missing` path.
vi.mock("@/lib/server/webhook-rehydrate", () => ({
  rehydrateWebhookInventoryUpdate: mockRehydrateWebhookInventoryUpdate,
}));

import { processClientStoreWebhookTask as _processClientStoreWebhookTask } from "@/trigger/tasks/process-client-store-webhook";

// Trigger.dev v4 Task<…> doesn't expose .run on its public type; cast through
// unknown to call the underlying definition directly (same pattern used in
// tests/unit/trigger/tasks/bulk-update-available.test.ts).
const processClientStoreWebhookTask = _processClientStoreWebhookTask as unknown as {
  run: (payload: { webhookEventId: string }) => Promise<Record<string, unknown>>;
};

// In-memory state captured per test for assertions.
interface MockState {
  webhookEvents: Map<string, Record<string, unknown>>;
  webhookEventStatusUpdates: Array<{ id: string; status: string | undefined }>;
  // F-1: telemetry inserts for cancel_after_fulfillment_partial.
  webhookEventsInserts: Array<Record<string, unknown>>;
  connections: Map<string, Record<string, unknown>>;
  skuMappings: Array<Record<string, unknown>>;
  inventoryLevels: Array<Record<string, unknown>>;
  warehouseOrders: Array<Record<string, unknown>>;
  warehouseOrdersUpdates: Array<{ id: string; payload: Record<string, unknown> }>;
  warehouseOrderItems: Array<Record<string, unknown>>;
  reviewQueueUpserts: Array<Record<string, unknown>>;
  // ── Phase 4 SKU-AUTO-24 rehydrate-orchestrator test harness ──
  rehydrateWorkspace: Record<string, unknown> | null;
  rehydrateIdentityRow: Record<string, unknown> | null;
  rehydrateWarehouseLevelByVariantId: Map<string, Record<string, unknown>>;
  rehydrateStabilityHistory: Array<Record<string, unknown>>;
}

function newState(): MockState {
  return {
    webhookEvents: new Map(),
    webhookEventStatusUpdates: [],
    webhookEventsInserts: [],
    connections: new Map(),
    skuMappings: [],
    inventoryLevels: [],
    warehouseOrders: [],
    warehouseOrdersUpdates: [],
    warehouseOrderItems: [],
    reviewQueueUpserts: [],
    rehydrateWorkspace: null,
    rehydrateIdentityRow: null,
    rehydrateWarehouseLevelByVariantId: new Map(),
    rehydrateStabilityHistory: [],
  };
}

let state: MockState;

function installFromMock() {
  mockFrom.mockImplementation((table: string) => {
    if (table === "webhook_events") {
      return {
        select: () => ({
          eq: (_col: string, id: string) => ({
            single: async () => ({ data: state.webhookEvents.get(id) ?? null, error: null }),
          }),
        }),
        update: (payload: { status?: string }) => ({
          eq: async (_col: string, id: string) => {
            state.webhookEventStatusUpdates.push({ id, status: payload.status });
            const existing = state.webhookEvents.get(id);
            if (existing) state.webhookEvents.set(id, { ...existing, status: payload.status });
            return { data: null, error: null };
          },
        }),
        // F-1: cancel_after_fulfillment_partial telemetry uses .insert(...)
        // directly (no chained .select). Capture into state for assertions.
        insert: async (payload: Record<string, unknown>) => {
          state.webhookEventsInserts.push(payload);
          return { data: null, error: null };
        },
      };
    }
    if (table === "client_store_connections") {
      return {
        select: () => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => ({ data: state.connections.get(id) ?? null, error: null }),
            single: async () => ({ data: state.connections.get(id) ?? null, error: null }),
          }),
        }),
      };
    }
    if (table === "client_store_sku_mappings") {
      return {
        select: () => ({
          eq: (firstCol: string, firstVal: unknown) => ({
            eq: (secondCol: string, secondVal: unknown) => ({
              maybeSingle: async () => ({
                data:
                  state.skuMappings.find(
                    (m) => m[firstCol] === firstVal && m[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
              single: async () => ({
                data:
                  state.skuMappings.find(
                    (m) => m[firstCol] === firstVal && m[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
            }),
          }),
        }),
      };
    }
    if (table === "warehouse_inventory_levels") {
      return {
        select: () => ({
          eq: (firstCol: string, firstVal: unknown) => ({
            // Two-eq terminator — existing handler reads by
            // (workspace_id, sku) when computing the delta.
            eq: (secondCol: string, secondVal: unknown) => ({
              maybeSingle: async () => ({
                data:
                  state.inventoryLevels.find(
                    (l) => l[firstCol] === firstVal && l[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
              single: async () => ({
                data:
                  state.inventoryLevels.find(
                    (l) => l[firstCol] === firstVal && l[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
            }),
            // Single-eq terminator — Phase 4 rehydrate orchestrator
            // reads by variant_id only to compute warehouse ATP.
            maybeSingle: async () => {
              if (firstCol !== "variant_id" || typeof firstVal !== "string") {
                return { data: null, error: null };
              }
              return {
                data: state.rehydrateWarehouseLevelByVariantId.get(firstVal) ?? null,
                error: null,
              };
            },
          }),
        }),
      };
    }
    if (table === "warehouse_orders") {
      return {
        select: () => ({
          eq: (firstCol: string, firstVal: unknown) => ({
            eq: (secondCol: string, secondVal: unknown) => ({
              maybeSingle: async () => ({
                data:
                  state.warehouseOrders.find(
                    (o) => o[firstCol] === firstVal && o[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
              single: async () => ({
                data:
                  state.warehouseOrders.find(
                    (o) => o[firstCol] === firstVal && o[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            state.warehouseOrdersUpdates.push({ id, payload });
            const existing = state.warehouseOrders.find((o) => o.id === id);
            if (existing) Object.assign(existing, payload);
            return { data: null, error: null };
          },
        }),
      };
    }
    if (table === "warehouse_order_items") {
      return {
        select: () => ({
          eq: (firstCol: string, firstVal: unknown) => ({
            eq: (secondCol: string, secondVal: unknown) => ({
              maybeSingle: async () => ({
                data:
                  state.warehouseOrderItems.find(
                    (i) => i[firstCol] === firstVal && i[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
              single: async () => ({
                data:
                  state.warehouseOrderItems.find(
                    (i) => i[firstCol] === firstVal && i[secondCol] === secondVal,
                  ) ?? null,
                error: null,
              }),
            }),
            // Single-eq lookup used by handleOrderCancelled to fetch all rows
            // for an order. Mimics PostgREST builder which is awaitable.
            // biome-ignore lint/suspicious/noThenProperty: deliberate thennable mock for PostgREST builder
            then: undefined,
          }),
        }),
      };
    }
    if (table === "warehouse_review_queue") {
      return {
        upsert: async (payload: Record<string, unknown>) => {
          state.reviewQueueUpserts.push(payload);
          return { data: null, error: null };
        },
      };
    }

    // ── Phase 4 SKU-AUTO-24 webhook-rehydrate orchestrator tables ──
    //
    // These mocks let the rehydrate orchestrator run during existing
    // handler tests without affecting their assertions: workspaces
    // always reports `emergency_paused=false`, identity matches
    // always miss (orchestrator returns `no_identity_row` and the
    // handler falls through to the historical `sku_mapping_missing`
    // return). Tests that want to exercise rehydrate branches stub
    // `state.rehydrateIdentityRow` + `state.rehydrateWarehouseLevel`
    // below.
    if (table === "workspaces") {
      return {
        select: () => ({
          eq: (_col: string, _id: string) => ({
            maybeSingle: async () => ({
              data: state.rehydrateWorkspace ?? { sku_autonomous_emergency_paused: false },
              error: null,
            }),
            single: async () => ({
              data: state.rehydrateWorkspace ?? { sku_autonomous_emergency_paused: false },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "client_store_product_identity_matches") {
      return {
        select: () => {
          const builder = {
            eq: (_c: string, _v: string) => builder,
            maybeSingle: async () => ({
              data: state.rehydrateIdentityRow ?? null,
              error: null,
            }),
          };
          return builder;
        },
        update: (_payload: Record<string, unknown>) => ({
          eq: async (_c: string, _v: string) => ({ data: null, error: null }),
        }),
      };
    }
    if (table === "stock_stability_readings") {
      return {
        select: () => {
          const builder = {
            eq: (_c: string, _v: string) => builder,
            order: (_c: string, _o: { ascending: boolean }) => ({
              limit: async (_n: number) => ({
                data: state.rehydrateStabilityHistory ?? [],
                error: null,
              }),
            }),
          };
          return builder;
        },
      };
    }
    if (table === "sku_autonomous_runs") {
      return {
        insert: (_rows: Record<string, unknown>[]) => ({
          select: () => ({
            single: async () => ({
              data: { id: "auto-run-1" },
              error: null,
            }),
          }),
        }),
        update: (_payload: Record<string, unknown>) => ({
          eq: async (_c: string, _v: string) => ({ data: null, error: null }),
        }),
      };
    }
    if (table === "sku_autonomous_decisions") {
      return {
        insert: (_rows: Record<string, unknown>[]) => ({
          select: () => ({
            single: async () => ({
              data: { id: "auto-decision-1" },
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
}

// Specialised mock for warehouse_order_items.select(...).eq(order_id, x) — the
// cancel handler calls `.eq("order_id", id)` and awaits directly (no
// .maybeSingle). The generic mock above doesn't expose that — patch in.
function patchWarehouseOrderItemsListByOrder() {
  const original = mockFrom.getMockImplementation();
  mockFrom.mockImplementation((table: string) => {
    if (table === "warehouse_order_items") {
      return {
        select: () => {
          const builder = {
            eq: (col: string, val: unknown) => {
              const matches = state.warehouseOrderItems.filter((i) => i[col] === val);
              const thennable = {
                // biome-ignore lint/suspicious/noThenProperty: deliberate thennable mock for PostgREST builder
                then: (resolve: (v: { data: unknown; error: null }) => void) =>
                  resolve({ data: matches, error: null }),
                eq: (secondCol: string, secondVal: unknown) => ({
                  maybeSingle: async () => ({
                    data: matches.find((i) => i[secondCol] === secondVal) ?? null,
                    error: null,
                  }),
                }),
              };
              return thennable;
            },
          };
          return builder;
        },
      };
    }
    return original ? original(table) : {};
  });
}

beforeEach(() => {
  state = newState();
  installFromMock();
  patchWarehouseOrderItemsListByOrder();

  mockTrigger.mockClear();
  mockCommitOrderItems.mockReset();
  mockCommitOrderItems.mockResolvedValue({ inserted: 0, alreadyOpen: [] });
  mockReleaseOrderItems.mockReset();
  mockReleaseOrderItems.mockResolvedValue({ released: 0 });
  mockRecordInventoryChange.mockReset();
  mockRecordInventoryChange.mockResolvedValue({
    success: true,
    newQuantity: 0,
    alreadyProcessed: false,
  });
  mockTriggerBundleFanout.mockClear();
  mockShouldFanoutToConnection.mockReset();
  mockShouldFanoutToConnection.mockReturnValue({ allow: true });
  mockExtractEventContext.mockReset();
  mockExtractEventContext.mockReturnValue({ entityId: null, eventTimestamp: null });
  mockCheckMonotonicGuard.mockReset();
  mockCheckMonotonicGuard.mockResolvedValue({ stale: false });
  mockRehydrateWebhookInventoryUpdate.mockReset();
  // Default outcome = `no_identity_row` so pre-existing tests that
  // never stub this keep falling through to the historical
  // `sku_mapping_missing` path.
  mockRehydrateWebhookInventoryUpdate.mockResolvedValue({ kind: "no_identity_row" });
});

const WORKSPACE_ID = "ws-1";
const ORG_ID = "org-1";
const CONNECTION_ID = "conn-1";
const DEFAULT_LOCATION_ID = "67890";
const SKU = "TPR-LP-001";
const REMOTE_INVENTORY_ITEM_ID = "12345";

function seedConnection(extra: Record<string, unknown> = {}) {
  state.connections.set(CONNECTION_ID, {
    id: CONNECTION_ID,
    org_id: ORG_ID,
    workspace_id: WORKSPACE_ID,
    platform: "shopify",
    default_location_id: DEFAULT_LOCATION_ID,
    do_not_fanout: false,
    ...extra,
  });
}

function seedShopifyInventoryEvent(payload: Record<string, unknown>) {
  const eventId = "evt-inv-1";
  state.webhookEvents.set(eventId, {
    id: eventId,
    workspace_id: WORKSPACE_ID,
    platform: "shopify",
    topic: "inventory_levels/update",
    metadata: { connection_id: CONNECTION_ID, payload },
  });
  return eventId;
}

// ──────────────────────────── handleInventoryUpdate ───────────────────────────

describe("handleInventoryUpdate — Shopify inventory_levels/update", () => {
  it("resolves inventory_item_id → SKU via remote_inventory_item_id (HRD-03) and writes delta", async () => {
    seedConnection();
    state.skuMappings.push({
      connection_id: CONNECTION_ID,
      remote_inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      remote_sku: SKU,
      variant_id: "var-1",
      last_pushed_quantity: 99,
    });
    state.inventoryLevels.push({
      workspace_id: WORKSPACE_ID,
      sku: SKU,
      available: 5,
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 7,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, sku: SKU, delta: 2 });
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        sku: SKU,
        delta: 2,
        source: "shopify",
        correlationId: `webhook:shopify:${eventId}`,
        metadata: expect.objectContaining({
          resolved_from_inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
        }),
      }),
    );
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "processed",
    });
  });

  it("HRD-05 wrong_location: persists status='wrong_location' + does NOT call recordInventoryChange", async () => {
    seedConnection();
    state.skuMappings.push({
      connection_id: CONNECTION_ID,
      remote_inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      remote_sku: SKU,
      last_pushed_quantity: null,
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: "11111",
      available: 7,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: false,
      reason: "wrong_location",
      incoming_location_id: "11111",
      expected_location_id: DEFAULT_LOCATION_ID,
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "wrong_location",
    });
  });

  it("echo cancellation: last_pushed_quantity == webhook available → echo_cancelled, no inventory write", async () => {
    seedConnection();
    state.skuMappings.push({
      connection_id: CONNECTION_ID,
      remote_inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      remote_sku: SKU,
      last_pushed_quantity: 7,
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 7,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, reason: "echo_cancelled", sku: SKU });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "echo_cancelled",
    });
  });

  it("missing inventory_item_id mapping: persists status='sku_mapping_missing'", async () => {
    seedConnection();
    // No mapping seeded.

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 7,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: false,
      reason: "sku_mapping_missing",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("missing inventory_item_id field: returns missing_inventory_item_id without DB writes", async () => {
    seedConnection();
    const eventId = seedShopifyInventoryEvent({
      location_id: DEFAULT_LOCATION_ID,
      available: 7,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: false, reason: "missing_inventory_item_id" });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("WooCommerce path preserved: data.sku + data.quantity still resolves", async () => {
    seedConnection({ platform: "woocommerce" });
    state.skuMappings.push({
      connection_id: CONNECTION_ID,
      remote_sku: SKU,
      last_pushed_quantity: null,
    });
    state.inventoryLevels.push({
      workspace_id: WORKSPACE_ID,
      sku: SKU,
      available: 3,
    });

    const eventId = "evt-wc-1";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "woocommerce",
      topic: "stock.updated",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: { sku: SKU, quantity: 10 },
      },
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, sku: SKU, delta: 7 });
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: "woocommerce", delta: 7 }),
    );
  });
});

// ─── handleInventoryUpdate — Phase 4 SKU-AUTO-24 demotion-rehydrate ───
//
// These tests exercise the wiring between `handleInventoryUpdate` and
// the `rehydrateWebhookInventoryUpdate` orchestrator. The orchestrator
// itself is mocked (see vi.mock above) so we can drive each outcome
// branch deterministically without standing up identity rows,
// warehouse levels, stability history, etc. The orchestrator's own
// correctness is covered in tests/unit/lib/server/webhook-rehydrate.test.ts.
//
// Key invariants asserted here:
//   1. The rehydrate orchestrator is called BEFORE the historical
//      `sku_mapping_missing` return, but ONLY when `mappingRow` is
//      missing a `remote_sku` (i.e. no live alias exists).
//   2. `no_identity_row` and `identity_lookup_failed` fall through to
//      the historical `sku_mapping_missing` path so discovery still
//      triggers for genuinely unknown listings.
//   3. Every other outcome halts the handler at a rehydrate-specific
//      `webhook_events.status` and returns a rehydrate-specific
//      `reason` — it NEVER falls through to `sku_mapping_missing`.
//   4. A positive-stock Shopify webhook that resolves to an existing
//      mapping (live alias) does NOT call the rehydrate orchestrator
//      — rehydrate is only for missing mappings.

describe("handleInventoryUpdate — Phase 4 rehydrate branches", () => {
  it("emergency_paused: halts with sku_autonomy_emergency_paused, no inventory write, no fall-through", async () => {
    seedConnection();
    // No mapping seeded → orchestrator is invoked.
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "emergency_paused",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 7,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(mockRehydrateWebhookInventoryUpdate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      processed: false,
      reason: "sku_autonomy_emergency_paused",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "sku_autonomy_emergency_paused",
    });
    // Critical: we MUST NOT also persist `sku_mapping_missing` —
    // emergency_paused is a halt, not a fall-through.
    expect(state.webhookEventStatusUpdates).not.toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("promoted: halts with rehydrate_promoted_alias and surfaces alias/decision/run IDs", async () => {
    seedConnection();
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "promoted",
      aliasId: "alias-42",
      identityMatchId: "identity-42",
      decisionId: "decision-42",
      runId: "run-42",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 12,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    // Orchestrator must be called with the right shape (platform, IDs,
    // identityKeys from inventory_item_id, and a positive stock signal).
    expect(mockRehydrateWebhookInventoryUpdate).toHaveBeenCalledTimes(1);
    const [, orchestratorInput] = mockRehydrateWebhookInventoryUpdate.mock.calls[0] as [
      unknown,
      {
        workspaceId: string;
        connectionId: string;
        platform: string;
        identityKeys: { remoteInventoryItemId?: string };
        inboundStockSignal: { value: number | null; source: string; tier: string };
        webhookEventId: string;
      },
    ];
    expect(orchestratorInput.workspaceId).toBe(WORKSPACE_ID);
    expect(orchestratorInput.connectionId).toBe(CONNECTION_ID);
    expect(orchestratorInput.platform).toBe("shopify");
    expect(orchestratorInput.identityKeys.remoteInventoryItemId).toBe(REMOTE_INVENTORY_ITEM_ID);
    expect(orchestratorInput.inboundStockSignal.value).toBe(12);
    expect(orchestratorInput.inboundStockSignal.source).toBe("shopify_graphql");
    expect(orchestratorInput.webhookEventId).toBe(eventId);

    expect(result).toMatchObject({
      processed: true,
      reason: "rehydrate_promoted_alias",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      alias_id: "alias-42",
      identity_match_id: "identity-42",
      decision_id: "decision-42",
      run_id: "run-42",
    });
    // Promotion is audit-only at the webhook layer — the post-promotion
    // webhook carries the inventory delta, not this one.
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "rehydrate_promoted_alias",
    });
    expect(state.webhookEventStatusUpdates).not.toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("updated_evidence_only: halts with rehydrate_evidence_only + surfaces outcome_state/rationale", async () => {
    seedConnection();
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "updated_evidence_only",
      identityMatchId: "identity-7",
      outcomeState: "auto_database_identity_match",
      rationale: "non-exception state, evidence refreshed",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 5,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: true,
      reason: "rehydrate_evidence_only",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      identity_match_id: "identity-7",
      outcome_state: "auto_database_identity_match",
      rationale: "non-exception state, evidence refreshed",
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "rehydrate_evidence_only",
    });
    expect(state.webhookEventStatusUpdates).not.toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("bumped_reobserved: halts with rehydrate_bumped_evidence for stock_tier_unreliable / gate-failed exceptions", async () => {
    seedConnection();
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "bumped_reobserved",
      identityMatchId: "identity-9",
      rationale: "stock tier unreliable; evidence re-observed",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 3,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: true,
      reason: "rehydrate_bumped_evidence",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      identity_match_id: "identity-9",
      rationale: "stock tier unreliable; evidence re-observed",
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "rehydrate_bumped_evidence",
    });
    expect(state.webhookEventStatusUpdates).not.toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("promotion_blocked: halts with rehydrate_promotion_blocked + surfaces reason/detail/runId", async () => {
    seedConnection();
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "promotion_blocked",
      identityMatchId: "identity-11",
      reason: "optimistic_concurrency_conflict",
      detail: "state_version mismatch on retry",
      runId: "run-11",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 9,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: false,
      reason: "rehydrate_promotion_blocked",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      identity_match_id: "identity-11",
      promotion_reason: "optimistic_concurrency_conflict",
      promotion_detail: "state_version mismatch on retry",
      run_id: "run-11",
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "rehydrate_promotion_blocked",
    });
    expect(state.webhookEventStatusUpdates).not.toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("run_open_failed: halts with rehydrate_run_open_failed + surfaces detail", async () => {
    seedConnection();
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "run_open_failed",
      identityMatchId: "identity-13",
      detail: "supabase insert failed: connection reset",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 6,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: false,
      reason: "rehydrate_run_open_failed",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      identity_match_id: "identity-13",
      detail: "supabase insert failed: connection reset",
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "rehydrate_run_open_failed",
    });
    expect(state.webhookEventStatusUpdates).not.toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("identity_lookup_failed: falls through to sku_mapping_missing (fail-open)", async () => {
    seedConnection();
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "identity_lookup_failed",
      detail: "supabase select timed out",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 4,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    // Fail-open: transient identity-cascade errors MUST NOT block the
    // webhook from reaching the historical discovery path.
    expect(result).toMatchObject({
      processed: false,
      reason: "sku_mapping_missing",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
    // And we should NOT have persisted any rehydrate-specific status.
    expect(state.webhookEventStatusUpdates).not.toContainEqual({
      id: eventId,
      status: "rehydrate_promoted_alias",
    });
  });

  it("no_identity_row: falls through to sku_mapping_missing (genuine unknown listing)", async () => {
    seedConnection();
    mockRehydrateWebhookInventoryUpdate.mockResolvedValueOnce({
      kind: "no_identity_row",
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 2,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: false,
      reason: "sku_mapping_missing",
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
    });
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "sku_mapping_missing",
    });
  });

  it("live alias exists: rehydrate orchestrator is NOT called (rehydrate is for missing mappings only)", async () => {
    seedConnection();
    state.skuMappings.push({
      connection_id: CONNECTION_ID,
      remote_inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      remote_sku: SKU,
      variant_id: "var-1",
      last_pushed_quantity: 99,
    });
    state.inventoryLevels.push({
      workspace_id: WORKSPACE_ID,
      sku: SKU,
      available: 5,
    });

    const eventId = seedShopifyInventoryEvent({
      inventory_item_id: REMOTE_INVENTORY_ITEM_ID,
      location_id: DEFAULT_LOCATION_ID,
      available: 7,
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, sku: SKU, delta: 2 });
    // When the mapping has remote_sku, we take the existing fast path —
    // the rehydrate orchestrator must not be called.
    expect(mockRehydrateWebhookInventoryUpdate).not.toHaveBeenCalled();
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────── handleRefund ───────────────────────────

describe("handleRefund — Shopify refunds/create", () => {
  function seedRefundEvent(refundLineItems: Array<Record<string, unknown>>, refundId = "ref-1") {
    const eventId = "evt-ref-1";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "refunds/create",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: {
          id: refundId,
          order_id: "shopify-order-99",
          refund_line_items: refundLineItems,
        },
      },
    });
    return eventId;
  }

  function seedParentOrder() {
    const orderRow = {
      id: "wh-order-1",
      workspace_id: WORKSPACE_ID,
      external_order_id: "shopify-order-99",
      org_id: ORG_ID,
      fulfillment_status: null,
    };
    state.warehouseOrders.push(orderRow);
    state.warehouseOrderItems.push({
      id: "wh-oi-1",
      order_id: orderRow.id,
      workspace_id: WORKSPACE_ID,
      sku: SKU,
      quantity: 2,
      shopify_line_item_id: "shopify-li-555",
    });
  }

  it("HRD-07.2: empty refund_line_items returns empty_refund_line_items, no inventory write", async () => {
    seedConnection();
    const eventId = seedRefundEvent([]);

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, reason: "empty_refund_line_items" });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.webhookEventStatusUpdates).toContainEqual({
      id: eventId,
      status: "processed",
    });
  });

  it("restock_type='return': re-credits via line-item-id resolution", async () => {
    seedConnection();
    seedParentOrder();

    const eventId = seedRefundEvent([
      {
        id: "rli-1",
        line_item_id: "shopify-li-555",
        restock_type: "return",
        quantity: 1,
      },
    ]);

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, refund_id: "ref-1" });
    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: SKU,
        delta: 1,
        source: "shopify",
        correlationId: `refund:${eventId}:rli-1`,
        metadata: expect.objectContaining({ kind: "refund", refund_id: "ref-1" }),
      }),
    );
  });

  it("restock_type='no_restock': skipped, no inventory write", async () => {
    seedConnection();
    seedParentOrder();

    const eventId = seedRefundEvent([
      {
        id: "rli-2",
        line_item_id: "shopify-li-555",
        restock_type: "no_restock",
        quantity: 1,
      },
    ]);

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ status: string; reason?: string }> };

    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(result.recredits).toHaveLength(1);
    expect(result.recredits[0]).toMatchObject({
      status: "skipped_no_restock",
      reason: "no_restock",
    });
  });

  it("restock_type='cancel': skipped (cancellation path handles credits separately)", async () => {
    seedConnection();
    seedParentOrder();

    const eventId = seedRefundEvent([
      {
        id: "rli-3",
        line_item_id: "shopify-li-555",
        restock_type: "cancel",
        quantity: 2,
      },
    ]);

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ status: string; reason?: string }> };

    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(result.recredits[0]).toMatchObject({
      status: "skipped_no_restock",
      reason: "cancel",
    });
  });

  it("mixed batch: only restock_type='return' rows credit, others reported as skipped", async () => {
    seedConnection();
    seedParentOrder();
    state.warehouseOrderItems.push({
      id: "wh-oi-2",
      order_id: "wh-order-1",
      workspace_id: WORKSPACE_ID,
      sku: "TPR-LP-002",
      quantity: 1,
      shopify_line_item_id: "shopify-li-666",
    });

    const eventId = seedRefundEvent([
      { id: "rli-1", line_item_id: "shopify-li-555", restock_type: "return", quantity: 1 },
      { id: "rli-2", line_item_id: "shopify-li-666", restock_type: "no_restock", quantity: 1 },
    ]);

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ status: string }> };

    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    expect(result.recredits.map((r) => r.status)).toEqual(["ok", "skipped_no_restock"]);
  });

  it("zero quantity is skipped without crediting", async () => {
    seedConnection();
    seedParentOrder();

    const eventId = seedRefundEvent([
      { id: "rli-1", line_item_id: "shopify-li-555", restock_type: "return", quantity: 0 },
    ]);

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ status: string }> };

    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(result.recredits[0]).toMatchObject({ status: "skipped_zero_quantity" });
  });

  it("idempotency: correlationId is stable across retries (refund_line_item.id keyed)", async () => {
    seedConnection();
    seedParentOrder();

    const eventId = seedRefundEvent([
      { id: "rli-1", line_item_id: "shopify-li-555", restock_type: "return", quantity: 1 },
    ]);

    await processClientStoreWebhookTask.run({ webhookEventId: eventId });
    await processClientStoreWebhookTask.run({ webhookEventId: eventId });

    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(2);
    const firstCall = mockRecordInventoryChange.mock.calls[0]?.[0] as { correlationId: string };
    const secondCall = mockRecordInventoryChange.mock.calls[1]?.[0] as { correlationId: string };
    expect(firstCall.correlationId).toBe(secondCall.correlationId);
    expect(firstCall.correlationId).toBe(`refund:${eventId}:rli-1`);
  });

  it("unresolvable SKU surfaces a review_queue row", async () => {
    seedConnection();
    seedParentOrder();

    const eventId = seedRefundEvent([
      // line_item_id has no matching warehouse_order_items row
      { id: "rli-1", line_item_id: "ghost-line-item", restock_type: "return", quantity: 1 },
    ]);

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ status: string }> };

    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(result.recredits[0]).toMatchObject({ status: "sku_unresolved" });
    expect(state.reviewQueueUpserts).toHaveLength(1);
    expect(state.reviewQueueUpserts[0]).toMatchObject({
      category: "refund_partial_apply",
      group_key: `refund_partial:${eventId}`,
    });
  });
});

// ──────────────────────────── handleOrderCancelled ───────────────────────────

describe("handleOrderCancelled — Shopify orders/cancelled", () => {
  function seedCancelEvent(orderId = "shopify-order-99") {
    const eventId = "evt-cancel-1";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "orders/cancelled",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: { id: orderId, cancelled_at: "2026-04-22T12:00:00Z", line_items: [] },
      },
    });
    return eventId;
  }

  function seedActiveOrder() {
    state.warehouseOrders.push({
      id: "wh-order-1",
      workspace_id: WORKSPACE_ID,
      external_order_id: "shopify-order-99",
      org_id: ORG_ID,
      fulfillment_status: null,
    });
    state.warehouseOrderItems.push(
      {
        id: "wh-oi-1",
        order_id: "wh-order-1",
        workspace_id: WORKSPACE_ID,
        sku: SKU,
        quantity: 2,
        shopify_line_item_id: "shopify-li-555",
      },
      {
        id: "wh-oi-2",
        order_id: "wh-order-1",
        workspace_id: WORKSPACE_ID,
        sku: "TPR-LP-002",
        quantity: 1,
        shopify_line_item_id: "shopify-li-666",
      },
    );
  }

  it("re-credits ALL warehouse_order_items + flips fulfillment_status='cancelled'", async () => {
    seedConnection();
    seedActiveOrder();

    const eventId = seedCancelEvent();

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ sku: string; quantity: number; status: string }> };

    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(2);
    expect(result.recredits).toEqual([
      { sku: SKU, quantity: 2, status: "ok" },
      { sku: "TPR-LP-002", quantity: 1, status: "ok" },
    ]);
    expect(state.warehouseOrdersUpdates).toContainEqual(
      expect.objectContaining({
        id: "wh-order-1",
        payload: expect.objectContaining({ fulfillment_status: "cancelled" }),
      }),
    );
  });

  it("correlation prefix 'cancel:' (distinct from original decrement) per line item", async () => {
    seedConnection();
    seedActiveOrder();

    const eventId = seedCancelEvent();
    await processClientStoreWebhookTask.run({ webhookEventId: eventId });

    const calls = mockRecordInventoryChange.mock.calls as Array<[{ correlationId: string }]>;
    expect(calls[0]?.[0].correlationId).toBe(`cancel:${eventId}:${SKU}:shopify-li-555`);
    expect(calls[1]?.[0].correlationId).toBe(`cancel:${eventId}:TPR-LP-002:shopify-li-666`);
  });

  it("second delivery is a no-op via fulfillment_status check (idempotency)", async () => {
    seedConnection();
    seedActiveOrder();
    state.warehouseOrders[0].fulfillment_status = "cancelled";

    const eventId = seedCancelEvent();
    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, reason: "already_cancelled" });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(state.warehouseOrdersUpdates).toHaveLength(0);
  });

  it("order_not_found: returns gracefully (cancel for an order we never ingested)", async () => {
    seedConnection();
    // No warehouse_orders row.

    const eventId = seedCancelEvent();
    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: true,
      reason: "order_not_found",
      remote_order_id: "shopify-order-99",
    });
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
  });

  it("missing order id: returns missing_order_id without writes", async () => {
    seedConnection();
    state.webhookEvents.set("evt-cancel-2", {
      id: "evt-cancel-2",
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "orders/cancelled",
      metadata: { connection_id: CONNECTION_ID, payload: {} },
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: "evt-cancel-2",
    });

    expect(result).toMatchObject({ processed: false, reason: "missing_order_id" });
  });

  // ─── F-1 / HRD-08.1 — partial-cancel recredit triad ─────────────────────
  //
  // Three scenarios, all driven from warehouse_order_items.fulfilled_quantity
  // (DB source-of-truth) and cross-checked against the cancel webhook
  // payload's line_items[].fulfillment_status (telemetry hint only).
  //
  //   none-fulfilled  → recredit FULL quantity, 0 telemetry rows
  //   3-of-5 partial  → recredit (5 - 3) = 2 only, 1 telemetry row
  //   all-fulfilled   → recredit 0,            1 telemetry row per item
  //
  // The triad is the regression fence for the original bug where the cancel
  // handler always recredited the full original quantity and double-credited
  // inventory for items that had already shipped.

  function seedFiveUnitOrder(args: {
    fulfilledOnDb: number;
    webhookFulfillmentStatus?: "fulfilled" | "partial" | null;
  }) {
    state.warehouseOrders.push({
      id: "wh-order-cancel",
      workspace_id: WORKSPACE_ID,
      external_order_id: "shopify-order-cancel",
      org_id: ORG_ID,
      fulfillment_status: null,
    });
    state.warehouseOrderItems.push({
      id: "wh-oi-5pack",
      order_id: "wh-order-cancel",
      workspace_id: WORKSPACE_ID,
      sku: "TPR-LP-5PACK",
      quantity: 5,
      fulfilled_quantity: args.fulfilledOnDb,
      shopify_line_item_id: "shopify-li-5pack",
    });

    const eventId = "evt-cancel-triad";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "orders/cancelled",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: {
          id: "shopify-order-cancel",
          cancelled_at: "2026-04-22T12:00:00Z",
          line_items: [
            {
              id: "shopify-li-5pack",
              quantity: 5,
              ...(args.webhookFulfillmentStatus !== undefined
                ? { fulfillment_status: args.webhookFulfillmentStatus }
                : {}),
            },
          ],
        },
      },
    });
    return eventId;
  }

  it("F-1 none-fulfilled (0 of 5): recredits full quantity, NO telemetry rows", async () => {
    seedConnection();
    const eventId = seedFiveUnitOrder({
      fulfilledOnDb: 0,
      webhookFulfillmentStatus: null,
    });

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ sku: string; quantity: number; status: string }> };

    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "TPR-LP-5PACK",
        delta: 5,
        metadata: expect.objectContaining({
          original_quantity: 5,
          fulfilled_quantity: 0,
          remaining_quantity: 5,
        }),
      }),
    );
    expect(result.recredits).toEqual([{ sku: "TPR-LP-5PACK", quantity: 5, status: "ok" }]);
    // Critical: zero `cancel_after_fulfillment_partial` telemetry rows when
    // nothing was fulfilled.
    expect(
      state.webhookEventsInserts.filter((r) => r.status === "cancel_after_fulfillment_partial"),
    ).toHaveLength(0);
  });

  it("F-1 partial (3 of 5 shipped): recredits remaining 2, emits 1 telemetry row", async () => {
    seedConnection();
    const eventId = seedFiveUnitOrder({
      fulfilledOnDb: 3,
      webhookFulfillmentStatus: "partial",
    });

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as { recredits: Array<{ sku: string; quantity: number; status: string }> };

    expect(mockRecordInventoryChange).toHaveBeenCalledTimes(1);
    expect(mockRecordInventoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "TPR-LP-5PACK",
        delta: 2, // 5 - 3 = 2 remaining
        correlationId: `cancel:${eventId}:TPR-LP-5PACK:shopify-li-5pack`,
        metadata: expect.objectContaining({
          original_quantity: 5,
          fulfilled_quantity: 3,
          remaining_quantity: 2,
        }),
      }),
    );
    expect(result.recredits).toEqual([{ sku: "TPR-LP-5PACK", quantity: 2, status: "ok" }]);

    const telemetry = state.webhookEventsInserts.filter(
      (r) => r.status === "cancel_after_fulfillment_partial",
    );
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      external_webhook_id: `cancel-fulfilled:${eventId}:wh-oi-5pack`,
      topic: "orders/cancelled.cancel_after_fulfillment_partial",
      metadata: expect.objectContaining({
        parent_webhook_event_id: eventId,
        order_id: "wh-order-cancel",
        warehouse_order_item_id: "wh-oi-5pack",
        sku: "TPR-LP-5PACK",
        original_quantity: 5,
        fulfilled_quantity: 3,
        remaining_quantity: 2,
        webhook_fulfillment_status: "partial",
        // 3 fulfilled on DB vs `partial` status (= 0 hint) → disagreement.
        db_webhook_disagree: true,
      }),
    });

    // The warehouse_orders row still flips to cancelled even on a partial.
    expect(state.warehouseOrdersUpdates).toContainEqual(
      expect.objectContaining({
        id: "wh-order-cancel",
        payload: expect.objectContaining({ fulfillment_status: "cancelled" }),
      }),
    );
  });

  it("F-1 all-fulfilled (5 of 5 shipped): NO recredit, telemetry row, status='skipped_already_fulfilled'", async () => {
    seedConnection();
    const eventId = seedFiveUnitOrder({
      fulfilledOnDb: 5,
      webhookFulfillmentStatus: "fulfilled",
    });

    const result = (await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    })) as {
      recredits: Array<{ sku: string; quantity: number; status: string; reason?: string }>;
    };

    // Inventory NEVER touched when everything was already shipped.
    expect(mockRecordInventoryChange).not.toHaveBeenCalled();
    expect(result.recredits).toEqual([
      {
        sku: "TPR-LP-5PACK",
        quantity: 0,
        status: "skipped_already_fulfilled",
        reason: "fulfilled_quantity=5 of 5",
      },
    ]);

    const telemetry = state.webhookEventsInserts.filter(
      (r) => r.status === "cancel_after_fulfillment_partial",
    );
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      external_webhook_id: `cancel-fulfilled:${eventId}:wh-oi-5pack`,
      metadata: expect.objectContaining({
        original_quantity: 5,
        fulfilled_quantity: 5,
        remaining_quantity: 0,
        webhook_fulfillment_status: "fulfilled",
        db_webhook_disagree: false,
      }),
    });

    // Order still moves to cancelled status (cancel succeeded; just no
    // inventory side-effect needed).
    expect(state.warehouseOrdersUpdates).toContainEqual(
      expect.objectContaining({
        id: "wh-order-cancel",
        payload: expect.objectContaining({ fulfillment_status: "cancelled" }),
      }),
    );
  });

  it("F-1 handleOrderCreated populates fulfilled_quantity from line_items[].fulfillment_status", async () => {
    seedConnection();
    const eventId = "evt-orders-create-fulfilled";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "orders/create",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: {
          id: "shopify-order-pre-fulfilled",
          line_items: [
            { id: "li-100", sku: "PREFULL-A", quantity: 3, fulfillment_status: "fulfilled" },
            { id: "li-101", sku: "PREFULL-B", quantity: 2, fulfillment_status: null },
            { id: "li-102", sku: "PREFULL-C", quantity: 1 },
          ],
        },
      },
    });
    state.skuMappings.push(
      {
        connection_id: CONNECTION_ID,
        remote_sku: "PREFULL-A",
        variant_id: "var-A",
        warehouse_product_variants: { sku: "PREFULL-A" },
      },
      {
        connection_id: CONNECTION_ID,
        remote_sku: "PREFULL-B",
        variant_id: "var-B",
        warehouse_product_variants: { sku: "PREFULL-B" },
      },
      {
        connection_id: CONNECTION_ID,
        remote_sku: "PREFULL-C",
        variant_id: "var-C",
        warehouse_product_variants: { sku: "PREFULL-C" },
      },
    );

    // Capture the warehouse_order_items.insert payload by patching the mock.
    const insertedOrderItems: Array<Record<string, unknown>> = [];
    const previousImpl = mockFrom.getMockImplementation();
    mockFrom.mockImplementation((table: string) => {
      if (table === "warehouse_orders") {
        return {
          select: () => ({
            eq: (_col: string, _val: unknown) => ({
              eq: () => ({
                single: async () => ({ data: null, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
          insert: (_payload: Record<string, unknown>) => ({
            select: () => ({
              single: async () => ({
                data: { id: "wh-order-prefulfilled" },
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              state.warehouseOrdersUpdates.push({ id, payload });
              return { data: null, error: null };
            },
          }),
        };
      }
      if (table === "warehouse_order_items") {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            insertedOrderItems.push(...rows);
            return { data: null, error: null };
          },
        };
      }
      return previousImpl ? previousImpl(table) : {};
    });

    await processClientStoreWebhookTask.run({ webhookEventId: eventId });

    expect(insertedOrderItems).toHaveLength(3);
    expect(insertedOrderItems[0]).toMatchObject({
      sku: "PREFULL-A",
      quantity: 3,
      fulfilled_quantity: 3, // fulfillment_status === 'fulfilled' → full qty
    });
    expect(insertedOrderItems[1]).toMatchObject({
      sku: "PREFULL-B",
      quantity: 2,
      fulfilled_quantity: 0, // null status → 0 (conservative)
    });
    expect(insertedOrderItems[2]).toMatchObject({
      sku: "PREFULL-C",
      quantity: 1,
      fulfilled_quantity: 0, // missing status → 0 (conservative)
    });
  });
});

// ──────────────────────────── topic dispatcher ────────────────────────────────

describe("topic dispatcher", () => {
  it("orders/cancelled dispatches to handleOrderCancelled (NOT handleOrderCreated)", async () => {
    seedConnection();
    state.warehouseOrders.push({
      id: "wh-order-1",
      workspace_id: WORKSPACE_ID,
      external_order_id: "shopify-order-99",
      org_id: ORG_ID,
      fulfillment_status: "cancelled",
    });

    const eventId = "evt-cancel-3";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "orders/cancelled",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: { id: "shopify-order-99" },
      },
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, reason: "already_cancelled" });
  });

  it("refunds/create dispatches to handleRefund (NOT unknown_topic)", async () => {
    seedConnection();
    const eventId = "evt-ref-2";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "refunds/create",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: { id: "ref-1", order_id: "shopify-order-99", refund_line_items: [] },
      },
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({ processed: true, reason: "empty_refund_line_items" });
  });

  it("genuinely unknown topic returns unknown_topic", async () => {
    seedConnection();
    const eventId = "evt-mystery";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "themes/publish",
      metadata: { connection_id: CONNECTION_ID, payload: {} },
    });

    const result = await processClientStoreWebhookTask.run({
      webhookEventId: eventId,
    });

    expect(result).toMatchObject({
      processed: false,
      reason: "unknown_topic",
      topic: "themes/publish",
    });
  });
});

// ──────────────── Phase 5 §9.6 D1.b — commit/release wire-up ───────────────────
//
// Asserts that handleOrderCreated opens a commit per (workspace_id,
// orderId, sku) with `source='order'` and that handleOrderCancelled
// releases every open commit for the order. The actual ledger writes
// are mocked via @/lib/server/inventory-commitments — these tests pin
// the CALL CONTRACT so the wire-up cannot drift.
//
// Failure-isolation behavior (commit/release errors land sensor rows
// without failing the handler) is covered by manual production smoke
// tests + the underlying inventory-commitments unit tests; not
// re-asserted here to avoid mocking sensor_readings inserts.

describe("Phase 5 §9.6 D1.b — commit/release wire-up", () => {
  it("handleOrderCreated → commitOrderItems with workspaceId + orderId + items[] (source='order' implied)", async () => {
    seedConnection();
    state.skuMappings.push(
      {
        connection_id: CONNECTION_ID,
        remote_sku: "REMOTE-CMT-A",
        variant_id: "var-A",
        warehouse_product_variants: { sku: "WH-CMT-A" },
      },
      {
        connection_id: CONNECTION_ID,
        remote_sku: "REMOTE-CMT-B",
        variant_id: "var-B",
        warehouse_product_variants: { sku: "WH-CMT-B" },
      },
    );

    // Patch the mock so warehouse_orders.insert returns the new order
    // id (the default mock for unknown tables returns {}). Mirror the
    // pattern the F-1 fulfilled_quantity test uses.
    const previousImpl = mockFrom.getMockImplementation();
    mockFrom.mockImplementation((table: string) => {
      if (table === "warehouse_orders") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: null, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "wh-order-cmt-new" }, error: null }),
            }),
          }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        };
      }
      if (table === "warehouse_order_items") {
        return {
          insert: async () => ({ data: null, error: null }),
        };
      }
      return previousImpl ? previousImpl(table) : {};
    });

    const eventId = "evt-commit-1";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "orders/create",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: {
          id: "shopify-order-cmt-1",
          line_items: [
            { id: 401, sku: "REMOTE-CMT-A", quantity: 2 },
            { id: 402, sku: "REMOTE-CMT-B", quantity: 5 },
          ],
        },
      },
    });

    await processClientStoreWebhookTask.run({ webhookEventId: eventId });

    expect(mockCommitOrderItems).toHaveBeenCalledTimes(1);
    const callArg = mockCommitOrderItems.mock.calls[0][0];
    expect(callArg.workspaceId).toBe(WORKSPACE_ID);
    expect(callArg.orderId).toBe("wh-order-cmt-new");
    // items[] use REMOTE skus (the SKU on the warehouse_order_items
    // row at insert time before mapping resolution); the underlying
    // commitInventory aggregates and forwards. The wire-up contract
    // is just "pass items + orderId".
    expect(callArg.items).toEqual([
      { sku: "REMOTE-CMT-A", qty: 2 },
      { sku: "REMOTE-CMT-B", qty: 5 },
    ]);
    expect(callArg.metadata).toMatchObject({
      platform: "shopify",
      connection_id: CONNECTION_ID,
      remote_order_id: "shopify-order-cmt-1",
      webhook_event_id: eventId,
    });
  });

  it("handleOrderCancelled → releaseOrderItems with workspaceId + orderId + reason='order_cancelled' (source='order' implied)", async () => {
    seedConnection();
    state.warehouseOrders.push({
      id: "wh-order-rel-1",
      workspace_id: WORKSPACE_ID,
      external_order_id: "shopify-order-rel-1",
      org_id: ORG_ID,
      fulfillment_status: null,
    });
    state.warehouseOrderItems.push({
      id: "item-rel-1",
      order_id: "wh-order-rel-1",
      workspace_id: WORKSPACE_ID,
      sku: "WH-REL-A",
      quantity: 3,
      fulfilled_quantity: 0,
      shopify_line_item_id: "601",
    });

    const eventId = "evt-release-1";
    state.webhookEvents.set(eventId, {
      id: eventId,
      workspace_id: WORKSPACE_ID,
      platform: "shopify",
      topic: "orders/cancelled",
      metadata: {
        connection_id: CONNECTION_ID,
        payload: {
          id: "shopify-order-rel-1",
          line_items: [{ id: 601, fulfillment_status: null }],
        },
      },
    });

    await processClientStoreWebhookTask.run({ webhookEventId: eventId });

    expect(mockReleaseOrderItems).toHaveBeenCalledTimes(1);
    expect(mockReleaseOrderItems).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      orderId: "wh-order-rel-1",
      reason: "order_cancelled",
    });
  });
});
