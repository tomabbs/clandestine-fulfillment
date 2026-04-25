// Slice 2 — notification-status wrapper tests.
//
// Verifies the wrapper:
//   - Calls the correct PL/pgSQL RPC with the correct argument names
//   - Surfaces typed verdicts (applied / previousStatus / newStatus / skippedReason)
//   - Throws on RPC errors with the canonical error message shape
//   - Does NOT swallow rejections — caller must see the verdict
//
// We mock the supabase client so we can assert the RPC contract without
// depending on the actual database. The contract here MUST stay byte-for-byte
// aligned with the PL/pgSQL signature in supabase/migrations/20260425000005_*.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOperatorNotificationAction,
  updateNotificationStatusSafe,
  updateShipmentTrackingStatusSafe,
} from "@/lib/server/notification-status";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

beforeEach(async () => {
  const Sentry = await import("@sentry/nextjs");
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(Sentry.captureMessage).mockClear();
});

interface RpcMock {
  client: {
    rpc: ReturnType<typeof vi.fn>;
  };
  call: () => unknown;
}

function mockSupabase(result: { data?: unknown; error?: unknown }): RpcMock {
  const rpc = vi.fn().mockResolvedValue(result);
  return {
    client: { rpc },
    call: () => rpc.mock.calls[0],
  };
}

describe("updateNotificationStatusSafe — wrapper contract", () => {
  it("invokes update_notification_status_safe with `p_*` arg names", async () => {
    const m = mockSupabase({
      data: { applied: true, previous_status: "pending", new_status: "sent", skipped_reason: null },
    });
    const verdict = await updateNotificationStatusSafe(m.client as never, {
      notificationSendId: "ns-1",
      newStatus: "sent",
      resendMessageId: "msg_abc",
      providerEventType: "email.sent",
    });
    expect(m.client.rpc).toHaveBeenCalledWith("update_notification_status_safe", {
      p_notification_send_id: "ns-1",
      p_new_status: "sent",
      p_error: null,
      p_resend_message_id: "msg_abc",
      p_provider_event_type: "email.sent",
    });
    expect(verdict).toEqual({
      applied: true,
      previousStatus: "pending",
      newStatus: "sent",
      skippedReason: null,
    });
  });

  it("surfaces sticky-terminal rejection without throwing", async () => {
    const m = mockSupabase({
      data: {
        applied: false,
        previous_status: "bounced",
        new_status: "delivered",
        skipped_reason: "sticky_terminal_state",
      },
    });
    const verdict = await updateNotificationStatusSafe(m.client as never, {
      notificationSendId: "ns-1",
      newStatus: "delivered",
    });
    expect(verdict.applied).toBe(false);
    expect(verdict.skippedReason).toBe("sticky_terminal_state");
    expect(verdict.previousStatus).toBe("bounced");
  });

  it("treats no_op_same_status as a non-event (no Sentry noise)", async () => {
    const Sentry = await import("@sentry/nextjs");
    const m = mockSupabase({
      data: {
        applied: false,
        previous_status: "sent",
        new_status: "sent",
        skipped_reason: "no_op_same_status",
      },
    });
    await updateNotificationStatusSafe(m.client as never, {
      notificationSendId: "ns-1",
      newStatus: "sent",
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("alerts Sentry on any rejection that isn't a no-op", async () => {
    const Sentry = await import("@sentry/nextjs");
    const m = mockSupabase({
      data: {
        applied: false,
        previous_status: "bounced",
        new_status: "delivered",
        skipped_reason: "sticky_terminal_state",
      },
    });
    await updateNotificationStatusSafe(m.client as never, {
      notificationSendId: "ns-1",
      newStatus: "delivered",
      providerEventType: "email.delivered",
    });
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
  });

  it("throws on RPC error with the canonical error shape", async () => {
    const m = mockSupabase({ data: null, error: { message: "permission denied" } });
    await expect(
      updateNotificationStatusSafe(m.client as never, {
        notificationSendId: "ns-1",
        newStatus: "sent",
      }),
    ).rejects.toThrow(/update_notification_status_safe RPC failed: permission denied/);
  });

  it("normalizes data: array shape returned by some RPCs", async () => {
    const m = mockSupabase({
      data: [
        { applied: true, previous_status: "pending", new_status: "sent", skipped_reason: null },
      ],
    });
    const verdict = await updateNotificationStatusSafe(m.client as never, {
      notificationSendId: "ns-1",
      newStatus: "sent",
    });
    expect(verdict.applied).toBe(true);
    expect(verdict.newStatus).toBe("sent");
  });
});

describe("updateShipmentTrackingStatusSafe — wrapper contract", () => {
  it("invokes update_shipment_tracking_status_safe with `p_*` arg names", async () => {
    const m = mockSupabase({
      data: {
        applied: true,
        previous_status: "pre_transit",
        new_status: "in_transit",
        skipped_reason: null,
      },
    });
    const verdict = await updateShipmentTrackingStatusSafe(m.client as never, {
      shipmentId: "ship-1",
      newStatus: "in_transit",
      statusDetail: "departed_facility",
      statusAt: "2026-04-25T12:00:00Z",
    });
    expect(m.client.rpc).toHaveBeenCalledWith("update_shipment_tracking_status_safe", {
      p_shipment_id: "ship-1",
      p_new_status: "in_transit",
      p_status_detail: "departed_facility",
      p_status_at: "2026-04-25T12:00:00Z",
    });
    expect(verdict.applied).toBe(true);
    expect(verdict.newStatus).toBe("in_transit");
  });

  it("surfaces out-of-order rejection (older event than current)", async () => {
    const m = mockSupabase({
      data: {
        applied: false,
        previous_status: "delivered",
        new_status: "in_transit",
        skipped_reason: "older_than_current",
      },
    });
    const verdict = await updateShipmentTrackingStatusSafe(m.client as never, {
      shipmentId: "ship-1",
      newStatus: "in_transit",
    });
    expect(verdict.applied).toBe(false);
    expect(verdict.skippedReason).toBe("older_than_current");
  });
});

describe("applyOperatorNotificationAction — wrapper contract", () => {
  it("invokes apply_operator_notification_action with `p_*` arg names + returns operator_event_id", async () => {
    const m = mockSupabase({
      data: {
        applied: true,
        previous_status: "pending",
        new_status: "cancelled",
        skipped_reason: null,
        operator_event_id: "evt-99",
      },
    });
    const verdict = await applyOperatorNotificationAction(m.client as never, {
      notificationSendId: "ns-1",
      actorUserId: "user-7",
      action: "cancel",
      reason: "Operator cancelled stuck send",
    });
    expect(m.client.rpc).toHaveBeenCalledWith("apply_operator_notification_action", {
      p_notification_send_id: "ns-1",
      p_actor_user_id: "user-7",
      p_action: "cancel",
      p_reason: "Operator cancelled stuck send",
      p_new_status: null,
    });
    expect(verdict.operatorEventId).toBe("evt-99");
    expect(verdict.applied).toBe(true);
  });

  it("supports overriding newStatus on the action", async () => {
    const m = mockSupabase({
      data: { applied: true, previous_status: "sent", new_status: "delivered", operator_event_id: "evt-1" },
    });
    await applyOperatorNotificationAction(m.client as never, {
      notificationSendId: "ns-1",
      actorUserId: "user-7",
      action: "mark_delivered_manual",
      newStatus: "delivered",
    });
    expect(m.client.rpc).toHaveBeenCalledWith(
      "apply_operator_notification_action",
      expect.objectContaining({ p_new_status: "delivered", p_action: "mark_delivered_manual" }),
    );
  });

  it("throws with canonical shape on RPC error", async () => {
    const m = mockSupabase({ data: null, error: { message: "row level security violated" } });
    await expect(
      applyOperatorNotificationAction(m.client as never, {
        notificationSendId: "ns-1",
        actorUserId: "user-7",
        action: "retry",
      }),
    ).rejects.toThrow(/apply_operator_notification_action RPC failed: row level security violated/);
  });
});
