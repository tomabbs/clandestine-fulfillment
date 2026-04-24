import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3 Pass 2 — `recordShadowPush()` companion test suite.
//
// Covers:
//   1. cutover_state guard — `legacy`/`direct` short-circuits return
//      `skipped_not_shadow` without touching the DB or Trigger.
//   2. happy path — insert + tasks.trigger() with the clamped delay window.
//   3. delay clamping — null/undefined → default 60s; out-of-range → bounded.
//   4. duplicate (correlation_id, sku) — `code: '23505'` returns
//      `logged_compare_skipped` with reason `duplicate_correlation_id_sku`.
//   5. tasks.trigger() failure — leaves the row in the DB with
//      metadata.trigger_enqueue_error and returns `logged_compare_skipped`
//      so the parent push isn't aborted.

// vi.mock factories run before module top-level vars are initialized, so
// reference the mocks via vi.hoisted to share state with the test bodies.
const { sentryCapture, tasksTrigger } = vi.hoisted(() => ({
  sentryCapture: vi.fn(),
  tasksTrigger: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: sentryCapture,
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: {
    trigger: tasksTrigger,
  },
}));

import {
  DEFAULT_SHADOW_WINDOW_SECONDS,
  recordShadowPush,
} from "@/lib/server/connection-shadow-log";

type SupabaseLike = {
  from: ReturnType<typeof vi.fn>;
};

function makeInsertMock(insertResult: { data: { id: string } | null; error: unknown | null }) {
  return {
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue(insertResult),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
}

function makeSupabase(insertResult: {
  data: { id: string } | null;
  error: unknown | null;
}): SupabaseLike {
  const tableMock = makeInsertMock(insertResult);
  return {
    from: vi.fn(() => tableMock),
  };
}

describe("recordShadowPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns skipped_not_shadow without touching DB when cutover_state is legacy", async () => {
    const supabase = makeSupabase({ data: { id: "ignored" }, error: null });
    const result = await recordShadowPush({
      supabase: supabase as never,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      sku: "SKU-1",
      correlationId: "corr-1",
      pushedQuantity: 5,
      cutoverStateAtPush: "legacy",
      shadowWindowToleranceSeconds: null,
    });
    expect(result).toEqual({
      status: "skipped_not_shadow",
      reason: "cutover_state_at_push='legacy'",
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(tasksTrigger).not.toHaveBeenCalled();
  });

  it("returns skipped_not_shadow without touching DB when cutover_state is direct", async () => {
    const supabase = makeSupabase({ data: { id: "ignored" }, error: null });
    const result = await recordShadowPush({
      supabase: supabase as never,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      sku: "SKU-1",
      correlationId: "corr-1",
      pushedQuantity: 5,
      cutoverStateAtPush: "direct",
      shadowWindowToleranceSeconds: 90,
    });
    expect(result.status).toBe("skipped_not_shadow");
    expect(supabase.from).not.toHaveBeenCalled();
    expect(tasksTrigger).not.toHaveBeenCalled();
  });

  it("inserts a shadow log row and enqueues comparison with the default window", async () => {
    const supabase = makeSupabase({ data: { id: "log-1" }, error: null });
    tasksTrigger.mockResolvedValueOnce({ id: "run-1" });

    const result = await recordShadowPush({
      supabase: supabase as never,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      sku: "SKU-1",
      correlationId: "corr-1",
      pushedQuantity: 7,
      cutoverStateAtPush: "shadow",
      shadowWindowToleranceSeconds: null,
      metadata: { source: "test" },
    });

    expect(result).toEqual({
      status: "logged",
      shadowLogId: "log-1",
      comparisonScheduledAtSeconds: DEFAULT_SHADOW_WINDOW_SECONDS,
    });
    expect(supabase.from).toHaveBeenCalledWith("connection_shadow_log");
    expect(tasksTrigger).toHaveBeenCalledWith(
      "shadow-mode-comparison",
      expect.objectContaining({
        shadowLogId: "log-1",
        sku: "SKU-1",
        pushedQuantity: 7,
      }),
      expect.objectContaining({
        delay: `${DEFAULT_SHADOW_WINDOW_SECONDS}s`,
        idempotencyKey: "shadow-mode-comparison:log-1",
      }),
    );
  });

  it("clamps shadow_window_tolerance_seconds into the 30..600s range", async () => {
    const supabase = makeSupabase({ data: { id: "log-2" }, error: null });
    tasksTrigger.mockResolvedValueOnce({ id: "run-2" });

    await recordShadowPush({
      supabase: supabase as never,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      sku: "SKU-1",
      correlationId: "corr-1",
      pushedQuantity: 7,
      cutoverStateAtPush: "shadow",
      // explicitly out-of-range; must clamp to 600
      shadowWindowToleranceSeconds: 99999,
    });

    expect(tasksTrigger).toHaveBeenCalledWith(
      "shadow-mode-comparison",
      expect.anything(),
      expect.objectContaining({ delay: "600s" }),
    );

    tasksTrigger.mockClear();
    const supabase2 = makeSupabase({ data: { id: "log-3" }, error: null });
    tasksTrigger.mockResolvedValueOnce({ id: "run-3" });
    await recordShadowPush({
      supabase: supabase2 as never,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      sku: "SKU-1",
      correlationId: "corr-1",
      pushedQuantity: 7,
      cutoverStateAtPush: "shadow",
      shadowWindowToleranceSeconds: 1,
    });
    expect(tasksTrigger).toHaveBeenCalledWith(
      "shadow-mode-comparison",
      expect.anything(),
      expect.objectContaining({ delay: "30s" }),
    );
  });

  it("returns logged_compare_skipped on duplicate (correlation_id, sku) collision", async () => {
    const supabase = makeSupabase({
      data: null,
      error: { code: "23505", message: "unique violation" },
    });
    const result = await recordShadowPush({
      supabase: supabase as never,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      sku: "SKU-1",
      correlationId: "corr-dup",
      pushedQuantity: 7,
      cutoverStateAtPush: "shadow",
      shadowWindowToleranceSeconds: null,
    });
    expect(result).toEqual({
      status: "logged_compare_skipped",
      reason: "duplicate_correlation_id_sku",
    });
    expect(tasksTrigger).not.toHaveBeenCalled();
    expect(sentryCapture).not.toHaveBeenCalled();
  });

  it("returns logged_compare_skipped when tasks.trigger fails (parent push not aborted)", async () => {
    const supabase = makeSupabase({ data: { id: "log-4" }, error: null });
    tasksTrigger.mockRejectedValueOnce(new Error("trigger.dev outage"));

    const result = await recordShadowPush({
      supabase: supabase as never,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      sku: "SKU-1",
      correlationId: "corr-trig-fail",
      pushedQuantity: 7,
      cutoverStateAtPush: "shadow",
      shadowWindowToleranceSeconds: null,
    });
    expect(result).toEqual({
      status: "logged_compare_skipped",
      shadowLogId: "log-4",
      reason: "trigger_enqueue_failed",
    });
    expect(sentryCapture).toHaveBeenCalled();
  });
});
