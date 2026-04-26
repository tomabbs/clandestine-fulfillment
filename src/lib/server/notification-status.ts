// Slice 2 — centralized notification + tracking status writes.
//
// EVERY application-side change to:
//   - notification_sends.status
//   - warehouse_shipments.easypost_tracker_status
// MUST go through this module. The CI grep guard at
// scripts/check-notification-status-writes.sh enforces this — direct
// `.update({ status })` on either column outside this file fails the build.
//
// Why centralize:
//   - The PL/pgSQL state machines (update_notification_status_safe,
//     update_shipment_tracking_status_safe) are the source of truth for
//     allowed transitions. Calling them from many places makes the rules
//     hard to evolve consistently.
//   - The wrapper supplies the canonical error/Sentry shape so a rejected
//     transition always emits the same diagnostic.
//   - Operator actions (Slice 4 admin UI) get atomicity for free via
//     apply_operator_notification_action.
//
// The wrapper does NOT swallow errors — it returns a typed verdict so
// callers can decide whether a no-op (e.g. duplicate webhook) is fine or
// requires escalation.

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationSendStatus } from "@/lib/server/notification-sends";

export interface SafeStatusResult {
  applied: boolean;
  previousStatus: string | null;
  newStatus: string;
  skippedReason: string | null;
}

interface UpdateNotificationInput {
  notificationSendId: string;
  newStatus: NotificationSendStatus;
  /** Optional human-readable error stamp (set when transitioning to failed/bounced). */
  error?: string | null;
  /** Optional Resend message id stamped on the row when transitioning out of pending. */
  resendMessageId?: string | null;
  /** Optional provider event type for diagnostics — surfaced via Sentry on rejections. */
  providerEventType?: string | null;
}

/**
 * Drive a notification_sends.status transition through
 * update_notification_status_safe. Returns the verdict; logs to Sentry
 * when the state machine REJECTS a transition (sticky-terminal regression
 * attempt or transition-not-allowed) so we can alert on patterns.
 */
export async function updateNotificationStatusSafe(
  supabase: SupabaseClient,
  input: UpdateNotificationInput,
): Promise<SafeStatusResult> {
  const { data, error } = await supabase.rpc("update_notification_status_safe", {
    p_notification_send_id: input.notificationSendId,
    p_new_status: input.newStatus,
    p_error: input.error ?? null,
    p_resend_message_id: input.resendMessageId ?? null,
    p_provider_event_type: input.providerEventType ?? null,
  });
  if (error) {
    Sentry.captureException(error, {
      tags: {
        feature: "notification_status",
        rpc: "update_notification_status_safe",
      },
      extra: { input },
    });
    throw new Error(`update_notification_status_safe RPC failed: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  const verdict: SafeStatusResult = {
    applied: !!row?.applied,
    previousStatus: (row?.previous_status as string | null) ?? null,
    newStatus: (row?.new_status as string | null) ?? input.newStatus,
    skippedReason: (row?.skipped_reason as string | null) ?? null,
  };
  if (!verdict.applied && verdict.skippedReason && verdict.skippedReason !== "no_op_same_status") {
    Sentry.captureMessage(
      `[notification-status] state-machine rejected transition: ${verdict.skippedReason}`,
      {
        level: verdict.skippedReason === "send_not_found" ? "warning" : "info",
        tags: {
          feature: "notification_status",
          skipped_reason: verdict.skippedReason,
          provider_event_type: input.providerEventType ?? "unspecified",
        },
        extra: { input, verdict },
      },
    );
  }
  return verdict;
}

interface UpdateTrackingInput {
  shipmentId: string;
  newStatus: string;
  statusDetail?: string | null;
  /** Provider-side event time. Out-of-order events (older than current) are silently skipped. */
  statusAt?: string | null;
}

export async function updateShipmentTrackingStatusSafe(
  supabase: SupabaseClient,
  input: UpdateTrackingInput,
): Promise<SafeStatusResult> {
  const { data, error } = await supabase.rpc("update_shipment_tracking_status_safe", {
    p_shipment_id: input.shipmentId,
    p_new_status: input.newStatus,
    p_status_detail: input.statusDetail ?? null,
    p_status_at: input.statusAt ?? null,
  });
  if (error) {
    Sentry.captureException(error, {
      tags: { feature: "tracking_status", rpc: "update_shipment_tracking_status_safe" },
      extra: { input },
    });
    throw new Error(`update_shipment_tracking_status_safe RPC failed: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  const verdict: SafeStatusResult = {
    applied: !!row?.applied,
    previousStatus: (row?.previous_status as string | null) ?? null,
    newStatus: (row?.new_status as string | null) ?? input.newStatus,
    skippedReason: (row?.skipped_reason as string | null) ?? null,
  };
  if (!verdict.applied && verdict.skippedReason && verdict.skippedReason !== "no_op_same_status") {
    Sentry.captureMessage(
      `[tracking-status] state-machine rejected transition: ${verdict.skippedReason}`,
      {
        level: verdict.skippedReason === "shipment_not_found" ? "warning" : "info",
        tags: {
          feature: "tracking_status",
          skipped_reason: verdict.skippedReason,
        },
        extra: { input, verdict },
      },
    );
  }
  return verdict;
}

export interface OperatorActionResult extends SafeStatusResult {
  operatorEventId: string | null;
}

interface OperatorActionInput {
  notificationSendId: string;
  actorUserId: string;
  action: "retry" | "cancel" | "force_resend" | "mark_delivered_manual";
  reason?: string | null;
  /** Override the action's default target status. Rarely needed. */
  newStatus?: string | null;
}

/**
 * Atomic operator action: status transition + notification_operator_events
 * audit row in a SINGLE PL/pgSQL transaction (apply_operator_notification_action).
 */
export async function applyOperatorNotificationAction(
  supabase: SupabaseClient,
  input: OperatorActionInput,
): Promise<OperatorActionResult> {
  const { data, error } = await supabase.rpc("apply_operator_notification_action", {
    p_notification_send_id: input.notificationSendId,
    p_actor_user_id: input.actorUserId,
    p_action: input.action,
    p_reason: input.reason ?? null,
    p_new_status: input.newStatus ?? null,
  });
  if (error) {
    Sentry.captureException(error, {
      tags: { feature: "notification_status", rpc: "apply_operator_notification_action" },
      extra: { input },
    });
    throw new Error(`apply_operator_notification_action RPC failed: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    applied: !!row?.applied,
    previousStatus: (row?.previous_status as string | null) ?? null,
    newStatus: (row?.new_status as string | null) ?? input.newStatus ?? "",
    skippedReason: (row?.skipped_reason as string | null) ?? null,
    operatorEventId: (row?.operator_event_id as string | null) ?? null,
  };
}
