// Phase 12 — notification_sends audit helpers.
//
// The single source of truth for "did we send this email?" Powers the
// reconciliation cron + the admin troubleshooting view + the dedup contract.
//
// Idempotency contract (THREE layers, belt-and-suspenders):
//   1. checkAlreadySent() — application-level lookup before send
//   2. recordSend()       — INSERT; UNIQUE constraint on (shipment_id,
//                            trigger_status) for status='sent' AND for
//                            status='shadow' enforces exactly-once at DB level
//   3. EP webhook dedup   — webhook_events.external_webhook_id (existing)
//
// A duplicate send requires ALL THREE to fail simultaneously, which is
// effectively impossible.

import type { SupabaseClient } from "@supabase/supabase-js";

export type NotificationTriggerStatus = "shipped" | "out_for_delivery" | "delivered" | "exception";

export type NotificationSendStatus =
  | "sent"
  | "failed"
  | "bounced"
  | "complained"
  | "suppressed"
  | "skipped"
  | "shadow";

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
  sent_at: string;
}

/**
 * Returns the prior "sent" or "shadow" row for this (shipment, trigger), if
 * any. Used by send-tracking-email as the application-layer dedup gate.
 * The DB UNIQUE indexes on the same fields catch races; this check just
 * skips an unnecessary Resend call.
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
    .in("status", ["sent", "shadow"])
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as NotificationSendRow | null) ?? null;
}

/**
 * Insert a notification_sends row. Returns the persisted row on success.
 *
 * If the DB UNIQUE constraint trips (race with another task instance), this
 * function does NOT throw — it returns the existing winning row so the
 * caller can treat it as success. This is the "DB belt" of the
 * three-layer dedup contract.
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
    resendMessageId?: string | null;
    error?: string | null;
    shadowIntendedRecipient?: string | null;
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
    resend_message_id: input.resendMessageId ?? null,
    error: input.error ?? null,
    shadow_intended_recipient: input.shadowIntendedRecipient ?? null,
  };
  const { data, error } = await supabase
    .from("notification_sends")
    .insert(row)
    .select("*")
    .maybeSingle();
  if (error) {
    // Postgres unique violation = 23505. Either the partial unique index
    // for 'sent' or for 'shadow' tripped. Fetch the winner.
    if (error.code === "23505" && (input.status === "sent" || input.status === "shadow")) {
      const winner = await findPriorSuccessfulSend(supabase, {
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
 * Record a Resend webhook outcome (bounce, complaint, etc.) onto the
 * matching notification_sends row. Used by the Resend webhook handler.
 * Returns true when a row was updated.
 */
export async function updateSendOutcomeByMessageId(
  supabase: SupabaseClient,
  input: {
    resendMessageId: string;
    newStatus: NotificationSendStatus;
    error?: string | null;
  },
): Promise<boolean> {
  const { error, count } = await supabase
    .from("notification_sends")
    .update(
      {
        status: input.newStatus,
        error: input.error ?? null,
      },
      { count: "exact" },
    )
    .eq("resend_message_id", input.resendMessageId);
  if (error) {
    throw new Error(`updateSendOutcomeByMessageId failed: ${error.message}`);
  }
  return (count ?? 0) > 0;
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
    // 23505 = duplicate key (already suppressed) — idempotent success
    throw new Error(`suppressRecipient failed: ${error.message}`);
  }
}
