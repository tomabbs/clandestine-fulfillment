import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 Slice 6.G — tests for the canary sign-off flag-flip Server Action.
// Covers: requireStaff gate, canary review preflight, Phase 7 linkage
// preflight, emergency-pause block, rollback fast-path, and the write +
// cache-invalidate sequence when all gates clear.

const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/server/auth-context", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "user-1", workspaceId: "ws-1" })),
}));

const getWorkspaceFlagsMock = vi.fn();
const invalidateWorkspaceFlagsMock = vi.fn();

vi.mock("@/lib/server/workspace-flags", () => ({
  getWorkspaceFlags: (...args: unknown[]) => getWorkspaceFlagsMock(...args),
  invalidateWorkspaceFlags: (...args: unknown[]) => invalidateWorkspaceFlagsMock(...args),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => ({ from: mockFrom, rpc: mockRpc }),
}));

import { flipAutonomousMatchingFlag } from "@/actions/sku-autonomous-canary";
import { requireStaff } from "@/lib/server/auth-context";

// ─────────────────────────────────────────────────────────────────────────────
// Query-builder mock. Each `from(table)` call returns a fresh builder whose
// terminal (`.limit()`, `.maybeSingle()`, `.update().eq()`, `.insert().then()`)
// resolves to a programmable shape.
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
      // `.update({...}).eq(...)` treats `.eq()` as the terminal; we resolve
      // for that path. Non-terminal `.eq()` chains (list reads) instead
      // continue via the builder; vitest's mockReturnValueOnce cascade
      // drives which shape we return here because we resolve the SAME
      // promise in both cases — reads always follow with .limit/.maybeSingle
      // which take precedence.
      return {
        ...builder,
        // biome-ignore lint/suspicious/noThenProperty: Supabase's PostgrestBuilder is intentionally thenable — calling `.eq()` as a terminal (`.update().eq(...)`) awaits the response. The mock mirrors that shape.
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
    update: rec("update"),
    insert: (payload: unknown) => {
      calls.push({ method: "insert", args: [payload] });
      return {
        // biome-ignore lint/suspicious/noThenProperty: Matches Supabase PostgrestBuilder — `.insert(...)` returns a thenable whose terminal resolve returns the inserted row(s).
        then: (onFulfilled: () => unknown) => resolved.then(onFulfilled),
      };
    },
  };

  return { builder, calls };
}

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

describe("flipAutonomousMatchingFlag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStaff).mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
    getWorkspaceFlagsMock.mockResolvedValue({});
  });

  // ── Canary gate ──

  it("blocks enabling sku_identity_autonomy_enabled when no canary review exists", async () => {
    const reviewBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(reviewBuilder.builder);

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_identity_autonomy_enabled",
      enabled: true,
      note: "canary sign-off: window 2",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.block.kind).toBe("canary_review_missing");
    expect(mockFrom).toHaveBeenCalledWith("warehouse_review_queue");
    // Never wrote to workspaces
    const workspaceWrites = mockFrom.mock.calls.filter((c) => c[0] === "workspaces");
    expect(workspaceWrites).toHaveLength(0);
  });

  it("blocks when canary review row exists but status != resolved", async () => {
    const reviewBuilder = makeQueryBuilder({
      data: [{ id: REVIEW_ID, status: "open", resolved_at: null }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(reviewBuilder.builder);

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_identity_autonomy_enabled",
      enabled: true,
      note: "canary sign-off",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.block.kind).toBe("canary_review_unresolved");
    if (result.block.kind !== "canary_review_unresolved") return;
    expect(result.block.reviewQueueId).toBe(REVIEW_ID);
    expect(result.block.status).toBe("open");
  });

  it("enables sku_identity_autonomy_enabled when canary review is resolved and note provided", async () => {
    const reviewBuilder = makeQueryBuilder({
      data: [
        {
          id: REVIEW_ID,
          status: "resolved",
          resolved_at: "2026-04-25T00:00:00Z",
        },
      ],
      error: null,
    });
    const updateBuilder = makeQueryBuilder({ data: null, error: null });
    const auditBuilder = makeQueryBuilder({ data: null, error: null });

    mockFrom
      .mockReturnValueOnce(reviewBuilder.builder)
      .mockReturnValueOnce(updateBuilder.builder)
      .mockReturnValueOnce(auditBuilder.builder);

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_identity_autonomy_enabled",
      enabled: true,
      note: "canary sign-off: window 2",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flag).toBe("sku_identity_autonomy_enabled");
    expect(result.enabled).toBe(true);
    expect(result.previousValue).toBe(false);

    expect(mockFrom).toHaveBeenNthCalledWith(1, "warehouse_review_queue");
    expect(mockFrom).toHaveBeenNthCalledWith(2, "workspaces");
    expect(mockFrom).toHaveBeenNthCalledWith(3, "warehouse_review_queue");

    const updateCall = updateBuilder.calls.find((c) => c.method === "update");
    expect(updateCall).toBeDefined();
    const payload = updateCall?.args[0] as { flags: Record<string, unknown> };
    expect(payload.flags.sku_identity_autonomy_enabled).toBe(true);
    expect(invalidateWorkspaceFlagsMock).toHaveBeenCalledWith("ws-1");
  });

  it("requires a sign-off note when enabling a canary-gated flag", async () => {
    await expect(
      flipAutonomousMatchingFlag({
        flag: "sku_identity_autonomy_enabled",
        enabled: true,
        // no note
      }),
    ).rejects.toThrow();
  });

  // ── Linkage + emergency-pause gates (Phase 7) ──

  it("blocks enabling sku_live_alias_autonomy_enabled when emergency pause is set", async () => {
    const reviewBuilder = makeQueryBuilder({
      data: [{ id: REVIEW_ID, status: "resolved", resolved_at: "2026-04-25T00:00:00Z" }],
      error: null,
    });
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        sku_autonomous_emergency_paused: true,
        sku_autonomous_emergency_paused_at: "2026-04-26T00:00:00Z",
        sku_autonomous_emergency_paused_reason: "stale_webhooks",
      },
      error: null,
    });
    mockFrom
      .mockReturnValueOnce(reviewBuilder.builder)
      .mockReturnValueOnce(workspaceBuilder.builder);

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_live_alias_autonomy_enabled",
      enabled: true,
      note: "ready",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.block.kind).toBe("workspace_emergency_paused");
    // RPC never called
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("blocks enabling sku_live_alias_autonomy_enabled when linkage metrics are below threshold", async () => {
    const reviewBuilder = makeQueryBuilder({
      data: [{ id: REVIEW_ID, status: "resolved", resolved_at: "2026-04-25T00:00:00Z" }],
      error: null,
    });
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    mockFrom
      .mockReturnValueOnce(reviewBuilder.builder)
      .mockReturnValueOnce(workspaceBuilder.builder);
    mockRpc.mockResolvedValueOnce({
      data: [
        {
          total_canonical_variants: 100,
          variants_with_bandcamp_mapping: 50,
          variants_with_verified_bandcamp_url: 30,
          variants_with_option_evidence: 10,
          linkage_rate: 0.5, // below 0.7 threshold
          verified_rate: 0.3,
          option_rate: 0.1,
        },
      ],
      error: null,
    });

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_live_alias_autonomy_enabled",
      enabled: true,
      note: "ready",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.block.kind).toBe("linkage_metrics_below_threshold");
    if (result.block.kind !== "linkage_metrics_below_threshold") return;
    expect(result.block.metrics.linkage_rate).toBe(0.5);
    expect(result.block.thresholds.linkage_rate).toBe(0.7);
  });

  it("enables sku_live_alias_autonomy_enabled when review resolved AND metrics above thresholds", async () => {
    const reviewBuilder = makeQueryBuilder({
      data: [{ id: REVIEW_ID, status: "resolved", resolved_at: "2026-04-25T00:00:00Z" }],
      error: null,
    });
    const workspaceBuilder = makeQueryBuilder({
      data: {
        org_id: "org-1",
        sku_autonomous_emergency_paused: false,
        sku_autonomous_emergency_paused_at: null,
        sku_autonomous_emergency_paused_reason: null,
      },
      error: null,
    });
    const updateBuilder = makeQueryBuilder({ data: null, error: null });
    const auditBuilder = makeQueryBuilder({ data: null, error: null });

    mockFrom
      .mockReturnValueOnce(reviewBuilder.builder)
      .mockReturnValueOnce(workspaceBuilder.builder)
      .mockReturnValueOnce(updateBuilder.builder)
      .mockReturnValueOnce(auditBuilder.builder);

    mockRpc.mockResolvedValueOnce({
      data: [
        {
          total_canonical_variants: 100,
          variants_with_bandcamp_mapping: 85,
          variants_with_verified_bandcamp_url: 70,
          variants_with_option_evidence: 45,
          linkage_rate: 0.85,
          verified_rate: 0.7,
          option_rate: 0.45,
        },
      ],
      error: null,
    });

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_live_alias_autonomy_enabled",
      enabled: true,
      note: "phase 7 sign-off",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flag).toBe("sku_live_alias_autonomy_enabled");
    expect(mockRpc).toHaveBeenCalledWith("compute_bandcamp_linkage_metrics", {
      p_workspace_id: "ws-1",
      p_org_id: "org-1",
    });
  });

  // ── Rollback (off-flip) fast-path ──

  it("turning sku_live_alias_autonomy_enabled OFF bypasses canary + linkage checks", async () => {
    const updateBuilder = makeQueryBuilder({ data: null, error: null });
    const auditBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(updateBuilder.builder).mockReturnValueOnce(auditBuilder.builder);

    getWorkspaceFlagsMock.mockResolvedValueOnce({ sku_live_alias_autonomy_enabled: true });

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_live_alias_autonomy_enabled",
      enabled: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enabled).toBe(false);
    expect(result.previousValue).toBe(true);
    // No review/rpc/workspace gate reads
    expect(mockFrom).toHaveBeenNthCalledWith(1, "workspaces");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── UI-only flags (no canary gate) ──

  it("enables sku_autonomous_ui_enabled without a canary preflight", async () => {
    const updateBuilder = makeQueryBuilder({ data: null, error: null });
    const auditBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom.mockReturnValueOnce(updateBuilder.builder).mockReturnValueOnce(auditBuilder.builder);

    const result = await flipAutonomousMatchingFlag({
      flag: "sku_autonomous_ui_enabled",
      enabled: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enabled).toBe(true);
    // Never queried the review queue as a preflight
    const reviewReads = mockFrom.mock.calls.filter((c) => c[0] === "warehouse_review_queue");
    // Exactly ONE call — the audit insert, not a preflight read.
    expect(reviewReads).toHaveLength(1);
  });

  // ── Staff gate ──

  it("surfaces requireStaff rejection", async () => {
    vi.mocked(requireStaff).mockRejectedValueOnce(new Error("not staff"));
    await expect(
      flipAutonomousMatchingFlag({
        flag: "sku_autonomous_ui_enabled",
        enabled: true,
      }),
    ).rejects.toThrow(/not staff/);
  });
});
