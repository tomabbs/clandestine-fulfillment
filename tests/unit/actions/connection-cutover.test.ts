/**
 * Phase 3 Pass 2 D3+D4 — connection-cutover Server Actions test suite.
 *
 * Coverage map:
 *   - getCutoverDiagnostics: counter math, gate evaluation (eligible /
 *     wrong_state / insufficient_samples / match_rate_below_threshold),
 *     comparison_skip_breakdown grouping, recent_drift_samples cap.
 *   - runConnectionCutover: gate cascade (wrong_state, force_missing_reason).
 *   - rollbackConnectionCutover: idempotent on already-legacy, Zod reason gate.
 *   - startConnectionShadowMode: idempotent re-call, do_not_fanout pre-flight,
 *     invalid-transition rejection.
 *
 * The supabase mock here uses per-table response queues (FIFO). Each
 * `setTableResponses(table, [...])` enqueues responses; each `from(table)`
 * call dequeues one builder. This lets a single test assert across multiple
 * sequential reads of the same table without the responses bleeding
 * across tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface TableResponse {
  data?: unknown;
  error?: unknown;
}

const tableQueues = new Map<string, TableResponse[]>();

function enqueue(table: string, ...responses: TableResponse[]) {
  if (!tableQueues.has(table)) tableQueues.set(table, []);
  tableQueues.get(table)?.push(...responses);
}

function nextResponse(table: string): TableResponse {
  const q = tableQueues.get(table);
  if (!q || q.length === 0) return { data: null, error: null };
  return q.shift() ?? { data: null, error: null };
}

function makeQueryBuilder(table: string) {
  // Bind the response at the moment from() is called — sequential awaits
  // on the same builder share the same response.
  const resp = nextResponse(table);

  const terminal = async () => ({ data: resp.data ?? null, error: resp.error ?? null });

  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(terminal),
    single: vi.fn(terminal),
  };
  // Make await-able directly (no .single/.maybeSingle) — returns array data.
  (builder as { then: (cb: (v: unknown) => unknown) => Promise<unknown> }).then = (cb) =>
    Promise.resolve({ data: resp.data ?? [], error: resp.error ?? null }).then(cb);

  return builder;
}

const mockServiceFrom = vi.fn((table: string) => makeQueryBuilder(table));
const mockServiceClient = { from: mockServiceFrom };

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: vi.fn() }, from: vi.fn() }),
  createServiceRoleClient: () => mockServiceClient,
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: vi.fn(() =>
    Promise.resolve({
      supabase: { from: vi.fn() },
      authUserId: "auth-1",
      userRecord: {
        id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        org_id: null,
        role: "admin",
        email: "admin@test.com",
        name: "Admin",
      },
      isStaff: true,
    }),
  ),
}));

import {
  getCutoverDiagnostics,
  MIN_SAMPLE_COUNT_FOR_CUTOVER,
  REQUIRED_MATCH_RATE,
  rollbackConnectionCutover,
  runConnectionCutover,
  startConnectionShadowMode,
} from "@/actions/connection-cutover";

const VALID_CONN_ID = "33333333-3333-4333-8333-333333333333";
const VALID_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function shadowLogRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `log-${Math.random().toString(36).slice(2)}`,
    sku: "SKU-1",
    pushed_quantity: 5,
    ss_observed_quantity: 5,
    drift_units: 0,
    match: true,
    pushed_at: new Date().toISOString(),
    observed_at: new Date().toISOString(),
    metadata: null,
    ...overrides,
  };
}

beforeEach(() => {
  tableQueues.clear();
  mockServiceFrom.mockClear();
});

// ---------------------------------------------------------------------------
// getCutoverDiagnostics
// ---------------------------------------------------------------------------

describe("getCutoverDiagnostics", () => {
  it("returns wrong_state gate when connection is in legacy", async () => {
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        workspace_id: VALID_WORKSPACE_ID,
        platform: "shopify",
        store_url: "https://test.myshopify.com",
        cutover_state: "legacy",
        cutover_started_at: null,
        cutover_completed_at: null,
        shadow_window_tolerance_seconds: null,
      },
    });
    enqueue("connection_shadow_log", { data: [] });

    const result = await getCutoverDiagnostics({ connectionId: VALID_CONN_ID });

    expect(result.connection.cutover_state).toBe("legacy");
    expect(result.gate.eligible).toBe(false);
    expect(result.gate.gate_reason).toBe("wrong_state");
    expect(result.counters.total_logged).toBe(0);
  });

  it("returns insufficient_samples when in shadow with too few resolved comparisons", async () => {
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        workspace_id: VALID_WORKSPACE_ID,
        platform: "shopify",
        store_url: null,
        cutover_state: "shadow",
        cutover_started_at: new Date().toISOString(),
        cutover_completed_at: null,
        shadow_window_tolerance_seconds: null,
      },
    });
    enqueue("connection_shadow_log", {
      data: Array.from({ length: 10 }, () => shadowLogRow()),
    });

    const result = await getCutoverDiagnostics({ connectionId: VALID_CONN_ID });
    expect(result.counters.matched).toBe(10);
    expect(result.counters.resolved).toBe(10);
    expect(result.gate.eligible).toBe(false);
    expect(result.gate.gate_reason).toBe("insufficient_samples");
  });

  it("returns match_rate_below_threshold when gate fails on rate", async () => {
    const rows = [
      ...Array.from({ length: 60 }, () => shadowLogRow({ match: true, drift_units: 0 })),
      ...Array.from({ length: 5 }, () =>
        shadowLogRow({ match: false, drift_units: 2, ss_observed_quantity: 7 }),
      ),
    ];
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        workspace_id: VALID_WORKSPACE_ID,
        platform: "shopify",
        store_url: null,
        cutover_state: "shadow",
        cutover_started_at: new Date().toISOString(),
        cutover_completed_at: null,
        shadow_window_tolerance_seconds: null,
      },
    });
    enqueue("connection_shadow_log", { data: rows });

    const result = await getCutoverDiagnostics({ connectionId: VALID_CONN_ID });
    expect(result.counters.resolved).toBe(65);
    expect(result.counters.matched).toBe(60);
    expect(result.counters.drifted).toBe(5);
    expect(result.counters.match_rate).toBeCloseTo(60 / 65);
    expect(result.gate.eligible).toBe(false);
    expect(result.gate.gate_reason).toBe("match_rate_below_threshold");
    expect(result.gate.required_match_rate).toBe(REQUIRED_MATCH_RATE);
  });

  it("returns ok when match_rate meets threshold and samples sufficient", async () => {
    const rows = Array.from({ length: MIN_SAMPLE_COUNT_FOR_CUTOVER + 10 }, () =>
      shadowLogRow({ match: true, drift_units: 0 }),
    );
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        workspace_id: VALID_WORKSPACE_ID,
        platform: "shopify",
        store_url: null,
        cutover_state: "shadow",
        cutover_started_at: new Date().toISOString(),
        cutover_completed_at: null,
        shadow_window_tolerance_seconds: null,
      },
    });
    enqueue("connection_shadow_log", { data: rows });

    const result = await getCutoverDiagnostics({ connectionId: VALID_CONN_ID });
    expect(result.gate.eligible).toBe(true);
    expect(result.gate.gate_reason).toBe("ok");
    expect(result.counters.match_rate).toBe(1);
  });

  it("buckets unresolved + comparison_skipped rows separately and exposes skip breakdown", async () => {
    const rows = [
      ...Array.from({ length: 60 }, () => shadowLogRow({ match: true, drift_units: 0 })),
      shadowLogRow({
        match: null,
        observed_at: null,
        ss_observed_quantity: null,
        drift_units: null,
      }),
      shadowLogRow({
        match: null,
        observed_at: new Date().toISOString(),
        ss_observed_quantity: null,
        drift_units: null,
        metadata: { skip_reason: "no_v2_defaults" },
      }),
      shadowLogRow({
        match: null,
        observed_at: new Date().toISOString(),
        ss_observed_quantity: null,
        drift_units: null,
        metadata: { skip_reason: "v2_read_failed" },
      }),
    ];
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        workspace_id: VALID_WORKSPACE_ID,
        platform: "shopify",
        store_url: null,
        cutover_state: "shadow",
        cutover_started_at: new Date().toISOString(),
        cutover_completed_at: null,
        shadow_window_tolerance_seconds: null,
      },
    });
    enqueue("connection_shadow_log", { data: rows });

    const result = await getCutoverDiagnostics({ connectionId: VALID_CONN_ID });
    expect(result.counters.resolved).toBe(60);
    expect(result.counters.unresolved).toBe(1);
    expect(result.counters.comparison_skipped).toBe(2);
    expect(result.comparison_skip_breakdown).toEqual({
      no_v2_defaults: 1,
      v2_read_failed: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// runConnectionCutover
// ---------------------------------------------------------------------------

describe("runConnectionCutover", () => {
  it("blocks with wrong_state when connection is not in shadow", async () => {
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        platform: "shopify",
        cutover_state: "legacy",
        do_not_fanout: false,
      },
    });

    const result = await runConnectionCutover({ connectionId: VALID_CONN_ID });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.blockedReason).toBe("wrong_state");
    }
  });

  it("blocks with diagnostics_gate_failed when rate is below threshold and force=false", async () => {
    // 1) First runConnectionCutover state lookup
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        platform: "shopify",
        cutover_state: "shadow",
        do_not_fanout: false,
      },
    });
    // 2) getCutoverDiagnostics inner connection lookup
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        workspace_id: VALID_WORKSPACE_ID,
        platform: "shopify",
        store_url: null,
        cutover_state: "shadow",
        cutover_started_at: new Date().toISOString(),
        cutover_completed_at: null,
        shadow_window_tolerance_seconds: null,
      },
    });
    // 3) shadow log query — empty → insufficient_samples
    enqueue("connection_shadow_log", { data: [] });

    const result = await runConnectionCutover({ connectionId: VALID_CONN_ID });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.blockedReason).toBe("diagnostics_gate_failed");
    }
  });

  it("blocks force_missing_reason when force=true but reason is empty", async () => {
    const result = await runConnectionCutover({
      connectionId: VALID_CONN_ID,
      force: true,
      forceReason: null,
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.blockedReason).toBe("force_missing_reason");
    }
  });
});

// ---------------------------------------------------------------------------
// startConnectionShadowMode
// ---------------------------------------------------------------------------

describe("startConnectionShadowMode", () => {
  it("returns alreadyShadow=true when connection is already in shadow state", async () => {
    const startedAt = new Date().toISOString();
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        cutover_state: "shadow",
        cutover_started_at: startedAt,
        do_not_fanout: false,
        shadow_window_tolerance_seconds: null,
      },
    });

    const result = await startConnectionShadowMode({ connectionId: VALID_CONN_ID });
    expect(result.alreadyShadow).toBe(true);
    expect(result.cutoverStartedAt).toBe(startedAt);
  });

  it("rejects when do_not_fanout=true (CHECK constraint pre-flight)", async () => {
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        cutover_state: "legacy",
        cutover_started_at: null,
        do_not_fanout: true,
        shadow_window_tolerance_seconds: null,
      },
    });

    await expect(startConnectionShadowMode({ connectionId: VALID_CONN_ID })).rejects.toThrow(
      /do_not_fanout/,
    );
  });

  it("rejects invalid transition direct→shadow", async () => {
    enqueue("client_store_connections", {
      data: {
        id: VALID_CONN_ID,
        cutover_state: "direct",
        cutover_started_at: null,
        do_not_fanout: false,
        shadow_window_tolerance_seconds: null,
      },
    });

    await expect(startConnectionShadowMode({ connectionId: VALID_CONN_ID })).rejects.toThrow(
      /invalid transition from 'direct'/,
    );
  });
});

// ---------------------------------------------------------------------------
// rollbackConnectionCutover
// ---------------------------------------------------------------------------

describe("rollbackConnectionCutover", () => {
  it("is a no-op when already in legacy state", async () => {
    enqueue("client_store_connections", {
      data: { id: VALID_CONN_ID, cutover_state: "legacy" },
    });

    const result = await rollbackConnectionCutover({
      connectionId: VALID_CONN_ID,
      reason: "abandoning the cutover",
    });
    expect(result.previousState).toBe("legacy");
    expect(result.newState).toBe("legacy");
    expect(result.deactivatedOverrideIds).toEqual([]);
  });

  it("rejects when reason is too short (Zod validation)", async () => {
    await expect(
      rollbackConnectionCutover({ connectionId: VALID_CONN_ID, reason: "no" }),
    ).rejects.toThrow();
  });
});
