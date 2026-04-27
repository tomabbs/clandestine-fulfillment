import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 7 Slice 7.C — tests for the autonomous SKU matching rollout page
// Server Actions (getAutonomousRolloutHealth / createAutonomousCanaryReview /
// resolveAutonomousCanaryReview).
//
// Mirrors the builder-mock shape used by sku-autonomous-canary.test.ts with
// one extension: `.single()` is added as a terminal so the insert-then-read
// chain used by createAutonomousCanaryReview can resolve. Every `from()`
// call pulls the next-enqueued terminal shape from the builder queue; this
// keeps per-test mocking tightly scoped to "first read, then write".
//
// Coverage targets (Rule "every action has a companion .test.ts"):
//   - requireStaff gate surfaces on every export
//   - getAutonomousRolloutHealth aggregates flags / emergency pause /
//     telemetry / canary review / linkage without throwing on partial
//     failure (each panel degrades to a typed marker instead)
//   - createAutonomousCanaryReview applies defaults (intendedFlag + title),
//     enforces Zod bounds, writes category / severity / metadata, and
//     revalidates the rollout + feature-flags pages on success
//   - resolveAutonomousCanaryReview enforces workspace ownership, detects
//     already-resolved rows, writes resolved_by, invalidates the flag
//     cache, and revalidates both pages

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const revalidatePathMock = vi.fn();
const invalidateWorkspaceFlagsMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
}));

vi.mock("@/lib/server/workspace-flags", () => ({
  invalidateWorkspaceFlags: (...args: unknown[]) => invalidateWorkspaceFlagsMock(...args),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ from: mockFrom, rpc: mockRpc }),
}));

import {
  createAutonomousCanaryReview,
  getAutonomousRolloutHealth,
  resolveAutonomousCanaryReview,
} from "@/actions/sku-autonomous-rollout";
import { requireStaff } from "@/lib/server/auth-context";

// ─────────────────────────────────────────────────────────────────────────────
// Query-builder mock.
// Every terminal (`.limit()`, `.maybeSingle()`, `.single()`, `.update().eq()`,
// `.insert().select().single()`) resolves to the same TerminalShape passed
// into `makeQueryBuilder(...)`.
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
    eq: (column: string, value: unknown) => {
      calls.push({ method: "eq", args: [column, value] });
      return {
        ...builder,
        // biome-ignore lint/suspicious/noThenProperty: Supabase's PostgrestBuilder is intentionally thenable — calling `.eq()` as a terminal (`.update().eq(...)`) awaits the response.
        then: (onFulfilled: (v: TerminalShape) => unknown, onRejected?: (e: unknown) => unknown) =>
          resolved.then(onFulfilled, onRejected),
      };
    },
    order: rec("order"),
    limit: (n: number) => {
      calls.push({ method: "limit", args: [n] });
      return resolved;
    },
    maybeSingle: () => {
      calls.push({ method: "maybeSingle", args: [] });
      return resolved;
    },
    single: () => {
      calls.push({ method: "single", args: [] });
      return resolved;
    },
    update: rec("update"),
    insert: rec("insert"),
  };

  return { builder, calls };
}

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAutonomousRolloutHealth
// ─────────────────────────────────────────────────────────────────────────────

describe("getAutonomousRolloutHealth", () => {
  it("requires a staff context (rejection bubbles)", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("not staff"));
    await expect(getAutonomousRolloutHealth()).rejects.toThrow(/not staff/);
  });

  it("projects flags + emergency pause from the workspace row and defaults missing flags to false", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: { sku_autonomous_ui_enabled: true },
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({
      data: [
        {
          total_canonical_variants: 100,
          variants_with_bandcamp_mapping: 80,
          variants_with_verified_bandcamp_url: 70,
          variants_with_option_evidence: 45,
          linkage_rate: 0.8,
          verified_rate: 0.7,
          option_rate: 0.45,
        },
      ],
      error: null,
    });

    const result = await getAutonomousRolloutHealth();

    expect(result.workspaceId).toBe("ws-1");
    expect(result.flags.sku_autonomous_ui_enabled).toBe(true);
    // All other flags default to false even when key missing from row.
    expect(result.flags.sku_identity_autonomy_enabled).toBe(false);
    expect(result.flags.sku_live_alias_autonomy_enabled).toBe(false);
    expect(result.flags.non_warehouse_order_hold_enabled).toBe(false);
    expect(result.flags.non_warehouse_order_client_alerts_enabled).toBe(false);
    expect(result.flags.client_stock_exception_reports_enabled).toBe(false);
    expect(result.emergencyPause.paused).toBe(false);
    expect(result.emergencyPause.pausedAt).toBeNull();
    expect(result.emergencyPause.reason).toBeNull();
    expect(result.telemetry.kind).toBe("missing");
    expect(result.canaryReview.kind).toBe("missing");
    expect(result.linkage.kind).toBe("ok");
    if (result.linkage.kind === "ok") {
      expect(result.linkage.allClear).toBe(true);
      expect(result.linkage.thresholds.linkage_rate).toBe(0.7);
    }
  });

  it("surfaces an emergency-paused workspace with reason + pausedAt", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: true,
        sku_autonomous_emergency_paused_at: "2026-04-26T00:00:00Z",
        sku_autonomous_emergency_paused_reason: "client_alerts_spike",
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    const result = await getAutonomousRolloutHealth();

    expect(result.emergencyPause.paused).toBe(true);
    expect(result.emergencyPause.pausedAt).toBe("2026-04-26T00:00:00Z");
    expect(result.emergencyPause.reason).toBe("client_alerts_spike");
  });

  it("returns telemetry.kind=error when the sensor row is missing its summary payload", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    // Row exists but value has no `summary`.
    const sensorBuilder = makeQueryBuilder({
      data: [
        {
          status: "healthy",
          value: { identity_counts: null },
          created_at: "2026-04-26T00:00:00Z",
          message: null,
        },
      ],
      error: null,
    });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    const result = await getAutonomousRolloutHealth();

    expect(result.telemetry.kind).toBe("error");
    if (result.telemetry.kind === "error") {
      expect(result.telemetry.detail).toMatch(/summary/);
    }
  });

  it("returns telemetry.kind=error when the sensor query errors", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({
      data: null,
      error: { message: "sensor_readings unavailable" },
    });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    const result = await getAutonomousRolloutHealth();

    expect(result.telemetry.kind).toBe("error");
    if (result.telemetry.kind === "error") {
      expect(result.telemetry.detail).toMatch(/sensor_readings/);
    }
  });

  it("projects a healthy telemetry row with reasons, summary, identity counts, and truncation flags", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({
      data: [
        {
          status: "warning",
          value: {
            summary: {
              windowStart: "2026-03-27T00:00:00Z",
              windowEnd: "2026-04-26T00:00:00Z",
              windowDays: 30,
              status: "warning",
              reasons: ["demotion_rate_above_threshold"],
              reasonDetails: { demotion_rate_above_threshold: { value: 0.05, threshold: 0.02 } },
              runsTotal: 30,
              runsFailed: 1,
              runsCompleted: 28,
              decisionsTotal: 120,
              promotionsInWindow: 5,
              demotionsInWindow: 3,
              holdsAppliedCycles: 2,
              holdsReleasedCycles: 1,
              holdReleasedRate: 0.5,
              clientAlertsSent: 4,
            },
            identity_counts: {
              shadow_candidates: 40,
              stock_exception: 10,
              holdout: 2,
            },
            truncated: { runs: false, decisions: true, transitions: false, hold_events: false },
            emergency_paused: false,
          },
          created_at: "2026-04-26T01:00:00Z",
          message: "warning",
        },
      ],
      error: null,
    });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    const result = await getAutonomousRolloutHealth();

    expect(result.telemetry.kind).toBe("ok");
    if (result.telemetry.kind !== "ok") return;
    expect(result.telemetry.status).toBe("warning");
    expect(result.telemetry.reasons).toEqual(["demotion_rate_above_threshold"]);
    expect(result.telemetry.windowDays).toBe(30);
    expect(result.telemetry.summary.runsTotal).toBe(30);
    expect(result.telemetry.identityCounts?.shadow_candidates).toBe(40);
    expect(result.telemetry.truncated.decisions).toBe(true);
    expect(result.telemetry.truncated.runs).toBe(false);
    expect(result.telemetry.emergencyPausedAtRecord).toBe(false);
    expect(result.telemetry.recordedAt).toBe("2026-04-26T01:00:00Z");
  });

  it("projects a resolved canary review with intendedFlag metadata", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({
      data: [
        {
          id: REVIEW_ID,
          status: "resolved",
          resolved_at: "2026-04-26T00:00:00Z",
          resolved_by: "user-2",
          title: "Canary sign-off — enable Phase 7 live-alias autonomy",
          description: "all clear",
          metadata: { intended_flag: "sku_live_alias_autonomy_enabled" },
          created_at: "2026-04-25T00:00:00Z",
        },
      ],
      error: null,
    });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    const result = await getAutonomousRolloutHealth();

    expect(result.canaryReview.kind).toBe("resolved");
    if (result.canaryReview.kind !== "resolved") return;
    expect(result.canaryReview.id).toBe(REVIEW_ID);
    expect(result.canaryReview.resolvedAt).toBe("2026-04-26T00:00:00Z");
    expect(result.canaryReview.resolvedBy).toBe("user-2");
    expect(result.canaryReview.note).toBe("all clear");
    expect(result.canaryReview.intendedFlag).toBe("sku_live_alias_autonomy_enabled");
  });

  it("projects an open canary review as kind=open with status", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({
      data: [
        {
          id: REVIEW_ID,
          status: "in_progress",
          resolved_at: null,
          resolved_by: null,
          title: "Canary sign-off required",
          description: null,
          metadata: { intended_flag: "sku_identity_autonomy_enabled" },
          created_at: "2026-04-25T00:00:00Z",
        },
      ],
      error: null,
    });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    const result = await getAutonomousRolloutHealth();

    expect(result.canaryReview.kind).toBe("open");
    if (result.canaryReview.kind !== "open") return;
    expect(result.canaryReview.status).toBe("in_progress");
    expect(result.canaryReview.intendedFlag).toBe("sku_identity_autonomy_enabled");
  });

  it("returns linkage.kind=unavailable when the workspace row has no org_id", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: null,
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);

    const result = await getAutonomousRolloutHealth();

    expect(result.linkage.kind).toBe("unavailable");
    if (result.linkage.kind !== "unavailable") return;
    expect(result.linkage.detail).toMatch(/org_id/);
    // Linkage RPC must NOT be called when org_id is missing.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns linkage.kind=unavailable when the RPC errors", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "rpc_boom" },
    });

    const result = await getAutonomousRolloutHealth();

    expect(result.linkage.kind).toBe("unavailable");
    if (result.linkage.kind !== "unavailable") return;
    expect(result.linkage.detail).toBe("rpc_boom");
  });

  it("flags linkage.allClear=false when any metric dips below threshold", async () => {
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        flags: {},
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);
    mockRpc.mockResolvedValueOnce({
      data: [
        {
          total_canonical_variants: 100,
          variants_with_bandcamp_mapping: 72,
          variants_with_verified_bandcamp_url: 55, // below 0.60 verified threshold
          variants_with_option_evidence: 42,
          linkage_rate: 0.72,
          verified_rate: 0.55,
          option_rate: 0.42,
        },
      ],
      error: null,
    });

    const result = await getAutonomousRolloutHealth();

    expect(result.linkage.kind).toBe("ok");
    if (result.linkage.kind !== "ok") return;
    expect(result.linkage.allClear).toBe(false);
    expect(result.linkage.metrics.verified_rate).toBe(0.55);
  });

  it("tolerates a missing workspace row (all defaults + linkage unavailable)", async () => {
    const workspaceBuilder = makeQueryBuilder({ data: null, error: null });
    const sensorBuilder = makeQueryBuilder({ data: [], error: null });
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(sensorBuilder.builder)
      .mockReturnValueOnce(reviewBuilder.builder);

    const result = await getAutonomousRolloutHealth();

    expect(result.flags.sku_autonomous_ui_enabled).toBe(false);
    expect(result.emergencyPause.paused).toBe(false);
    expect(result.linkage.kind).toBe("unavailable");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAutonomousCanaryReview
// ─────────────────────────────────────────────────────────────────────────────

describe("createAutonomousCanaryReview", () => {
  it("requires a staff context (rejection bubbles)", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("not staff"));
    await expect(createAutonomousCanaryReview({})).rejects.toThrow(/not staff/);
  });

  it("defaults intendedFlag to sku_live_alias_autonomy_enabled and derives a title", async () => {
    const insertBuilder = makeQueryBuilder({
      data: { id: REVIEW_ID, created_at: "2026-04-26T00:00:00Z" },
      error: null,
    });
    mockFrom.mockReturnValueOnce(insertBuilder.builder);

    const result = await createAutonomousCanaryReview({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviewId).toBe(REVIEW_ID);
    expect(result.createdAt).toBe("2026-04-26T00:00:00Z");
    expect(mockFrom).toHaveBeenCalledWith("warehouse_review_queue");

    const insertCall = insertBuilder.calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();
    const payload = insertCall?.args[0] as {
      workspace_id: string;
      category: string;
      severity: string;
      status: string;
      title: string;
      description: string | null;
      metadata: { intended_flag: string; created_by: string; note: string | null };
    };
    expect(payload.workspace_id).toBe("ws-1");
    expect(payload.category).toBe("sku_autonomous_canary_review");
    expect(payload.severity).toBe("high");
    expect(payload.status).toBe("open");
    expect(payload.title).toContain("Phase 7 live-alias autonomy");
    expect(payload.description).toBeNull();
    expect(payload.metadata.intended_flag).toBe("sku_live_alias_autonomy_enabled");
    expect(payload.metadata.created_by).toBe("user-1");
    expect(payload.metadata.note).toBeNull();

    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/sku-matching/rollout");
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/feature-flags");
  });

  it("derives a flag-specific title for each intendedFlag", async () => {
    const flagsAndTitles: Array<[string, RegExp]> = [
      ["sku_identity_autonomy_enabled", /Phase 2 identity autonomy/],
      ["sku_live_alias_autonomy_enabled", /Phase 7 live-alias autonomy/],
      ["non_warehouse_order_hold_enabled", /Phase 4 order holds/],
      ["non_warehouse_order_client_alerts_enabled", /Phase 5 client alerts/],
    ];

    for (const [flag, titleRegex] of flagsAndTitles) {
      const builder = makeQueryBuilder({
        data: { id: REVIEW_ID, created_at: "2026-04-26T00:00:00Z" },
        error: null,
      });
      mockFrom.mockReturnValueOnce(builder.builder);

      await createAutonomousCanaryReview({
        intendedFlag: flag as
          | "sku_identity_autonomy_enabled"
          | "sku_live_alias_autonomy_enabled"
          | "non_warehouse_order_hold_enabled"
          | "non_warehouse_order_client_alerts_enabled",
      });

      const insertCall = builder.calls.find((c) => c.method === "insert");
      const payload = insertCall?.args[0] as { title: string; metadata: { intended_flag: string } };
      expect(payload.title).toMatch(titleRegex);
      expect(payload.metadata.intended_flag).toBe(flag);
    }
  });

  it("uses the operator-supplied title and note when provided", async () => {
    const builder = makeQueryBuilder({
      data: { id: REVIEW_ID, created_at: "2026-04-26T00:00:00Z" },
      error: null,
    });
    mockFrom.mockReturnValueOnce(builder.builder);

    await createAutonomousCanaryReview({
      intendedFlag: "sku_identity_autonomy_enabled",
      title: "bespoke canary window",
      note: "sign-off pending telemetry review",
    });

    const insertCall = builder.calls.find((c) => c.method === "insert");
    const payload = insertCall?.args[0] as {
      title: string;
      description: string | null;
      metadata: { note: string | null };
    };
    expect(payload.title).toBe("bespoke canary window");
    expect(payload.description).toBe("sign-off pending telemetry review");
    expect(payload.metadata.note).toBe("sign-off pending telemetry review");
  });

  it("rejects inputs that exceed the Zod bounds", async () => {
    await expect(
      createAutonomousCanaryReview({
        title: "x".repeat(201),
      }),
    ).rejects.toThrow();
    await expect(
      createAutonomousCanaryReview({
        note: "n".repeat(4001),
      }),
    ).rejects.toThrow();
    await expect(
      createAutonomousCanaryReview({
        // Invalid enum value.
        intendedFlag: "unknown_flag" as unknown as "sku_identity_autonomy_enabled",
      }),
    ).rejects.toThrow();
  });

  it("returns ok=false when the insert errors (no revalidation fires)", async () => {
    const builder = makeQueryBuilder({
      data: null,
      error: { message: "rls_denied" },
    });
    mockFrom.mockReturnValueOnce(builder.builder);

    const result = await createAutonomousCanaryReview({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("rls_denied");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("returns ok=false when insert succeeds but returns no row", async () => {
    const builder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(builder.builder);

    const result = await createAutonomousCanaryReview({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("insert_returned_no_row");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAutonomousCanaryReview
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAutonomousCanaryReview", () => {
  it("requires a staff context (rejection bubbles)", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("not staff"));
    await expect(resolveAutonomousCanaryReview({ reviewId: REVIEW_ID })).rejects.toThrow(
      /not staff/,
    );
  });

  it("rejects a non-UUID reviewId", async () => {
    await expect(resolveAutonomousCanaryReview({ reviewId: "not-a-uuid" })).rejects.toThrow();
  });

  it("rejects an overlong resolution note", async () => {
    await expect(
      resolveAutonomousCanaryReview({
        reviewId: REVIEW_ID,
        resolutionNote: "x".repeat(4001),
      }),
    ).rejects.toThrow();
  });

  it("returns ok=false when the review read errors", async () => {
    const readBuilder = makeQueryBuilder({
      data: null,
      error: { message: "read_boom" },
    });
    mockFrom.mockReturnValueOnce(readBuilder.builder);

    const result = await resolveAutonomousCanaryReview({ reviewId: REVIEW_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/read_boom/);
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect(invalidateWorkspaceFlagsMock).not.toHaveBeenCalled();
  });

  it("returns ok=false when the review row does not exist in the caller's workspace", async () => {
    const readBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(readBuilder.builder);

    const result = await resolveAutonomousCanaryReview({ reviewId: REVIEW_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("returns alreadyResolved=true and skips the update when row is already resolved", async () => {
    const readBuilder = makeQueryBuilder({
      data: {
        id: REVIEW_ID,
        workspace_id: "ws-1",
        status: "resolved",
        resolved_at: "2026-04-25T00:00:00Z",
        category: "sku_autonomous_canary_review",
        metadata: { intended_flag: "sku_live_alias_autonomy_enabled" },
      },
      error: null,
    });
    mockFrom.mockReturnValueOnce(readBuilder.builder);

    const result = await resolveAutonomousCanaryReview({
      reviewId: REVIEW_ID,
      resolutionNote: "ignored because already resolved",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyResolved).toBe(true);
    expect(result.resolvedAt).toBe("2026-04-25T00:00:00Z");
    // Only ONE `from()` call — the existence check. No update issued.
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect(invalidateWorkspaceFlagsMock).not.toHaveBeenCalled();
  });

  it("writes resolved state, revalidates both pages, and invalidates the flag cache", async () => {
    const readBuilder = makeQueryBuilder({
      data: {
        id: REVIEW_ID,
        workspace_id: "ws-1",
        status: "open",
        resolved_at: null,
        category: "sku_autonomous_canary_review",
        metadata: { intended_flag: "sku_live_alias_autonomy_enabled" },
      },
      error: null,
    });
    const updateBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(readBuilder.builder).mockReturnValueOnce(updateBuilder.builder);

    const result = await resolveAutonomousCanaryReview({
      reviewId: REVIEW_ID,
      resolutionNote: "telemetry green — sign off",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyResolved).toBe(false);
    expect(result.reviewId).toBe(REVIEW_ID);
    expect(typeof result.resolvedAt).toBe("string");

    const updateCall = updateBuilder.calls.find((c) => c.method === "update");
    expect(updateCall).toBeDefined();
    const payload = updateCall?.args[0] as {
      status: string;
      resolved_at: string;
      resolved_by: string;
      metadata: {
        intended_flag?: string;
        resolution_note: string | null;
        resolved_by_user: string;
      };
    };
    expect(payload.status).toBe("resolved");
    expect(typeof payload.resolved_at).toBe("string");
    expect(payload.resolved_by).toBe("user-1");
    // Prior metadata is preserved and merged with the resolution fields.
    expect(payload.metadata.intended_flag).toBe("sku_live_alias_autonomy_enabled");
    expect(payload.metadata.resolution_note).toBe("telemetry green — sign off");
    expect(payload.metadata.resolved_by_user).toBe("user-1");

    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/sku-matching/rollout");
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/feature-flags");
    expect(invalidateWorkspaceFlagsMock).toHaveBeenCalledWith("ws-1");
  });

  it("returns ok=false when the update errors (no revalidation, no flag cache invalidation)", async () => {
    const readBuilder = makeQueryBuilder({
      data: {
        id: REVIEW_ID,
        workspace_id: "ws-1",
        status: "open",
        resolved_at: null,
        category: "sku_autonomous_canary_review",
        metadata: null,
      },
      error: null,
    });
    const updateBuilder = makeQueryBuilder({
      data: null,
      error: { message: "update_boom" },
    });
    mockFrom.mockReturnValueOnce(readBuilder.builder).mockReturnValueOnce(updateBuilder.builder);

    const result = await resolveAutonomousCanaryReview({ reviewId: REVIEW_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/update_boom/);
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect(invalidateWorkspaceFlagsMock).not.toHaveBeenCalled();
  });

  it("handles a null metadata field on the existing row by writing an object without prior fields", async () => {
    const readBuilder = makeQueryBuilder({
      data: {
        id: REVIEW_ID,
        workspace_id: "ws-1",
        status: "in_progress",
        resolved_at: null,
        category: "sku_autonomous_canary_review",
        metadata: null,
      },
      error: null,
    });
    const updateBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(readBuilder.builder).mockReturnValueOnce(updateBuilder.builder);

    const result = await resolveAutonomousCanaryReview({ reviewId: REVIEW_ID });

    expect(result.ok).toBe(true);
    const updateCall = updateBuilder.calls.find((c) => c.method === "update");
    const payload = updateCall?.args[0] as {
      metadata: { resolution_note: string | null; resolved_by_user: string };
    };
    expect(payload.metadata.resolution_note).toBeNull();
    expect(payload.metadata.resolved_by_user).toBe("user-1");
  });
});
