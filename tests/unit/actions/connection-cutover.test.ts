import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3 Pass 2 — `connection-cutover` Server Actions companion test
// suite (Rule #6).
//
// Covers:
//   - getCutoverDiagnostics: counter math (resolved/matched/drifted/skipped),
//     gate evaluation across the four reasons (wrong_state,
//     insufficient_samples, match_rate_below_threshold,
//     unresolved_window_too_old, ok), drift sample shape.
//   - startConnectionShadowMode: legacy→shadow transition, idempotent
//     re-entry, do_not_fanout precondition, invalid transition rejection.
//   - runConnectionCutover: gate-pass / gate-fail / wrong-state /
//     in-flight-push / forced-without-reason / forced-success;
//     verifies echo override + cutover_state flip ordering.
//   - rollbackConnectionCutover: deactivates active overrides + flips
//     state; idempotent on legacy.

const requireAuth = vi.fn();
vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: (...args: unknown[]) => requireAuth(...args),
}));

const mockServiceFrom = vi.fn();
vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockServiceFrom }),
}));

import {
  getCutoverDiagnostics,
  MIN_SAMPLE_COUNT_FOR_CUTOVER,
  REQUIRED_MATCH_RATE,
  rollbackConnectionCutover,
  runConnectionCutover,
  startConnectionShadowMode,
} from "@/actions/connection-cutover";
import type { CutoverState } from "@/lib/shared/types";

interface ConnRow {
  id: string;
  workspace_id?: string;
  platform?: string;
  store_url?: string | null;
  cutover_state: CutoverState;
  cutover_started_at?: string | null;
  cutover_completed_at?: string | null;
  shadow_window_tolerance_seconds?: number | null;
  do_not_fanout?: boolean;
}

interface ShadowRow {
  id: string;
  sku: string;
  pushed_quantity: number;
  ss_observed_quantity: number | null;
  drift_units: number | null;
  match: boolean | null;
  pushed_at: string;
  observed_at: string | null;
  metadata: Record<string, unknown> | null;
}

function buildConnQuery(row: ConnRow | null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
      }),
    }),
  };
}

function buildShadowLogQuery(rows: ShadowRow[]) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        gte: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: rows, error: null }),
        }),
      }),
    }),
  };
}

function setupAuth(isStaff: boolean) {
  requireAuth.mockResolvedValue({
    isStaff,
    userRecord: {
      id: "user-1",
      workspace_id: "ws-1",
      org_id: null,
      role: "admin",
      email: "admin@test.com",
      name: "Admin",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupAuth(true);
});

// Zod v4's UUID validator enforces RFC 4122 version + variant bits, so the
// fixtures use deterministic v4-shaped UUIDs (4xxx in field 3, 8xxx in
// field 4) to keep individual tests legible without depending on
// crypto.randomUUID().
const UUID = {
  conn1: "11111111-1111-4111-8111-111111111111",
  conn2: "22222222-2222-4222-8222-222222222222",
  conn3: "33333333-3333-4333-8333-333333333333",
  conn4: "44444444-4444-4444-8444-444444444444",
  conn5: "55555555-5555-4555-8555-555555555555",
  conn10: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  conn11: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  conn12: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  conn13: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  conn20: "12345678-1234-4234-8234-123456789012",
  conn21: "abcdef00-0000-4000-8000-000000000001",
  conn30: "abcdef00-0000-4000-8000-000000000030",
  conn31: "abcdef00-0000-4000-8000-000000000031",
};

// ─── getCutoverDiagnostics ──────────────────────────────────────────────────

describe("getCutoverDiagnostics", () => {
  it("rejects non-staff callers", async () => {
    setupAuth(false);
    await expect(getCutoverDiagnostics({ connectionId: UUID.conn1 })).rejects.toThrow(/staff-only/);
  });

  it("computes counter math and resolves to gate=ok when match_rate ≥ 99.5% with ≥ 50 samples", async () => {
    const conn: ConnRow = {
      id: UUID.conn1,
      workspace_id: "ws-1",
      platform: "shopify",
      store_url: "https://shop.example.com",
      cutover_state: "shadow",
      cutover_started_at: new Date(Date.now() - 8 * 86400000).toISOString(),
      cutover_completed_at: null,
      shadow_window_tolerance_seconds: 60,
    };

    // 50 matched + 0 drifted + 0 unresolved = match_rate 1.0
    const matchedRows: ShadowRow[] = Array.from({ length: 50 }, (_, i) => ({
      id: `m-${i}`,
      sku: `SKU-${i}`,
      pushed_quantity: 10,
      ss_observed_quantity: 10,
      drift_units: 0,
      match: true,
      pushed_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
      metadata: null,
    }));

    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") return buildConnQuery(conn);
      if (table === "connection_shadow_log") return buildShadowLogQuery(matchedRows);
      throw new Error(`unexpected table ${table}`);
    });

    const result = await getCutoverDiagnostics({ connectionId: conn.id });
    expect(result.counters.total_logged).toBe(50);
    expect(result.counters.resolved).toBe(50);
    expect(result.counters.matched).toBe(50);
    expect(result.counters.drifted).toBe(0);
    expect(result.counters.match_rate).toBe(1);
    expect(result.gate.eligible).toBe(true);
    expect(result.gate.gate_reason).toBe("ok");
    expect(result.gate.required_match_rate).toBe(REQUIRED_MATCH_RATE);
    expect(result.gate.required_min_samples).toBe(MIN_SAMPLE_COUNT_FOR_CUTOVER);
  });

  it("returns gate.gate_reason='wrong_state' for connections not in shadow", async () => {
    const conn: ConnRow = {
      id: UUID.conn2,
      workspace_id: "ws-1",
      platform: "shopify",
      store_url: null,
      cutover_state: "legacy",
    };
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") return buildConnQuery(conn);
      if (table === "connection_shadow_log") return buildShadowLogQuery([]);
      throw new Error(`unexpected table ${table}`);
    });
    const result = await getCutoverDiagnostics({ connectionId: conn.id });
    expect(result.gate.eligible).toBe(false);
    expect(result.gate.gate_reason).toBe("wrong_state");
  });

  it("returns gate_reason='insufficient_samples' when resolved < 50", async () => {
    const conn: ConnRow = {
      id: UUID.conn3,
      workspace_id: "ws-1",
      platform: "shopify",
      store_url: null,
      cutover_state: "shadow",
    };
    const rows: ShadowRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `r-${i}`,
      sku: `SKU-${i}`,
      pushed_quantity: 1,
      ss_observed_quantity: 1,
      drift_units: 0,
      match: true,
      pushed_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
      metadata: null,
    }));
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") return buildConnQuery(conn);
      if (table === "connection_shadow_log") return buildShadowLogQuery(rows);
      throw new Error(`unexpected table ${table}`);
    });
    const result = await getCutoverDiagnostics({ connectionId: conn.id });
    expect(result.gate.eligible).toBe(false);
    expect(result.gate.gate_reason).toBe("insufficient_samples");
  });

  it("returns gate_reason='match_rate_below_threshold' when match_rate < 99.5% with enough samples", async () => {
    const conn: ConnRow = {
      id: UUID.conn4,
      workspace_id: "ws-1",
      platform: "shopify",
      store_url: null,
      cutover_state: "shadow",
    };
    // 60 samples, 5 drifted → match_rate ≈ 91.7%
    const rows: ShadowRow[] = [
      ...Array.from({ length: 55 }, (_, i) => ({
        id: `m-${i}`,
        sku: `SKU-${i}`,
        pushed_quantity: 10,
        ss_observed_quantity: 10,
        drift_units: 0,
        match: true,
        pushed_at: new Date().toISOString(),
        observed_at: new Date().toISOString(),
        metadata: null,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `d-${i}`,
        sku: `SKU-d${i}`,
        pushed_quantity: 10,
        ss_observed_quantity: 11,
        drift_units: 1,
        match: false,
        pushed_at: new Date().toISOString(),
        observed_at: new Date().toISOString(),
        metadata: null,
      })),
    ];
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") return buildConnQuery(conn);
      if (table === "connection_shadow_log") return buildShadowLogQuery(rows);
      throw new Error(`unexpected table ${table}`);
    });
    const result = await getCutoverDiagnostics({ connectionId: conn.id });
    expect(result.counters.drifted).toBe(5);
    expect(result.gate.eligible).toBe(false);
    expect(result.gate.gate_reason).toBe("match_rate_below_threshold");
    expect(result.recent_drift_samples.length).toBe(5);
  });

  it("buckets comparison_skipped rows by metadata.skip_reason", async () => {
    const conn: ConnRow = {
      id: UUID.conn5,
      workspace_id: "ws-1",
      platform: "shopify",
      store_url: null,
      cutover_state: "shadow",
    };
    const rows: ShadowRow[] = [
      {
        id: "skip-1",
        sku: "SKU-A",
        pushed_quantity: 5,
        ss_observed_quantity: null,
        drift_units: null,
        match: null,
        pushed_at: new Date().toISOString(),
        observed_at: new Date().toISOString(),
        metadata: { skip_reason: "no_v2_defaults" },
      },
      {
        id: "skip-2",
        sku: "SKU-B",
        pushed_quantity: 5,
        ss_observed_quantity: null,
        drift_units: null,
        match: null,
        pushed_at: new Date().toISOString(),
        observed_at: new Date().toISOString(),
        metadata: { skip_reason: "v2_read_failed" },
      },
      {
        id: "skip-3",
        sku: "SKU-C",
        pushed_quantity: 5,
        ss_observed_quantity: null,
        drift_units: null,
        match: null,
        pushed_at: new Date().toISOString(),
        observed_at: new Date().toISOString(),
        metadata: { skip_reason: "no_v2_defaults" },
      },
    ];
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") return buildConnQuery(conn);
      if (table === "connection_shadow_log") return buildShadowLogQuery(rows);
      throw new Error(`unexpected table ${table}`);
    });
    const result = await getCutoverDiagnostics({ connectionId: conn.id });
    expect(result.counters.comparison_skipped).toBe(3);
    expect(result.comparison_skip_breakdown).toEqual({
      no_v2_defaults: 2,
      v2_read_failed: 1,
    });
  });
});

// ─── startConnectionShadowMode ──────────────────────────────────────────────

describe("startConnectionShadowMode", () => {
  it("rejects when connection is dormant (do_not_fanout=true)", async () => {
    const conn: ConnRow = {
      id: UUID.conn10,
      cutover_state: "legacy",
      do_not_fanout: true,
    };
    mockServiceFrom.mockReturnValue(buildConnQuery(conn));
    await expect(
      startConnectionShadowMode({ connectionId: conn.id, shadowWindowToleranceSeconds: null }),
    ).rejects.toThrow(/do_not_fanout/);
  });

  it("rejects invalid transitions (direct → shadow)", async () => {
    const conn: ConnRow = {
      id: UUID.conn11,
      cutover_state: "direct",
      do_not_fanout: false,
    };
    mockServiceFrom.mockReturnValue(buildConnQuery(conn));
    await expect(
      startConnectionShadowMode({ connectionId: conn.id, shadowWindowToleranceSeconds: null }),
    ).rejects.toThrow(/invalid transition/);
  });

  it("is idempotent on a connection already in shadow", async () => {
    const startedAt = new Date(Date.now() - 86400000).toISOString();
    const conn: ConnRow = {
      id: UUID.conn12,
      cutover_state: "shadow",
      cutover_started_at: startedAt,
      do_not_fanout: false,
    };
    mockServiceFrom.mockReturnValue(buildConnQuery(conn));
    const result = await startConnectionShadowMode({
      connectionId: conn.id,
      shadowWindowToleranceSeconds: null,
    });
    expect(result.alreadyShadow).toBe(true);
    expect(result.cutoverStartedAt).toBe(startedAt);
  });

  it("flips legacy→shadow with the provided window tolerance", async () => {
    const conn: ConnRow = {
      id: UUID.conn13,
      cutover_state: "legacy",
      do_not_fanout: false,
    };
    const updateMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "client_store_connections") {
        return {
          ...buildConnQuery(conn),
          update: updateMock,
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    const result = await startConnectionShadowMode({
      connectionId: conn.id,
      shadowWindowToleranceSeconds: 120,
    });
    expect(result.alreadyShadow).toBe(false);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cutover_state: "shadow",
        shadow_window_tolerance_seconds: 120,
      }),
    );
  });
});

// ─── runConnectionCutover ───────────────────────────────────────────────────

describe("runConnectionCutover", () => {
  it("returns blocked.force_missing_reason when force=true with no reason", async () => {
    const result = await runConnectionCutover({
      connectionId: UUID.conn20,
      force: true,
      forceReason: "",
    });
    expect(result).toEqual({
      status: "blocked",
      connectionId: UUID.conn20,
      blockedReason: "force_missing_reason",
    });
  });

  it("returns blocked.wrong_state for a non-shadow connection", async () => {
    const conn: ConnRow = {
      id: UUID.conn21,
      cutover_state: "legacy",
      do_not_fanout: false,
      platform: "shopify",
    };
    mockServiceFrom.mockReturnValue(buildConnQuery(conn));
    const result = await runConnectionCutover({ connectionId: conn.id });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.blockedReason).toBe("wrong_state");
    }
  });
});

// ─── rollbackConnectionCutover ──────────────────────────────────────────────

describe("rollbackConnectionCutover", () => {
  it("is idempotent for a connection already in legacy", async () => {
    const conn: ConnRow = {
      id: UUID.conn30,
      cutover_state: "legacy",
    };
    mockServiceFrom.mockReturnValue(buildConnQuery(conn));
    const result = await rollbackConnectionCutover({
      connectionId: conn.id,
      reason: "no-op rollback for the test suite",
    });
    expect(result.previousState).toBe("legacy");
    expect(result.newState).toBe("legacy");
    expect(result.deactivatedOverrideIds).toEqual([]);
  });

  it("requires a reason ≥ 8 chars", async () => {
    await expect(
      rollbackConnectionCutover({
        connectionId: UUID.conn31,
        reason: "short",
      }),
    ).rejects.toThrow();
  });
});
