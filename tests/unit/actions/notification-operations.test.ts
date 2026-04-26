// Slice 4 — Server actions for /admin/operations/notifications.
//
// Coverage focus:
//   - retryStuckNotification routes through applyOperatorNotificationAction
//     (NOT direct .update({status}) — that would fail the CI grep guard)
//   - retry success re-enqueues send-tracking-email with the same
//     (shipment_id, trigger_status) — the cron's idempotency contract
//     handles deduplication.
//   - retry no-op (state-machine refused) does NOT re-enqueue.
//   - cancel routes through the same wrapper with action='cancel'.
//   - non-staff users are blocked from mutation actions.
//
// We mock @trigger.dev/sdk + auth-context + notification-status so the
// test doesn't need a Supabase server, a Trigger.dev project, or a
// browser session.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireAuth, mockApplyOperator, mockSupabaseClient, mockSupabaseFrom, mockTrigger } =
  vi.hoisted(() => {
    const fromMock = vi.fn();
    return {
      mockRequireAuth: vi.fn(),
      mockApplyOperator: vi.fn(),
      mockSupabaseClient: { from: fromMock } as never,
      mockSupabaseFrom: fromMock,
      mockTrigger: vi.fn().mockResolvedValue({ id: "run-1" }),
    };
  });

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: mockRequireAuth,
}));

vi.mock("@/lib/server/notification-status", () => ({
  applyOperatorNotificationAction: mockApplyOperator,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => mockSupabaseClient,
  createServiceRoleClient: () => mockSupabaseClient,
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

import {
  cancelStuckNotification,
  retryStuckNotification,
  triggerNotificationFailureSensor,
} from "@/actions/notification-operations";

function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    // biome-ignore lint/suspicious/noThenProperty: Supabase's PostgrestBuilder is intentionally thenable (callers can `await query.select().eq(...)` directly); this mock mirrors that contract so `await`-chaining in the production code under test routes through the same code path as in real Supabase calls.
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const k of ["select", "eq"]) {
    (c[k] as ReturnType<typeof vi.fn>).mockReturnValue(c);
  }
  return c;
}

const STAFF_CTX = {
  supabase: null,
  authUserId: "auth-1",
  userRecord: {
    id: "user-1",
    workspace_id: "ws-1",
    org_id: null,
    role: "admin",
    email: "ops@example.com",
    name: "Ops User",
  },
  isStaff: true,
};

const CLIENT_CTX = {
  ...STAFF_CTX,
  userRecord: { ...STAFF_CTX.userRecord, role: "client" },
  isStaff: false,
};

beforeEach(() => {
  mockRequireAuth.mockReset();
  mockApplyOperator.mockReset();
  mockSupabaseFrom.mockReset();
  mockTrigger.mockReset();
  mockTrigger.mockResolvedValue({ id: "run-1" });
});

describe("retryStuckNotification", () => {
  it("routes through applyOperatorNotificationAction with action='retry' (CI-grep-guard contract)", async () => {
    mockRequireAuth.mockResolvedValue(STAFF_CTX);
    mockApplyOperator.mockResolvedValue({
      applied: true,
      previousStatus: "pending",
      newStatus: "cancelled",
      skippedReason: null,
      operatorEventId: "op-1",
    });
    mockSupabaseFrom.mockReturnValueOnce(
      chain({
        data: { shipment_id: "ship-1", trigger_status: "out_for_delivery" },
        error: null,
      }),
    );

    const result = await retryStuckNotification("ns-1", "investigation");

    expect(mockApplyOperator).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        notificationSendId: "ns-1",
        actorUserId: "user-1",
        action: "retry",
        reason: "investigation",
      }),
    );
    // Critical Slice 4 contract: re-enqueue keeps (shipment_id, trigger_status)
    // identical so the dedup partial unique index handles dupes.
    expect(mockTrigger).toHaveBeenCalledWith(
      "send-tracking-email",
      expect.objectContaining({
        shipment_id: "ship-1",
        trigger_status: "out_for_delivery",
      }),
    );
    expect(result).toEqual({ applied: true, reEnqueued: true });
  });

  it("falls back to the default reason when caller omits it", async () => {
    mockRequireAuth.mockResolvedValue(STAFF_CTX);
    mockApplyOperator.mockResolvedValue({
      applied: true,
      previousStatus: "pending",
      newStatus: "cancelled",
      skippedReason: null,
      operatorEventId: "op-2",
    });
    mockSupabaseFrom.mockReturnValueOnce(
      chain({ data: { shipment_id: "s", trigger_status: "delivered" }, error: null }),
    );

    await retryStuckNotification("ns-1");

    const call = mockApplyOperator.mock.calls[0]?.[1];
    expect(call.reason).toBe("operator-retry-from-ops-page");
  });

  it("does NOT re-enqueue when applyOperatorNotificationAction refuses (e.g. not pending)", async () => {
    mockRequireAuth.mockResolvedValue(STAFF_CTX);
    mockApplyOperator.mockResolvedValue({
      applied: false,
      previousStatus: "delivered",
      newStatus: "delivered",
      skippedReason: "operator_action_invalid_for_status",
      operatorEventId: null,
    });

    const result = await retryStuckNotification("ns-1");

    expect(mockTrigger).not.toHaveBeenCalled();
    expect(result).toEqual({
      applied: false,
      skippedReason: "operator_action_invalid_for_status",
    });
  });

  it("does NOT re-enqueue when the send row has vanished between operator action and lookup (defensive)", async () => {
    mockRequireAuth.mockResolvedValue(STAFF_CTX);
    mockApplyOperator.mockResolvedValue({
      applied: true,
      previousStatus: "pending",
      newStatus: "cancelled",
      skippedReason: null,
      operatorEventId: "op-3",
    });
    mockSupabaseFrom.mockReturnValueOnce(chain({ data: null, error: null }));

    const result = await retryStuckNotification("ns-1");

    expect(mockTrigger).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: true, reEnqueued: false });
  });

  it("forbids non-staff users", async () => {
    mockRequireAuth.mockResolvedValue(CLIENT_CTX);
    await expect(retryStuckNotification("ns-1")).rejects.toThrow(/Forbidden/);
    expect(mockApplyOperator).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe("cancelStuckNotification", () => {
  it("routes through applyOperatorNotificationAction with action='cancel'", async () => {
    mockRequireAuth.mockResolvedValue(STAFF_CTX);
    mockApplyOperator.mockResolvedValue({
      applied: true,
      previousStatus: "pending",
      newStatus: "cancelled",
      skippedReason: null,
      operatorEventId: "op-4",
    });

    const result = await cancelStuckNotification("ns-1", "customer requested");

    expect(mockApplyOperator).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        notificationSendId: "ns-1",
        actorUserId: "user-1",
        action: "cancel",
        reason: "customer requested",
      }),
    );
    // Cancel must NEVER re-enqueue.
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: true, skippedReason: null });
  });

  it("returns the skippedReason verbatim when the state-machine refuses", async () => {
    mockRequireAuth.mockResolvedValue(STAFF_CTX);
    mockApplyOperator.mockResolvedValue({
      applied: false,
      previousStatus: "bounced",
      newStatus: "bounced",
      skippedReason: "operator_action_invalid_for_status",
      operatorEventId: null,
    });

    const result = await cancelStuckNotification("ns-1", "investigation");
    expect(result).toEqual({
      applied: false,
      skippedReason: "operator_action_invalid_for_status",
    });
  });

  it("forbids non-staff users", async () => {
    mockRequireAuth.mockResolvedValue(CLIENT_CTX);
    await expect(cancelStuckNotification("ns-1", "x")).rejects.toThrow(/Forbidden/);
    expect(mockApplyOperator).not.toHaveBeenCalled();
  });
});

describe("triggerNotificationFailureSensor", () => {
  it("enqueues notification-failure-sensor and returns the run id", async () => {
    mockRequireAuth.mockResolvedValue(STAFF_CTX);
    mockTrigger.mockResolvedValue({ id: "run-sensor-1" });

    const result = await triggerNotificationFailureSensor();
    expect(mockTrigger).toHaveBeenCalledWith("notification-failure-sensor", {});
    expect(result).toEqual({ runId: "run-sensor-1" });
  });

  it("forbids non-staff users", async () => {
    mockRequireAuth.mockResolvedValue(CLIENT_CTX);
    await expect(triggerNotificationFailureSensor()).rejects.toThrow(/Forbidden/);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
