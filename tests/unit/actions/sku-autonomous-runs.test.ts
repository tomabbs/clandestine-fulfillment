import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 Slice 6.A — tests for the staff read-model Server Actions.
// Covers: requireStaff gate, filter pass-through, workspace-scoping defense,
// bounded page sizes, ID-only join boundary, and error propagation.

const mockFrom = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ from: mockFrom }),
}));

import {
  getAutonomousRunDetail,
  getVariantDecisionHistory,
  listAutonomousRuns,
} from "@/actions/sku-autonomous-runs";
import { requireStaff } from "@/lib/server/auth-context";

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase query builder — records every call for assertion and lets a
// test programmatically set the terminal resolve value.
// ─────────────────────────────────────────────────────────────────────────────

type TerminalShape = {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
};

function makeQueryBuilder(terminal: TerminalShape | Promise<TerminalShape>) {
  const resolved = Promise.resolve(terminal);
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

  const builder: Record<string, unknown> = {
    select: rec("select"),
    eq: rec("eq"),
    gte: rec("gte"),
    lte: rec("lte"),
    order: rec("order"),
    // `limit` is a terminal for `getVariantDecisionHistory` so we resolve to
    // the programmed shape. The `listAutonomousRuns` / `getAutonomousRunDetail`
    // code paths use `.range()` or `.maybeSingle()` as their terminals.
    limit: (n: number) => {
      calls.push({ method: "limit", args: [n] });
      return resolved;
    },
    range: (from: number, to: number) => {
      calls.push({ method: "range", args: [from, to] });
      return resolved;
    },
    maybeSingle: () => {
      calls.push({ method: "maybeSingle", args: [] });
      return resolved;
    },
  };

  return { builder, calls };
}

describe("listAutonomousRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("requires staff and returns paginated runs with total count", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: [
        {
          id: "run-1",
          workspace_id: "ws-1",
          connection_id: "conn-1",
          trigger_source: "scheduled_periodic",
          dry_run: false,
          status: "completed",
          started_at: "2026-04-26T10:00:00Z",
          completed_at: "2026-04-26T10:05:00Z",
          variants_evaluated: 42,
          outcomes_breakdown: { auto_database_identity_match: 10 },
          candidates_with_no_match: 3,
          candidates_held_for_evidence: 4,
          candidates_with_disqualifiers: 5,
          total_duration_ms: 300000,
          avg_per_variant_ms: 7142,
          error_count: 0,
          cancellation_requested_at: null,
          triggered_by: "cron",
        },
      ],
      count: 137,
      error: null,
    });

    mockFrom.mockReturnValueOnce(builder);

    const result = await listAutonomousRuns({ limit: 25, offset: 0 });

    expect(requireStaff).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledWith("sku_autonomous_runs");
    expect(calls.find((c) => c.method === "eq" && c.args[0] === "workspace_id")).toMatchObject({
      args: ["workspace_id", "ws-1"],
    });
    expect(calls.find((c) => c.method === "range")).toMatchObject({ args: [0, 24] });
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(137);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
  });

  it("propagates every filter to the query builder", async () => {
    const { builder, calls } = makeQueryBuilder({ data: [], count: 0, error: null });
    mockFrom.mockReturnValueOnce(builder);

    await listAutonomousRuns({
      connectionId: "8eb6eccc-2bcb-4d8f-8e21-8ee27d6d7e10",
      status: "running",
      dryRun: true,
      triggerSource: "manual_admin",
      startedAfter: "2026-04-01T00:00:00.000Z",
      startedBefore: "2026-04-30T23:59:59.999Z",
      limit: 10,
      offset: 20,
    });

    const eqCalls = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ["workspace_id", "ws-1"],
        ["connection_id", "8eb6eccc-2bcb-4d8f-8e21-8ee27d6d7e10"],
        ["status", "running"],
        ["dry_run", true],
        ["trigger_source", "manual_admin"],
      ]),
    );
    expect(calls.find((c) => c.method === "gte")).toMatchObject({
      args: ["started_at", "2026-04-01T00:00:00.000Z"],
    });
    expect(calls.find((c) => c.method === "lte")).toMatchObject({
      args: ["started_at", "2026-04-30T23:59:59.999Z"],
    });
    expect(calls.find((c) => c.method === "range")).toMatchObject({ args: [20, 29] });
  });

  it("refuses limit > 100 and offset < 0", async () => {
    await expect(listAutonomousRuns({ limit: 500, offset: 0 })).rejects.toThrow();
    await expect(listAutonomousRuns({ limit: 10, offset: -1 })).rejects.toThrow();
  });

  it("throws Unauthorized when requireStaff rejects", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("Staff access required"));
    await expect(listAutonomousRuns({ limit: 10, offset: 0 })).rejects.toThrow(
      /Staff access required/,
    );
  });

  it("surfaces the Supabase error message through a wrapper Error", async () => {
    const { builder } = makeQueryBuilder({
      data: null,
      count: null,
      error: { message: "boom" },
    });
    mockFrom.mockReturnValueOnce(builder);
    await expect(listAutonomousRuns({ limit: 10, offset: 0 })).rejects.toThrow(
      /listAutonomousRuns failed: boom/,
    );
  });
});

describe("getAutonomousRunDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("returns the run plus a bounded decisions page", async () => {
    const runBuilder = makeQueryBuilder({
      data: {
        id: "run-1",
        workspace_id: "ws-1",
        connection_id: "conn-1",
        trigger_source: "scheduled_periodic",
        dry_run: false,
        feature_flags: { sku_identity_autonomy_enabled: true },
        status: "completed",
        started_at: "2026-04-26T10:00:00Z",
        completed_at: "2026-04-26T10:05:00Z",
        variants_evaluated: 2,
        outcomes_breakdown: {},
        candidates_with_no_match: 0,
        candidates_held_for_evidence: 0,
        candidates_with_disqualifiers: 0,
        total_duration_ms: 300000,
        avg_per_variant_ms: 150000,
        error_count: 0,
        error_log: [],
        cancellation_requested_at: null,
        cancellation_requested_by: null,
        cancellation_reason: null,
        triggered_by: "cron",
      },
      error: null,
    });
    const decisionsBuilder = makeQueryBuilder({
      data: [
        {
          id: "dec-1",
          run_id: "run-1",
          workspace_id: "ws-1",
          connection_id: "conn-1",
          variant_id: "var-1",
          outcome_state: "auto_database_identity_match",
          previous_outcome_state: null,
          outcome_changed: true,
          match_method: "title_vendor_format",
          match_confidence: "strong",
          reason_code: "evidence_pass",
          evidence_snapshot: {},
          evidence_hash: "abc",
          disqualifiers: [],
          top_candidates: [],
          fetch_status: "ok",
          fetch_completed_at: "2026-04-26T10:00:01Z",
          fetch_duration_ms: 1000,
          alias_id: null,
          identity_match_id: "id-1",
          transition_id: "t-1",
          decided_at: "2026-04-26T10:00:01Z",
        },
      ],
      count: 2,
      error: null,
    });

    mockFrom.mockReturnValueOnce(runBuilder.builder).mockReturnValueOnce(decisionsBuilder.builder);

    const result = await getAutonomousRunDetail({
      runId: "11111111-1111-4111-8111-111111111111",
      decisionsLimit: 50,
      decisionsOffset: 0,
    });

    expect(mockFrom).toHaveBeenNthCalledWith(1, "sku_autonomous_runs");
    expect(mockFrom).toHaveBeenNthCalledWith(2, "sku_autonomous_decisions");
    expect(runBuilder.calls.some((c) => c.method === "maybeSingle")).toBe(true);
    expect(
      runBuilder.calls.find((c) => c.method === "eq" && c.args[0] === "workspace_id"),
    ).toBeTruthy();
    expect(decisionsBuilder.calls.find((c) => c.method === "range")).toMatchObject({
      args: [0, 49],
    });
    expect(result.run.id).toBe("run-1");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisionsTotal).toBe(2);
  });

  it("throws 'Run not found' when workspace-scoped read returns null", async () => {
    const runBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(runBuilder.builder);
    await expect(
      getAutonomousRunDetail({
        runId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow(/Run not found/);
  });

  it("surfaces decision-read errors after a successful run read", async () => {
    const runBuilder = makeQueryBuilder({
      data: {
        id: "run-1",
        workspace_id: "ws-1",
        connection_id: null,
        trigger_source: "scheduled_periodic",
        dry_run: true,
        feature_flags: {},
        status: "completed",
        started_at: "2026-04-26T10:00:00Z",
        completed_at: "2026-04-26T10:05:00Z",
        variants_evaluated: 0,
        outcomes_breakdown: {},
        candidates_with_no_match: 0,
        candidates_held_for_evidence: 0,
        candidates_with_disqualifiers: 0,
        total_duration_ms: 0,
        avg_per_variant_ms: null,
        error_count: 0,
        error_log: [],
        cancellation_requested_at: null,
        cancellation_requested_by: null,
        cancellation_reason: null,
        triggered_by: "cron",
      },
      error: null,
    });
    const decBuilder = makeQueryBuilder({
      data: null,
      count: null,
      error: { message: "dec-fail" },
    });
    mockFrom.mockReturnValueOnce(runBuilder.builder).mockReturnValueOnce(decBuilder.builder);

    await expect(
      getAutonomousRunDetail({ runId: "33333333-3333-4333-8333-333333333333" }),
    ).rejects.toThrow(/getAutonomousRunDetail decisions read failed: dec-fail/);
  });

  it("caps decisionsLimit at 500", async () => {
    await expect(
      getAutonomousRunDetail({
        runId: "44444444-4444-4444-8444-444444444444",
        decisionsLimit: 1000,
      }),
    ).rejects.toThrow();
  });
});

describe("getVariantDecisionHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  });

  it("returns decisions joined to their run trigger_source and dry_run", async () => {
    const { builder, calls } = makeQueryBuilder({
      data: [
        {
          id: "dec-1",
          run_id: "run-1",
          workspace_id: "ws-1",
          connection_id: "conn-1",
          variant_id: "var-1",
          outcome_state: "auto_database_identity_match",
          previous_outcome_state: null,
          outcome_changed: true,
          match_method: "title_vendor_format",
          match_confidence: "strong",
          reason_code: "evidence_pass",
          evidence_snapshot: {},
          evidence_hash: "hash",
          disqualifiers: [],
          top_candidates: [],
          fetch_status: "ok",
          fetch_completed_at: "2026-04-26T10:00:01Z",
          fetch_duration_ms: 1000,
          alias_id: null,
          identity_match_id: "id-1",
          transition_id: "t-1",
          decided_at: "2026-04-26T10:00:01Z",
          sku_autonomous_runs: { trigger_source: "manual_admin", dry_run: false },
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);

    const result = await getVariantDecisionHistory({
      variantId: "55555555-5555-4555-8555-555555555555",
    });

    expect(mockFrom).toHaveBeenCalledWith("sku_autonomous_decisions");
    expect(calls.find((c) => c.method === "eq" && c.args[0] === "workspace_id")).toBeTruthy();
    expect(calls.find((c) => c.method === "limit")).toMatchObject({ args: [50] });
    expect(result).toHaveLength(1);
    expect(result[0].run_trigger_source).toBe("manual_admin");
    expect(result[0].run_dry_run).toBe(false);
  });

  it("unwraps array join shape when supabase returns it as an array", async () => {
    const { builder } = makeQueryBuilder({
      data: [
        {
          id: "dec-2",
          run_id: "run-2",
          workspace_id: "ws-1",
          connection_id: "conn-1",
          variant_id: "var-2",
          outcome_state: "auto_shadow_identity_match",
          previous_outcome_state: null,
          outcome_changed: false,
          match_method: null,
          match_confidence: null,
          reason_code: null,
          evidence_snapshot: {},
          evidence_hash: null,
          disqualifiers: [],
          top_candidates: [],
          fetch_status: "ok",
          fetch_completed_at: null,
          fetch_duration_ms: null,
          alias_id: null,
          identity_match_id: null,
          transition_id: null,
          decided_at: "2026-04-26T10:00:01Z",
          sku_autonomous_runs: [{ trigger_source: "scheduled_periodic", dry_run: true }],
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder);

    const result = await getVariantDecisionHistory({
      variantId: "66666666-6666-4666-8666-666666666666",
    });

    expect(result[0].run_trigger_source).toBe("scheduled_periodic");
    expect(result[0].run_dry_run).toBe(true);
  });

  it("caps limit at 100", async () => {
    await expect(
      getVariantDecisionHistory({
        variantId: "77777777-7777-4777-8777-777777777777",
        limit: 500,
      }),
    ).rejects.toThrow();
  });
});
