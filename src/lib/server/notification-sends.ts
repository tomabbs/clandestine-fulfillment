// Phase 12 / Slice 2 — notification_sends audit + idempotency helpers.
//
// THE single source of truth for "did we send this email?" Powers:
//   - the reconciliation cron
//   - the admin troubleshooting view (Slice 4)
//   - the dedup contract for send-tracking-email
//
// Idempotency contract (THREE layers, belt-and-suspenders):
//   1. findPriorActiveSend()  — application-level lookup before send
//   2. recordSend(status='pending') — INSERT a pending row BEFORE calling
//      Resend. The widened partial unique index (Slice 2 migration) on
//      (shipment_id, trigger_status) WHERE status IN active_set guarantees
//      exactly-one active row per logical send. A second concurrent task
//      attempt collides on this index and is told the existing row's id.
//   3. Resend's `Idempotency-Key` header (passed via the SDK options
//      object) — defense-in-depth at the provider so even if our DB
//      record vanishes, Resend collapses retries.
//
// Slice 2 expands the recordSend recovery path: the partial unique index
// now covers EVERY active status (pending / sent / delivered / etc.), so
// recordSend recovers from 23505 for any of them — not just sent/shadow.

import type { SupabaseClient } from "@supabase/supabase-js";

export type NotificationTriggerStatus = "shipped" | "out_for_delivery" | "delivered" | "exception";

export type NotificationSendStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "suppressed"
  | "provider_suppressed"
  | "provider_failed"
  // Legacy alias for provider_failed; Slice 2 migration retains it in the
  // CHECK constraint for backward compatibility with pre-existing rows.
  | "failed"
  | "skipped"
  | "shadow"
  | "cancelled";

/** Statuses considered "active" (count toward the dedup partial unique index). */
export const ACTIVE_NOTIFICATION_STATUSES: ReadonlySet<NotificationSendStatus> = new Set([
  "pending",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "provider_suppressed",
  "shadow",
]);

/** Statuses considered terminal-success/terminal-failure (no more transitions expected). */
export const STICKY_TERMINAL_STATUSES: ReadonlySet<NotificationSendStatus> = new Set([
  "bounced",
  "complained",
  "cancelled",
]);

export interface NotificationSendRow {
  id: string;
  workspace_id: string;
  shipment_id: string;
  trigger_status: NotificationTriggerStatus;
  channel: string;
  template_id: string;
  recipient: string;
  status: NotificationSendStatus;
  resend_message_id: string | null;
  error: string | null;
  shadow_intended_recipient: string | null;
  idempotency_key: string | null;
  pending_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  delivery_delayed_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  provider_failed_at: string | null;
  provider_suppressed_at: string | null;
  cancelled_at: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
}

/**
 * Returns the prior active row for this (shipment, trigger), if any. The
 * "active" set is shared with the partial unique index — see
 * ACTIVE_NOTIFICATION_STATUSES.
 */
export async function findPriorActiveSend(
  supabase: SupabaseClient,
  input: { shipmentId: string; triggerStatus: NotificationTriggerStatus },
): Promise<NotificationSendRow | null> {
  const { data } = await supabase
    .from("notification_sends")
    .select("*")
    .eq("shipment_id", input.shipmentId)
    .eq("trigger_status", input.triggerStatus)
    .in("status", Array.from(ACTIVE_NOTIFICATION_STATUSES))
    .order("pending_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as NotificationSendRow | null) ?? null;
}

/**
 * Pre-Slice-2 helper: returns the prior 'sent' or 'shadow' row. Retained
 * because reconciliation tasks still want the strict "successful send"
 * lookup. Implemented in terms of findPriorActiveSend filter narrowing.
 */
export async function findPriorSuccessfulSend(
  supabase: SupabaseClient,
  input: { shipmentId: string; triggerStatus: NotificationTriggerStatus },
): Promise<NotificationSendRow | null> {
  const { data } = await supabase
    .from("notification_sends")
    .select("*")
    .eq("shipment_id", input.shipmentId)
    .eq("trigger_status", input.triggerStatus)
    .in("status", ["sent", "shadow", "delivered"])
    .order("pending_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as NotificationSendRow | null) ?? null;
}

/**
 * Look up notification_sends by Resend message id. The webhook handler
 * uses this to find the rollup row to transition.
 */
export async function findNotificationSendByMessageId(
  supabase: SupabaseClient,
  messageId: string,
): Promise<NotificationSendRow | null> {
  const { data } = await supabase
    .from("notification_sends")
    .select("*")
    .eq("resend_message_id", messageId)
    .maybeSingle();
  return (data as NotificationSendRow | null) ?? null;
}

/**
 * Look up notification_sends by idempotency_key. The send-tracking-email
 * task uses this AFTER a 23505 collision to find the row that won the
 * race.
 */
export async function findNotificationSendByIdempotencyKey(
  supabase: SupabaseClient,
  key: string,
): Promise<NotificationSendRow | null> {
  const { data } = await supabase
    .from("notification_sends")
    .select("*")
    .eq("idempotency_key", key)
    .maybeSingle();
  return (data as NotificationSendRow | null) ?? null;
}

/**
 * Insert a notification_sends row. Returns the persisted row on success.
 *
 * On 23505 unique violation:
 *   - If `idempotency_key` was supplied, fetch the existing row by key.
 *   - Else fall back to the (shipment, trigger) active-row lookup.
 *
 * This is the "DB belt" of the three-layer dedup contract.
 */
export async function recordSend(
  supabase: SupabaseClient,
  input: {
    workspaceId: string;
    shipmentId: string;
    triggerStatus: NotificationTriggerStatus;
    channel?: string;
    templateId: string;
    recipient: string;
    status: NotificationSendStatus;
    idempotencyKey?: string | null;
    resendMessageId?: string | null;
    error?: string | null;
    shadowIntendedRecipient?: string | null;
    sentAt?: string | null;
    deliveredAt?: string | null;
    attemptCount?: number;
    lastAttemptAt?: string | null;
    nextRetryAt?: string | null;
  },
): Promise<NotificationSendRow> {
  const row = {
    workspace_id: input.workspaceId,
    shipment_id: input.shipmentId,
    trigger_status: input.triggerStatus,
    channel: input.channel ?? "email",
    template_id: input.templateId,
    recipient: input.recipient,
    status: input.status,
    idempotency_key: input.idempotencyKey ?? null,
    resend_message_id: input.resendMessageId ?? null,
    error: input.error ?? null,
    shadow_intended_recipient: input.shadowIntendedRecipient ?? null,
    sent_at: input.sentAt ?? (input.status === "sent" ? new Date().toISOString() : null),
    delivered_at: input.deliveredAt ?? null,
    attempt_count: input.attemptCount ?? 0,
    last_attempt_at: input.lastAttemptAt ?? null,
    next_retry_at: input.nextRetryAt ?? null,
  };
  const { data, error } = await supabase
    .from("notification_sends")
    .insert(row)
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      // Recover whichever row already won the race.
      if (input.idempotencyKey) {
        const winner = await findNotificationSendByIdempotencyKey(supabase, input.idempotencyKey);
        if (winner) return winner;
      }
      const winner = await findPriorActiveSend(supabase, {
        shipmentId: input.shipmentId,
        triggerStatus: input.triggerStatus,
      });
      if (winner) return winner;
    }
    throw new Error(`recordSend failed: ${error.message}`);
  }
  if (!data) throw new Error("recordSend returned no row");
  return data as NotificationSendRow;
}

/**
 * Update bookkeeping fields on a pending row mid-retry. Does NOT change
 * status — that always goes through update_notification_status_safe.
 */
export async function bumpAttemptBookkeeping(
  supabase: SupabaseClient,
  input: {
    notificationSendId: string;
    attemptCount: number;
    lastAttemptAt: string;
    nextRetryAt?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from("notification_sends")
    .update({
      attempt_count: input.attemptCount,
      last_attempt_at: input.lastAttemptAt,
      next_retry_at: input.nextRetryAt ?? null,
      error: input.error ?? null,
    })
    .eq("id", input.notificationSendId);
  if (error) {
    throw new Error(`bumpAttemptBookkeeping failed: ${error.message}`);
  }
}

/**
 * Set the resend_message_id on a row WITHOUT changing status. Used by
 * send-tracking-email when the Resend response arrives but we want to
 * defer the status transition to update_notification_status_safe.
 */
export async function stampResendMessageId(
  supabase: SupabaseClient,
  input: { notificationSendId: string; resendMessageId: string },
): Promise<void> {
  const { error } = await supabase
    .from("notification_sends")
    .update({ resend_message_id: input.resendMessageId })
    .eq("id", input.notificationSendId);
  if (error) {
    throw new Error(`stampResendMessageId failed: ${error.message}`);
  }
}

/**
 * Look up whether a recipient is on the suppression list for this workspace.
 * Checked at send time so a single bounce / complaint immediately blocks all
 * future sends to that address. Workspace-scoped; global suppressions live
 * with workspace_id IS NULL and apply to every workspace.
 */
export async function isRecipientSuppressed(
  supabase: SupabaseClient,
  input: { workspaceId: string; recipient: string },
): Promise<boolean> {
  const { data } = await supabase
    .from("resend_suppressions")
    .select("id")
    .eq("recipient", input.recipient)
    .or(`workspace_id.eq.${input.workspaceId},workspace_id.is.null`)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Suppress a recipient (add to resend_suppressions) idempotently. Called
 * from the Resend webhook on bounce + complaint events.
 */
export async function suppressRecipient(
  supabase: SupabaseClient,
  input: {
    workspaceId: string | null;
    recipient: string;
    suppressionType: "bounce" | "complaint" | "manual";
    reason?: string | null;
    sourceMessageId?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("resend_suppressions").insert({
    workspace_id: input.workspaceId,
    recipient: input.recipient,
    suppression_type: input.suppressionType,
    reason: input.reason ?? null,
    source_message_id: input.sourceMessageId ?? null,
  });
  if (error && error.code !== "23505") {
    throw new Error(`suppressRecipient failed: ${error.message}`);
  }
}

/**
 * @deprecated Use updateNotificationStatusSafe in
 * src/lib/server/notification-status.ts. Kept as a thin shim so any
 * pre-Slice-2 caller compiles; throws if called.
 */
export async function updateSendOutcomeByMessageId(
  _supabase: SupabaseClient,
  _input: {
    resendMessageId: string;
    newStatus: NotificationSendStatus;
    error?: string | null;
  },
): Promise<boolean> {
  throw new Error(
    "updateSendOutcomeByMessageId is retired in Slice 2; use updateNotificationStatusSafe (src/lib/server/notification-status.ts).",
  );
}
