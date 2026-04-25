"use server";

// Slice 4 — Server actions backing /admin/operations/notifications.
//
// READ surface:
//   - getNotificationOpsOverview()    — top-of-page rollup cards
//   - getStuckPendingNotifications()  — stuck >1h table
//   - getRecentNotificationFailures() — last 50 failed/bounced/complained
//   - getRecentSignatureFailures()    — last 50 webhook_events with sig errors
//   - getShipmentNotificationLog(id)  — drilldown for a single shipment
//
// MUTATION surface:
//   - retryStuckNotification(id)     — operator override: cancel pending,
//                                       re-enqueue send-tracking-email
//   - cancelStuckNotification(id, r) — operator override: terminal cancel
//   - triggerNotificationFailureSensor() — manual sensor run
//
// All mutations route through applyOperatorNotificationAction so the
// audit row in notification_operator_events is written in the SAME
// PL/pgSQL transaction as the status change. Direct .update() on
// notification_sends.status from this file would fail the CI grep guard.

import { tasks } from "@trigger.dev/sdk";
import { requireAuth } from "@/lib/server/auth-context";
import { applyOperatorNotificationAction } from "@/lib/server/notification-status";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1h
const SIGNATURE_FAILURE_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

interface OverviewRollup {
  pendingTotal: number;
  stuckPending1h: number;
  failedLast24h: number;
  bouncedLast24h: number;
  complainedLast24h: number;
  signatureFailures24h: number;
  signatureFailuresByPlatform: Record<string, number>;
}

export async function getNotificationOpsOverview(): Promise<OverviewRollup> {
  await requireAuth();
  const supabase = await createServerSupabaseClient();

  const nowMs = Date.now();
  const oneHourAgo = new Date(nowMs - STUCK_THRESHOLD_MS).toISOString();
  const oneDayAgo = new Date(nowMs - SIGNATURE_FAILURE_LOOKBACK_MS).toISOString();

  const [
    { count: pendingTotal },
    { count: stuckPending1h },
    { count: failedLast24h },
    { count: bouncedLast24h },
    { count: complainedLast24h },
    { data: sigRows },
  ] = await Promise.all([
    supabase
      .from("notification_sends")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("notification_sends")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("pending_at", oneHourAgo),
    supabase
      .from("notification_sends")
      .select("id", { count: "exact", head: true })
      .in("status", ["provider_failed", "failed"])
      .gte("created_at", oneDayAgo),
    supabase
      .from("notification_sends")
      .select("id", { count: "exact", head: true })
      .eq("status", "bounced")
      .gte("created_at", oneDayAgo),
    supabase
      .from("notification_sends")
      .select("id", { count: "exact", head: true })
      .eq("status", "complained")
      .gte("created_at", oneDayAgo),
    supabase
      .from("webhook_events")
      .select("platform, status")
      .in("status", ["signature_failed", "invalid"])
      .gte("created_at", oneDayAgo)
      .limit(2000),
  ]);

  const sigByPlatform: Record<string, number> = {};
  for (const row of sigRows ?? []) {
    const platform = (row.platform as string | null) ?? "unknown";
    sigByPlatform[platform] = (sigByPlatform[platform] ?? 0) + 1;
  }

  return {
    pendingTotal: pendingTotal ?? 0,
    stuckPending1h: stuckPending1h ?? 0,
    failedLast24h: failedLast24h ?? 0,
    bouncedLast24h: bouncedLast24h ?? 0,
    complainedLast24h: complainedLast24h ?? 0,
    signatureFailures24h: (sigRows ?? []).length,
    signatureFailuresByPlatform: sigByPlatform,
  };
}

export interface StuckPendingRow {
  id: string;
  shipment_id: string;
  workspace_id: string;
  trigger_status: string;
  recipient: string;
  pending_at: string;
  attempt_count: number;
  last_attempt_at: string | null;
  error: string | null;
  shipment_tracking_number: string | null;
  shipment_carrier: string | null;
  shipment_public_track_token: string | null;
  shipment_order_number: string | null;
}

export async function getStuckPendingNotifications(limit = 50): Promise<StuckPendingRow[]> {
  await requireAuth();
  const supabase = await createServerSupabaseClient();
  const oneHourAgo = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();

  const { data } = await supabase
    .from("notification_sends")
    .select(
      `id, shipment_id, workspace_id, trigger_status, recipient, pending_at,
       attempt_count, last_attempt_at, error,
       warehouse_shipments!inner(tracking_number, carrier, public_track_token, order_number)`,
    )
    .eq("status", "pending")
    .lt("pending_at", oneHourAgo)
    .order("pending_at", { ascending: true })
    .limit(limit);

  return (data ?? []).map((row) => {
    const rawShip = row.warehouse_shipments;
    const ship = (Array.isArray(rawShip) ? (rawShip[0] ?? {}) : (rawShip ?? {})) as Record<
      string,
      unknown
    >;
    return {
      id: row.id as string,
      shipment_id: row.shipment_id as string,
      workspace_id: row.workspace_id as string,
      trigger_status: row.trigger_status as string,
      recipient: row.recipient as string,
      pending_at: row.pending_at as string,
      attempt_count: (row.attempt_count as number) ?? 0,
      last_attempt_at: (row.last_attempt_at as string | null) ?? null,
      error: (row.error as string | null) ?? null,
      shipment_tracking_number: (ship.tracking_number as string | null) ?? null,
      shipment_carrier: (ship.carrier as string | null) ?? null,
      shipment_public_track_token: (ship.public_track_token as string | null) ?? null,
      shipment_order_number: (ship.order_number as string | null) ?? null,
    };
  });
}

export interface RecentFailureRow {
  id: string;
  shipment_id: string;
  workspace_id: string;
  trigger_status: string;
  recipient: string;
  status: string;
  error: string | null;
  created_at: string;
  shipment_public_track_token: string | null;
  shipment_order_number: string | null;
}

export async function getRecentNotificationFailures(limit = 50): Promise<RecentFailureRow[]> {
  await requireAuth();
  const supabase = await createServerSupabaseClient();
  const oneDayAgo = new Date(Date.now() - SIGNATURE_FAILURE_LOOKBACK_MS).toISOString();

  const { data } = await supabase
    .from("notification_sends")
    .select(
      `id, shipment_id, workspace_id, trigger_status, recipient, status, error, created_at,
       warehouse_shipments(public_track_token, order_number)`,
    )
    .in("status", ["provider_failed", "failed", "bounced", "complained"])
    .gte("created_at", oneDayAgo)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => {
    const rawShip = row.warehouse_shipments;
    const ship = (Array.isArray(rawShip) ? (rawShip[0] ?? {}) : (rawShip ?? {})) as Record<
      string,
      unknown
    >;
    return {
      id: row.id as string,
      shipment_id: row.shipment_id as string,
      workspace_id: row.workspace_id as string,
      trigger_status: row.trigger_status as string,
      recipient: row.recipient as string,
      status: row.status as string,
      error: (row.error as string | null) ?? null,
      created_at: row.created_at as string,
      shipment_public_track_token: (ship.public_track_token as string | null) ?? null,
      shipment_order_number: (ship.order_number as string | null) ?? null,
    };
  });
}

export interface SignatureFailureRow {
  id: string;
  platform: string;
  status: string;
  external_webhook_id: string | null;
  created_at: string;
  reason: string | null;
}

export async function getRecentSignatureFailures(limit = 50): Promise<SignatureFailureRow[]> {
  await requireAuth();
  const supabase = await createServerSupabaseClient();
  const oneDayAgo = new Date(Date.now() - SIGNATURE_FAILURE_LOOKBACK_MS).toISOString();

  const { data } = await supabase
    .from("webhook_events")
    .select("id, platform, status, external_webhook_id, created_at, metadata")
    .in("status", ["signature_failed", "invalid"])
    .gte("created_at", oneDayAgo)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id as string,
      platform: (row.platform as string | null) ?? "unknown",
      status: (row.status as string | null) ?? "unknown",
      external_webhook_id: (row.external_webhook_id as string | null) ?? null,
      created_at: row.created_at as string,
      reason: typeof meta.reason === "string" ? meta.reason : null,
    };
  });
}

export interface ShipmentNotificationLogRow {
  send: {
    id: string;
    trigger_status: string;
    status: string;
    recipient: string;
    template_id: string;
    pending_at: string;
    sent_at: string | null;
    delivered_at: string | null;
    bounced_at: string | null;
    complained_at: string | null;
    cancelled_at: string | null;
    error: string | null;
    resend_message_id: string | null;
    attempt_count: number;
  };
  providerEvents: Array<{
    id: string;
    provider: string;
    event_type: string | null;
    provider_event_id: string | null;
    received_at: string;
  }>;
  operatorEvents: Array<{
    id: string;
    actor_user_id: string | null;
    action: string;
    reason: string | null;
    previous_status: string | null;
    new_status: string | null;
    created_at: string;
  }>;
}

export async function getShipmentNotificationLog(
  shipmentId: string,
): Promise<ShipmentNotificationLogRow[]> {
  await requireAuth();
  const supabase = await createServerSupabaseClient();

  const { data: sends } = await supabase
    .from("notification_sends")
    .select(
      `id, trigger_status, status, recipient, template_id, pending_at, sent_at,
       delivered_at, bounced_at, complained_at, cancelled_at, error, resend_message_id,
       attempt_count`,
    )
    .eq("shipment_id", shipmentId)
    .order("pending_at", { ascending: false });

  const sendIds = (sends ?? []).map((s) => s.id as string);
  if (sendIds.length === 0) return [];

  const [{ data: providerEvents }, { data: operatorEvents }] = await Promise.all([
    supabase
      .from("notification_provider_events")
      .select("id, provider, event_type, provider_event_id, received_at, notification_send_id")
      .in("notification_send_id", sendIds)
      .order("received_at", { ascending: false })
      .limit(500),
    supabase
      .from("notification_operator_events")
      .select(
        "id, actor_user_id, action, reason, previous_status, new_status, created_at, notification_send_id",
      )
      .in("notification_send_id", sendIds)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  return (sends ?? []).map((send) => ({
    send: {
      id: send.id as string,
      trigger_status: send.trigger_status as string,
      status: send.status as string,
      recipient: send.recipient as string,
      template_id: send.template_id as string,
      pending_at: send.pending_at as string,
      sent_at: (send.sent_at as string | null) ?? null,
      delivered_at: (send.delivered_at as string | null) ?? null,
      bounced_at: (send.bounced_at as string | null) ?? null,
      complained_at: (send.complained_at as string | null) ?? null,
      cancelled_at: (send.cancelled_at as string | null) ?? null,
      error: (send.error as string | null) ?? null,
      resend_message_id: (send.resend_message_id as string | null) ?? null,
      attempt_count: (send.attempt_count as number) ?? 0,
    },
    providerEvents: (providerEvents ?? [])
      .filter((e) => e.notification_send_id === send.id)
      .map((e) => ({
        id: e.id as string,
        provider: e.provider as string,
        event_type: (e.event_type as string | null) ?? null,
        provider_event_id: (e.provider_event_id as string | null) ?? null,
        received_at: e.received_at as string,
      })),
    operatorEvents: (operatorEvents ?? [])
      .filter((e) => e.notification_send_id === send.id)
      .map((e) => ({
        id: e.id as string,
        actor_user_id: (e.actor_user_id as string | null) ?? null,
        action: e.action as string,
        reason: (e.reason as string | null) ?? null,
        previous_status: (e.previous_status as string | null) ?? null,
        new_status: (e.new_status as string | null) ?? null,
        created_at: e.created_at as string,
      })),
  }));
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function retryStuckNotification(notificationSendId: string, reason?: string) {
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Forbidden");
  const supabase = await createServerSupabaseClient();

  // Cancel the stuck pending row through the state machine + audit.
  // The send-tracking-email task is idempotent on (shipment_id, trigger_status)
  // so re-enqueueing creates a fresh pending row when the cron fires.
  const verdict = await applyOperatorNotificationAction(supabase, {
    notificationSendId,
    actorUserId: ctx.userRecord.id,
    action: "retry",
    reason: reason ?? "operator-retry-from-ops-page",
  });

  if (!verdict.applied) {
    return { applied: false, skippedReason: verdict.skippedReason };
  }

  // Look up the shipment + trigger so we can re-fire send-tracking-email
  // immediately rather than waiting for the recon cron.
  const { data: send } = await supabase
    .from("notification_sends")
    .select("shipment_id, trigger_status")
    .eq("id", notificationSendId)
    .maybeSingle();
  if (!send) return { applied: true, reEnqueued: false };

  await tasks.trigger("send-tracking-email", {
    shipment_id: send.shipment_id,
    trigger_status: send.trigger_status,
  });
  return { applied: true, reEnqueued: true };
}

export async function cancelStuckNotification(notificationSendId: string, reason: string) {
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Forbidden");
  const supabase = await createServerSupabaseClient();

  const verdict = await applyOperatorNotificationAction(supabase, {
    notificationSendId,
    actorUserId: ctx.userRecord.id,
    action: "cancel",
    reason,
  });
  return { applied: verdict.applied, skippedReason: verdict.skippedReason };
}

export async function triggerNotificationFailureSensor() {
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Forbidden");
  const handle = await tasks.trigger("notification-failure-sensor", {});
  return { runId: handle.id };
}
