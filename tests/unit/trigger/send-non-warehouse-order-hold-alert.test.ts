import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for `send-non-warehouse-order-hold-alert` Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Alert idempotency" (SKU-AUTO-16)
 *       §"Bulk hold suppression and fetch-recovery auto-release" (SKU-AUTO-31)
 *
 * Contract properties covered:
 *   1. Emergency pause short-circuits BEFORE any outbound side-effect.
 *   2. `non_warehouse_order_client_alerts_enabled=false` short-circuits.
 *   3. Stale-hold guard: cycle-id mismatch, hold released, order missing.
 *   4. App-layer idempotency pre-check hits `skipped_already_sent`.
 *   5. Bulk suppression fires `emitOpsAlert` once and returns skipped outcome.
 *   6. Recipient resolution: client users first, fallback to org.support_email.
 *   7. Resend failure → `failed_provider_error` WITHOUT inserting an event.
 *   8. Happy path sends email + inserts `hold_alert_sent` + updates order timestamp.
 *   9. 23505 race on audit insert is swallowed as `skipped_already_sent`.
 *  10. `extractNonWarehouseLines` + `buildHoldAlertBody` pure helpers.
 */

// ──────────────────────────────────────────────────────────────────────
// Mocks — module mocks MUST be declared before importing the task.
// ──────────────────────────────────────────────────────────────────────

type AnyFn = (...args: unknown[]) => unknown;
const mockSendSupportEmail = vi.fn<AnyFn>();
vi.mock("@/lib/clients/resend-client", () => ({
  sendSupportEmail: (...args: unknown[]) => mockSendSupportEmail(...args),
}));

const mockShouldSuppressBulkHold = vi.fn<AnyFn>();
vi.mock("@/lib/server/order-hold-bulk-suppression", async () => {
  // Preserve real module exports (types etc.) but stub the function
  // under test; we do not need anything else from this module.
  return {
    shouldSuppressBulkHold: (...args: unknown[]) => mockShouldSuppressBulkHold(...args),
  };
});

const mockEmitOpsAlert = vi.fn<AnyFn>(async () => ({ sentry: true, slack: "unconfigured" }));
vi.mock("@/lib/server/ops-alert", () => ({
  emitOpsAlert: (...args: unknown[]) => mockEmitOpsAlert(...args),
}));

// Supabase scenario harness — each test builds a tiny state graph that
// the mock "from/select/eq/…" chain walks. We keep it dead simple: a
// scenario is a map from ("tableName" + verb) → canned response, with
// a fallback to `{ data: null, error: null }`.
type Canned = { data: unknown; error: unknown };
const scenario: {
  orderRow: Canned;
  workspaceRow: Canned;
  priorSent: Canned;
  holdApplied: Canned;
  clientUsers: Canned;
  orgRow: Canned;
  insertHoldEvent: Canned;
  updateOrder: Canned;
} = {
  orderRow: { data: null, error: null },
  workspaceRow: { data: null, error: null },
  priorSent: { data: null, error: null },
  holdApplied: { data: null, error: null },
  clientUsers: { data: null, error: null },
  orgRow: { data: null, error: null },
  insertHoldEvent: { data: null, error: null },
  updateOrder: { data: null, error: null },
};

// Track the payload the task tried to insert so tests can assert on it.
let lastInsertPayload: unknown = null;
let lastOrderUpdatePayload: unknown = null;

function resetScenario() {
  scenario.orderRow = { data: null, error: null };
  scenario.workspaceRow = { data: null, error: null };
  scenario.priorSent = { data: null, error: null };
  scenario.holdApplied = { data: null, error: null };
  scenario.clientUsers = { data: null, error: null };
  scenario.orgRow = { data: null, error: null };
  scenario.insertHoldEvent = { data: { id: "evt-new" }, error: null };
  scenario.updateOrder = { data: null, error: null };
  lastInsertPayload = null;
  lastOrderUpdatePayload = null;
}

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => {
    return {
      from(table: string) {
        // Track filters so we can disambiguate the two
        // `order_fulfillment_hold_events` SELECTs (priorSent vs
        // holdApplied) that run against the same table. The only
        // difference is `event_type`.
        const eqFilters: Array<[string, unknown]> = [];
        let _lastUpdatePayload: unknown = null;
        let _lastInsertPayload: unknown = null;

        const chain: {
          [key: string]: unknown;
          select: (..._args: unknown[]) => typeof chain;
          eq: (col: string, val: unknown) => typeof chain;
          in: (..._args: unknown[]) => typeof chain;
          order: (..._args: unknown[]) => typeof chain;
          limit: (..._args: unknown[]) => typeof chain;
          gte: (col: string, val: unknown) => typeof chain;
          maybeSingle: () => Promise<Canned>;
          update: (payload: unknown) => typeof chain;
          insert: (payload: unknown) => typeof chain;
          then: (resolve: (v: Canned) => unknown) => unknown;
        } = {
          select(..._args: unknown[]) {
            return chain;
          },
          eq(col: string, val: unknown) {
            eqFilters.push([col, val]);
            return chain;
          },
          in(..._args: unknown[]) {
            return chain;
          },
          order(..._args: unknown[]) {
            return chain;
          },
          limit(..._args: unknown[]) {
            return chain;
          },
          gte(col: string, val: unknown) {
            eqFilters.push([col, val]);
            return chain;
          },
          update(payload: unknown) {
            _lastUpdatePayload = payload;
            lastOrderUpdatePayload = payload;
            return chain;
          },
          insert(payload: unknown) {
            _lastInsertPayload = payload;
            lastInsertPayload = payload;
            return chain;
          },
          async maybeSingle(): Promise<Canned> {
            if (table === "warehouse_orders") {
              return scenario.orderRow;
            }
            if (table === "workspaces") {
              return scenario.workspaceRow;
            }
            if (table === "organizations") {
              return scenario.orgRow;
            }
            if (table === "order_fulfillment_hold_events") {
              const eventTypeFilter = eqFilters.find(([c]) => c === "event_type");
              if (eventTypeFilter?.[1] === "hold_alert_sent") {
                return scenario.priorSent;
              }
              if (eventTypeFilter?.[1] === "hold_applied") {
                return scenario.holdApplied;
              }
              // insert().select().maybeSingle() path
              return scenario.insertHoldEvent;
            }
            return { data: null, error: null };
          },
          // For the clientUsers query which uses `.in(...)` without
          // `.maybeSingle()`. The Supabase builder is awaitable via
          // implicit thenable; we expose `.then` to resolve.
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock mirroring the Supabase client builder contract
          then(resolve: (v: Canned) => unknown) {
            if (table === "users") {
              return Promise.resolve(scenario.clientUsers).then(resolve);
            }
            // warehouse_orders update path: after .update().eq() we
            // do not call maybeSingle(); we just resolve.
            if (table === "warehouse_orders" && _lastUpdatePayload !== null) {
              return Promise.resolve(scenario.updateOrder).then(resolve);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };

        return chain;
      },
    };
  },
}));

// Trigger SDK stub: return the task definition object directly so
// tests can invoke `.run()` without needing a Trigger runtime.
vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: (payload: unknown) => unknown }) => def,
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ──────────────────────────────────────────────────────────────────────
// Import the SUT AFTER mocks are registered.
// ──────────────────────────────────────────────────────────────────────

import {
  buildHoldAlertBody,
  extractNonWarehouseLines,
  sendNonWarehouseOrderHoldAlertTask,
} from "@/trigger/tasks/send-non-warehouse-order-hold-alert";

interface Payload {
  orderId: string;
  holdCycleId: string;
}

interface TaskResult {
  ok: boolean;
  decision: string;
  orderId: string;
  holdCycleId: string;
  rationale: string;
  recipientCount?: number;
  resendMessageId?: string;
  bulkSuppression?: {
    recent_count: number;
    threshold: number;
    window_minutes: number;
  };
  error?: string;
}

const taskDef = sendNonWarehouseOrderHoldAlertTask as unknown as {
  run: (payload: Payload) => Promise<TaskResult>;
};

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const WS = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const CYCLE = "44444444-4444-4444-8444-444444444444";
const CONN = "55555555-5555-4555-8555-555555555555";

function makeOrderRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ORDER,
    workspace_id: WS,
    org_id: ORG,
    order_number: "#1001",
    source: "shopify",
    fulfillment_hold: "on_hold",
    fulfillment_hold_reason: "fetch_incomplete_at_match",
    fulfillment_hold_cycle_id: CYCLE,
    line_items: [
      { sku: "ALBUM-A", title: "Test LP", quantity: 1, held: true },
      { sku: "ALBUM-B", title: "Warehouse LP", quantity: 1, held: false },
    ],
    ...overrides,
  };
}

function makeWorkspaceRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    flags: { non_warehouse_order_client_alerts_enabled: true },
    sku_autonomous_emergency_paused: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe("send-non-warehouse-order-hold-alert — decision tree", () => {
  beforeEach(() => {
    resetScenario();
    mockSendSupportEmail.mockReset();
    mockSendSupportEmail.mockResolvedValue({ messageId: "resend-msg-1" });
    mockShouldSuppressBulkHold.mockReset();
    mockShouldSuppressBulkHold.mockResolvedValue({
      suppress: false,
      recent_count: 0,
      ops_alert_required: false,
      threshold: 10,
      window_minutes: 15,
    });
    mockEmitOpsAlert.mockClear();
  });

  it("(1) skips when order row is missing — skipped_stale_hold", async () => {
    scenario.orderRow = { data: null, error: null };
    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_stale_hold");
    expect(result.ok).toBe(true);
    expect(mockSendSupportEmail).not.toHaveBeenCalled();
  });

  it("(2) skips when workspace has sku_autonomous_emergency_paused=true", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = {
      data: makeWorkspaceRow({ sku_autonomous_emergency_paused: true }),
      error: null,
    };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_emergency_paused");
    expect(mockSendSupportEmail).not.toHaveBeenCalled();
  });

  it("(3) skips when non_warehouse_order_client_alerts_enabled=false", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = {
      data: makeWorkspaceRow({
        flags: { non_warehouse_order_client_alerts_enabled: false },
      }),
      error: null,
    };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_flag_disabled");
    expect(mockSendSupportEmail).not.toHaveBeenCalled();
  });

  it("(4) skips when order.fulfillment_hold !== 'on_hold'", async () => {
    scenario.orderRow = {
      data: makeOrderRow({ fulfillment_hold: "released" }),
      error: null,
    };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_stale_hold");
    expect(result.rationale).toContain("released");
  });

  it("(5) skips when cycle_id in payload does not match the DB row (rehold)", async () => {
    scenario.orderRow = {
      data: makeOrderRow({ fulfillment_hold_cycle_id: "different-cycle" }),
      error: null,
    };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_stale_hold");
    expect(result.rationale).toContain("cycle_id mismatch");
  });

  it("(6) skips when a hold_alert_sent event already exists (app-layer idempotency)", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.priorSent = { data: { id: "evt-prior" }, error: null };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_already_sent");
    expect(result.rationale).toContain("evt-prior");
    expect(mockSendSupportEmail).not.toHaveBeenCalled();
  });

  it("(7) suppresses + emits ops alert when shouldSuppressBulkHold returns suppress=true", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: {
        id: "evt-hold-applied",
        connection_id: CONN,
        hold_reason: "fetch_incomplete_at_match",
      },
      error: null,
    };
    mockShouldSuppressBulkHold.mockResolvedValueOnce({
      suppress: true,
      recent_count: 15,
      ops_alert_required: true,
      threshold: 10,
      window_minutes: 15,
    });

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_bulk_suppressed");
    expect(result.bulkSuppression).toEqual({
      recent_count: 15,
      threshold: 10,
      window_minutes: 15,
    });
    expect(mockEmitOpsAlert).toHaveBeenCalledTimes(1);
    const opsCall = mockEmitOpsAlert.mock.calls[0]?.[0] as {
      type: string;
      workspaceId: string;
      connectionId: string;
    };
    expect(opsCall.type).toBe("bulk_hold_suppression_active");
    expect(opsCall.workspaceId).toBe(WS);
    expect(opsCall.connectionId).toBe(CONN);
    expect(mockSendSupportEmail).not.toHaveBeenCalled();
  });

  it("(8) skips when no client users AND no org support_email — skipped_no_recipient", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: { id: "e", connection_id: CONN, hold_reason: "fetch_incomplete_at_match" },
      error: null,
    };
    scenario.clientUsers = { data: [], error: null };
    scenario.orgRow = { data: { support_email: null, name: "Org" }, error: null };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_no_recipient");
    expect(mockSendSupportEmail).not.toHaveBeenCalled();
  });

  it("(9) falls back to organizations.support_email when no client users exist", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: { id: "e", connection_id: CONN, hold_reason: "fetch_incomplete_at_match" },
      error: null,
    };
    scenario.clientUsers = { data: [], error: null };
    scenario.orgRow = {
      data: { support_email: "ops@client.example", name: "Client Org" },
      error: null,
    };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("sent");
    expect(mockSendSupportEmail).toHaveBeenCalledTimes(1);
    const [to] = mockSendSupportEmail.mock.calls[0] as [string];
    expect(to).toBe("ops@client.example");
    expect(result.recipientCount).toBe(1);
  });

  it("(10) sends to client_admin + client users when they exist (no fallback)", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: { id: "e", connection_id: CONN, hold_reason: "fetch_incomplete_at_match" },
      error: null,
    };
    scenario.clientUsers = {
      data: [
        { email: "admin@client.example", name: "Admin", role: "client_admin" },
        { email: "buyer@client.example", name: "Buyer", role: "client" },
      ],
      error: null,
    };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("sent");
    const [to, subject, body] = mockSendSupportEmail.mock.calls[0] as [string, string, string];
    expect(to).toContain("admin@client.example");
    expect(to).toContain("buyer@client.example");
    expect(subject).toContain("#1001");
    expect(body).toContain("#1001");
    expect(body).toContain("fetch_incomplete_at_match");
    expect(result.recipientCount).toBe(2);
    expect(result.resendMessageId).toBe("resend-msg-1");
  });

  it("(11) returns failed_provider_error when Resend throws", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: { id: "e", connection_id: CONN, hold_reason: "fetch_incomplete_at_match" },
      error: null,
    };
    scenario.clientUsers = {
      data: [{ email: "client@x.example", name: "C", role: "client" }],
      error: null,
    };
    mockSendSupportEmail.mockRejectedValueOnce(new Error("resend 500"));

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("failed_provider_error");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("resend 500");
    // Audit row must NOT be inserted on failed send.
    expect(lastInsertPayload).toBe(null);
  });

  it("(12) swallows 23505 on audit insert as skipped_already_sent (DB-level idempotency race)", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: { id: "e", connection_id: CONN, hold_reason: "fetch_incomplete_at_match" },
      error: null,
    };
    scenario.clientUsers = {
      data: [{ email: "client@x.example", name: "C", role: "client" }],
      error: null,
    };
    scenario.insertHoldEvent = {
      data: null,
      error: { code: "23505", message: "duplicate key value" },
    };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("skipped_already_sent");
    expect(result.rationale).toContain("23505");
    // Email WAS sent (only the audit insert lost the race).
    expect(mockSendSupportEmail).toHaveBeenCalledTimes(1);
  });

  it("(13) emits ops alert when audit insert fails with non-23505 error after successful send", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: { id: "e", connection_id: CONN, hold_reason: "fetch_incomplete_at_match" },
      error: null,
    };
    scenario.clientUsers = {
      data: [{ email: "client@x.example", name: "C", role: "client" }],
      error: null,
    };
    scenario.insertHoldEvent = {
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("sent");
    expect(mockSendSupportEmail).toHaveBeenCalledTimes(1);
    expect(mockEmitOpsAlert).toHaveBeenCalledTimes(1);
    const opsCall = mockEmitOpsAlert.mock.calls[0]?.[0] as { type: string };
    expect(opsCall.type).toBe("hold_alert_dispatch_failed");
  });

  it("(14) happy-path: sends email, inserts audit row with correct payload, updates order timestamp", async () => {
    scenario.orderRow = { data: makeOrderRow(), error: null };
    scenario.workspaceRow = { data: makeWorkspaceRow(), error: null };
    scenario.holdApplied = {
      data: { id: "e", connection_id: CONN, hold_reason: "fetch_incomplete_at_match" },
      error: null,
    };
    scenario.clientUsers = {
      data: [{ email: "client@x.example", name: "C", role: "client" }],
      error: null,
    };
    scenario.insertHoldEvent = { data: { id: "evt-new" }, error: null };

    const result = await taskDef.run({ orderId: ORDER, holdCycleId: CYCLE });

    expect(result.decision).toBe("sent");
    expect(result.recipientCount).toBe(1);
    expect(mockSendSupportEmail).toHaveBeenCalledTimes(1);

    const insertPayload = lastInsertPayload as Record<string, unknown>;
    expect(insertPayload.workspace_id).toBe(WS);
    expect(insertPayload.order_id).toBe(ORDER);
    expect(insertPayload.hold_cycle_id).toBe(CYCLE);
    expect(insertPayload.event_type).toBe("hold_alert_sent");
    expect(insertPayload.connection_id).toBe(CONN);
    const metadata = insertPayload.metadata as Record<string, unknown>;
    expect(metadata.resend_message_id).toBe("resend-msg-1");
    expect(metadata.recipient_count).toBe(1);
    expect(metadata.kind).toBe("client_alert_dispatched");

    const updatePayload = lastOrderUpdatePayload as Record<string, unknown>;
    expect(updatePayload).toBeTruthy();
    expect(typeof updatePayload.fulfillment_hold_client_alerted_at).toBe("string");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testability)
// ──────────────────────────────────────────────────────────────────────

describe("extractNonWarehouseLines", () => {
  it("returns [] for non-array input", () => {
    expect(extractNonWarehouseLines(null)).toEqual([]);
    expect(extractNonWarehouseLines(undefined)).toEqual([]);
    expect(extractNonWarehouseLines("not an array")).toEqual([]);
    expect(extractNonWarehouseLines(42)).toEqual([]);
  });

  it("returns only held=true lines when any are present", () => {
    const items = [
      { sku: "A", held: true },
      { sku: "B", held: false },
      { sku: "C", held: true },
    ];
    const result = extractNonWarehouseLines(items);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.sku)).toEqual(["A", "C"]);
  });

  it("falls back to ALL object lines when no held flags are set", () => {
    const items = [{ sku: "A" }, { sku: "B" }, null, 42, { sku: "C" }];
    const result = extractNonWarehouseLines(items);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.sku)).toEqual(["A", "B", "C"]);
  });

  it("strips null/non-object lines from the fallback", () => {
    const items = [{ sku: "A" }, null, undefined, "string", 123];
    expect(extractNonWarehouseLines(items)).toEqual([{ sku: "A" }]);
  });
});

describe("buildHoldAlertBody", () => {
  it("includes the order number, reason, source, and order id in the header", () => {
    const body = buildHoldAlertBody({
      orderNumber: "#1001",
      orderId: "order-uuid",
      source: "shopify",
      reason: "fetch_incomplete_at_match",
      nonWarehouseLines: [],
    });

    expect(body).toContain("#1001");
    expect(body).toContain("fetch_incomplete_at_match");
    expect(body).toContain("shopify");
    expect(body).toContain("order-uuid");
  });

  it("emits a placeholder when no lines are provided", () => {
    const body = buildHoldAlertBody({
      orderNumber: "N",
      orderId: "x",
      source: null,
      reason: "unknown",
      nonWarehouseLines: [],
    });
    expect(body).toContain("(no line details available");
    expect(body).toContain("(unknown)");
  });

  it("renders each line with SKU + quantity + title", () => {
    const body = buildHoldAlertBody({
      orderNumber: "N",
      orderId: "x",
      source: "woo",
      reason: "non_warehouse_match",
      nonWarehouseLines: [
        { sku: "LP-1", title: "Album 1", quantity: 2 },
        { sku: "LP-2", title: "Album 2", quantity: 1 },
      ],
    });

    expect(body).toContain("Album 1");
    expect(body).toContain("SKU: LP-1");
    expect(body).toContain("qty: 2");
    expect(body).toContain("Album 2");
    expect(body).toContain("SKU: LP-2");
    expect(body).toContain("qty: 1");
  });

  it("uses (no sku) and (no title) for lines missing those keys", () => {
    const body = buildHoldAlertBody({
      orderNumber: "N",
      orderId: "x",
      source: null,
      reason: "unknown",
      nonWarehouseLines: [{ quantity: 1 }],
    });
    expect(body).toContain("(no sku)");
    expect(body).toContain("(no title)");
  });
});
