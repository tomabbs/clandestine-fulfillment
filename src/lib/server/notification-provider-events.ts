// Slice 1 — append-only provider event ledger helpers.
//
// Every raw provider event (Resend delivered / bounced / complained / etc.,
// and every EasyPost tracker.updated) is recorded here BEFORE we attempt
// any rollup transition on notification_sends or warehouse_shipments. The
// ledger is the immutable history; the rollup is the mutable
// "where is this notification today" view. This is the contract that lets
// the per-shipment audit drilldown (Slice 4) render a single time-ordered
// timeline across providers.
//
// All writes are idempotent on (provider, provider_event_id). On 23505 the
// helper returns the prior row so the caller can keep going.

import type { SupabaseClient } from "@supabase/supabase-js";

export type NotificationProvider = "resend" | "easypost";

export interface NotificationProviderEventInput {
  provider: NotificationProvider;
  providerEventId: string;
  eventType: string;
  providerMessageId?: string | null;
  workspaceId?: string | null;
  notificationSendId?: string | null;
  shipmentId?: string | null;
  recipient?: string | null;
  occurredAt?: string | null;
  payload: Record<string, unknown>;
}

export interface NotificationProviderEventRow {
  id: string;
  provider: NotificationProvider;
  provider_event_id: string;
  event_type: string;
  provider_message_id: string | null;
  workspace_id: string | null;
  notification_send_id: string | null;
  shipment_id: string | null;
  recipient: string | null;
  occurred_at: string | null;
  received_at: string;
  payload: Record<string, unknown>;
}

/**
 * Insert a provider event into the append-only ledger. Idempotent on
 * (provider, provider_event_id): a duplicate insert returns the existing
 * row instead of throwing. Recipient is lower-cased before persistence so
 * downstream lookups don't depend on case quirks. workspace_id /
 * shipment_id are populated when the route can derive them; nullable so
 * an unmatched event still lands in the ledger for forensics.
 */
export async function recordProviderEvent(
  supabase: SupabaseClient,
  input: NotificationProviderEventInput,
): Promise<NotificationProviderEventRow> {
  const row = {
    provider: input.provider,
    provider_event_id: input.providerEventId,
    event_type: input.eventType,
    provider_message_id: input.providerMessageId ?? null,
    workspace_id: input.workspaceId ?? null,
    notification_send_id: input.notificationSendId ?? null,
    shipment_id: input.shipmentId ?? null,
    recipient: input.recipient ? input.recipient.toLowerCase() : null,
    occurred_at: input.occurredAt ?? null,
    payload: input.payload,
  };
  const { data, error } = await supabase
    .from("notification_provider_events")
    .insert(row)
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const { data: existing } = await supabase
        .from("notification_provider_events")
        .select("*")
        .eq("provider", input.provider)
        .eq("provider_event_id", input.providerEventId)
        .maybeSingle();
      if (existing) return existing as NotificationProviderEventRow;
    }
    throw new Error(`recordProviderEvent failed: ${error.message}`);
  }
  if (!data) throw new Error("recordProviderEvent returned no row");
  return data as NotificationProviderEventRow;
}
