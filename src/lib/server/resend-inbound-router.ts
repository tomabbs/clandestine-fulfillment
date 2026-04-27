/**
 * Resend inbound email router.
 *
 * Pure-ish function over (supabase, workspaceId, email) — no env reads, no
 * header parsing — so the replay script (`scripts/_replay-resend-inbound.ts`)
 * can call it directly to re-run historical webhook_events rows after a
 * route-handler bug fix.
 *
 * Owned by the resend-inbound route (see `src/app/api/webhooks/resend-inbound/route.ts`).
 */

import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import type { FetchedInboundEmail } from "@/lib/clients/resend-client";
import type { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  extractSupportEmailAddress,
  resolveSupportEmailContext,
} from "@/lib/server/support-email-resolution";

const OPTIONAL_SUPPORT_CONVERSATION_COLUMNS = ["client_last_read_at"] as const;
const OPTIONAL_SUPPORT_MESSAGE_COLUMNS = ["source", "delivered_via_email"] as const;

function isMissingColumnMessage(message: string, columns: readonly string[]): boolean {
  return columns.some((column) => message.includes(`Could not find the '${column}' column`));
}

export interface RouteResult {
  status: string;
}

export async function routeInboundEmail({
  supabase,
  workspaceId,
  webhookEventId,
  email,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  workspaceId: string;
  webhookEventId: string;
  email: FetchedInboundEmail;
}): Promise<RouteResult> {
  // R-4: use the recovered REAL sender (from headers), not the envelope
  // `from` (which is rewritten by Gmail/Workspace forwarding rules).
  const senderAddress = extractSupportEmailAddress(email.realFrom);
  const subjectRaw = email.subject;
  const subjectLower = subjectRaw.toLowerCase();
  const bodyLower = email.text.toLowerCase();

  const isBandcamp =
    /^noreply@bandcamp\.com$/i.test(senderAddress) ||
    /bandcamp\.com$/i.test(senderAddress) ||
    // Subject-line fallback for forwarders that strip every header — every
    // real Bandcamp email starts with one of these phrases.
    /^(bam!|cha-ching!)/i.test(subjectRaw) ||
    /a message from bandcamp/i.test(subjectLower) ||
    /new (release|music|album|ep|single) from/i.test(subjectLower);

  if (isBandcamp) {
    const isBandcampOrder =
      /^(bam!|cha-ching!)/i.test(subjectRaw) ||
      /another order for/i.test(subjectLower) ||
      /just (bought|paid)/i.test(bodyLower);

    const isBandcampNewRelease =
      /new (release|music|album|ep|single) from/i.test(subjectLower) ||
      /just (released|dropped)/i.test(subjectLower);

    const isBandcampFanMessage =
      /a message from bandcamp/i.test(subjectLower) || /on behalf of/i.test(subjectLower);

    if (isBandcampOrder) {
      const dispatch = await dispatchBandcampOrderPoll({
        supabase,
        workspaceId,
        webhookEventId,
        email,
      });
      return { status: dispatch.status };
    }

    if (isBandcampNewRelease) {
      await supabase
        .from("webhook_events")
        .update({ status: "dismissed", topic: "bandcamp_new_release" })
        .eq("id", webhookEventId);
      return { status: "bandcamp_new_release_skipped" };
    }

    if (isBandcampFanMessage) {
      // Fall through to support-conversation routing below — staff can
      // reply and Bandcamp relays the reply to the fan.
    }
  }

  // Strategy 1: thread match via In-Reply-To / References against existing
  // support_messages.
  const relatedMessageIdCandidates = [email.inReplyTo, ...email.references].filter(
    (value): value is string => Boolean(value),
  );

  if (relatedMessageIdCandidates.length > 0) {
    const { data: existingMessage } = await supabase
      .from("support_messages")
      .select("conversation_id")
      .in("email_message_id", relatedMessageIdCandidates)
      .limit(1)
      .maybeSingle();

    if (existingMessage) {
      await appendMessageToConversation(supabase, existingMessage.conversation_id, {
        body: email.text,
        messageId: email.messageId,
      });
      await supabase
        .from("webhook_events")
        .update({ status: "processed", topic: "support_thread_reply" })
        .eq("id", webhookEventId);
      return { status: "support_thread_reply" };
    }
  }

  // Strategy 2: sender/body-aware resolver. Bandcamp fan messages come from
  // noreply@bandcamp.com, so the sender alone is intentionally low-signal.
  // Prefer the Bandcamp transaction in the body, then customer/order email,
  // then client login/support mapping email.
  const resolution = await resolveSupportEmailContext({
    supabase,
    workspaceId,
    senderAddress,
    subject: email.subject,
    body: email.text,
  });

  if (resolution.orgId) {
    await createConversationFromEmail(supabase, resolution.orgId, {
      subject: email.subject,
      body: email.text,
      messageId: email.messageId,
      sourceChannel: resolution.source === "bandcamp_transaction" ? "bandcamp_fan" : "email",
      externalOrderId: resolution.order?.id ?? null,
      externalCustomerHandle: resolution.customerEmail,
    });
    await supabase
      .from("webhook_events")
      .update({
        status: "processed",
        topic: "support_new_conversation",
      })
      .eq("id", webhookEventId);
    return { status: "support_new_conversation" };
  }

  // Strategy 3: unmatched — review-queue item for manual triage.
  // R-5: correct column names. The schema is (category, severity, title,
  // description, metadata, group_key) — NOT (source, payload).
  //
  // Bug-fix (post-replay): `group_key` MUST be unique per email. Earlier
  // versions hashed only the sender address, which (combined with a
  // `pickRealFrom` bug that returned the same recipient-list string for every
  // unmatched email) collapsed every row into one and silently dedup'd ~140
  // rows down to a single review-queue entry. Always include the
  // webhook_event_id so each unmatched message gets its own row.
  const reviewInsert = await supabase.from("warehouse_review_queue").insert({
    workspace_id: workspaceId,
    category: "support_email_unmatched",
    severity: "medium",
    group_key: `unmatched_email:${webhookEventId}`,
    title: `Unmatched inbound support email from ${senderAddress || email.envelopeFrom}`,
    description: `Subject: ${email.subject}\n\nBody preview: ${email.text.slice(0, 500)}`,
    metadata: {
      email_id: email.emailId,
      message_id: email.messageId,
      envelope_from: email.envelopeFrom,
      real_from: email.realFrom,
      sender_address: senderAddress,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      body_text: email.text,
      body_html_preview: email.html?.slice(0, 2000) ?? null,
    },
  });
  if (reviewInsert.error) {
    // Loud + Sentry. Earlier this only Sentry-captured, which made silent
    // collisions invisible to local replay scripts and CI fixtures.
    console.error(
      `[resend-inbound] review_queue insert failed for webhookEventId=${webhookEventId}: ${reviewInsert.error.message}`,
    );
    Sentry.captureException(reviewInsert.error, {
      tags: { route: "resend-inbound", failure: "review_queue_insert_failed" },
      extra: { senderAddress, emailId: email.emailId, webhookEventId },
    });
  }

  await supabase
    .from("webhook_events")
    .update({ status: "review_queued", topic: "support_email_unmatched" })
    .eq("id", webhookEventId);
  return { status: "review_queued" };
}

/**
 * Phase 2 §9.3 D1 — recipient-driven Bandcamp order dispatch.
 *
 * Tries to map the inbound email to a SPECIFIC `bandcamp_connections` row
 * via `inbound_forwarding_address`, in this priority:
 *
 *   1. Exact recipient match against `bandcamp_connections.inbound_forwarding_address`
 *      (case-insensitive). One match → enqueue
 *      `bandcamp-sale-poll-per-connection` (one Bandcamp API call). Multiple
 *      matches → ambiguous (operator config error) → fall back to global poll.
 *   2. No match → fall back to the global `bandcamp-sale-poll` cron (the
 *      legacy behaviour). Operator should configure the missing forwarding
 *      address via the audit script.
 *
 * Each branch records a `bandcamp.email_per_connection` sensor reading so
 * the Channels page (and any release-gate alarm) can monitor what fraction
 * of inbound order emails are landing on the cheap per-connection path vs
 * the expensive N-way fallback.
 *
 * The webhook_events row gets a `topic` of `bandcamp_order_per_connection`
 * (matched) or `bandcamp_order_global_fallback` (unmatched / ambiguous) so
 * forensics on the events table is one query without joining sensor_readings.
 */
async function dispatchBandcampOrderPoll({
  supabase,
  workspaceId,
  webhookEventId,
  email,
}: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  workspaceId: string;
  webhookEventId: string;
  email: FetchedInboundEmail;
}): Promise<{ status: string }> {
  // De-dup + lowercase recipients across `to` and `cc`. `envelopeTo` is
  // intentionally not consulted — operators forward FROM their Workspace
  // mailbox, so the envelope-to is the forwarding inbox (e.g.
  // orders@clandestinedistro.com) which would falsely match every connection
  // if its alias happened to be the same. The header `to`/`cc` arrays come
  // from the recovered RFC822 message, which preserves the original
  // recipient (e.g. orders+truepanther@…).
  const recipients = Array.from(
    new Set(
      [...email.to, ...email.cc]
        .map((addr) => extractSupportEmailAddress(addr))
        .filter((addr): addr is string => Boolean(addr)),
    ),
  );

  let matches: Array<{
    id: string;
    workspace_id: string;
    band_id: number;
    inbound_forwarding_address: string | null;
  }> = [];

  if (recipients.length > 0) {
    // `lower(inbound_forwarding_address)` index covers this exact predicate
    // (see migration 20260427000002). PostgREST `.in('column', [...])` is
    // case-sensitive, so we lowercase both sides — recipients are already
    // lowercased by extractEmailAddress, and the column is normalized by
    // the audit script before insert.
    const { data, error } = await supabase
      .from("bandcamp_connections")
      .select("id, workspace_id, band_id, inbound_forwarding_address")
      .eq("is_active", true)
      .in(
        "inbound_forwarding_address",
        recipients.map((r) => r.toLowerCase()),
      );
    if (error) {
      Sentry.captureException(error, {
        tags: { route: "resend-inbound", failure: "bandcamp_connection_lookup_failed" },
        extra: { webhookEventId, recipients },
      });
    }
    matches = data ?? [];
  }

  if (matches.length === 1) {
    const match = matches[0];
    try {
      await tasks.trigger(
        "bandcamp-sale-poll-per-connection",
        {
          workspaceId: match.workspace_id,
          connectionId: match.id,
          triggeredByWebhookEventId: webhookEventId,
          recipient: match.inbound_forwarding_address ?? null,
        },
        {
          // Belt-and-braces: the route handler's webhook_events INSERT ON
          // CONFLICT already drops duplicate Resend deliveries, but if a
          // Trigger.dev replay ever re-fires this side, the per-connection
          // task should not double-poll for the same email.
          idempotencyKey: `bandcamp-per-connection:${match.id}:${webhookEventId}`,
          idempotencyKeyTTL: "10m",
        },
      );
      await supabase
        .from("webhook_events")
        .update({ status: "processed", topic: "bandcamp_order_per_connection" })
        .eq("id", webhookEventId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: {
          route: "resend-inbound",
          failure: "bandcamp_per_connection_trigger_failed",
        },
        extra: { webhookEventId, connectionId: match.id },
      });
      // Do NOT fall back to the global poll here — the route handler's
      // outer try/catch will mark the event `routing_error` and the replay
      // job will re-run after the fix lands. Falling back silently would
      // mask Trigger.dev outages from the operator.
      throw err;
    }

    await recordEmailPerConnectionSensor(supabase, match.workspace_id, {
      outcome: "recipient_match",
      connection_id: match.id,
      band_id: match.band_id,
      recipient: match.inbound_forwarding_address ?? null,
      candidate_count: 1,
      webhook_event_id: webhookEventId,
    });

    return { status: "bandcamp_order_per_connection_dispatched" };
  }

  // Zero matches OR multiple matches → fall back to the global poll. We
  // record the outcome separately so the sensor distinguishes "operator
  // hasn't configured this band yet" (no_match) from "two connections share
  // an inbox alias" (ambiguous, real config bug).
  const fallbackOutcome = matches.length === 0 ? "no_match_fallback" : "ambiguous_fallback";

  try {
    await tasks.trigger("bandcamp-sale-poll", {});
    await supabase
      .from("webhook_events")
      .update({ status: "processed", topic: "bandcamp_order_global_fallback" })
      .eq("id", webhookEventId);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "resend-inbound", failure: "bandcamp_poll_trigger_failed" },
      extra: { webhookEventId, fallbackOutcome },
    });
    // Same reasoning as the per-connection branch — surface the failure to
    // the route handler so the event is marked routing_error for replay.
    throw err;
  }

  await recordEmailPerConnectionSensor(supabase, workspaceId, {
    outcome: fallbackOutcome,
    candidate_count: matches.length,
    candidate_ids: matches.map((m) => m.id),
    recipients,
    webhook_event_id: webhookEventId,
  });

  return {
    status:
      matches.length === 0
        ? "bandcamp_order_global_fallback_no_match"
        : "bandcamp_order_global_fallback_ambiguous",
  };
}

interface EmailPerConnectionSensorValue {
  outcome: "recipient_match" | "no_match_fallback" | "ambiguous_fallback";
  candidate_count: number;
  webhook_event_id: string;
  connection_id?: string;
  band_id?: number;
  recipient?: string | null;
  candidate_ids?: string[];
  recipients?: string[];
}

async function recordEmailPerConnectionSensor(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  value: EmailPerConnectionSensorValue,
): Promise<void> {
  // sensor_readings is a thin event log here — the sensor-check task does
  // NOT also synthesize this reading on a schedule (there's nothing to
  // poll for; the value is event-driven). Channels page aggregates by
  // `sensor_name='bandcamp.email_per_connection'` over the last hour
  // (matched / total) for the operator badge.
  //
  // Status mapping:
  //   recipient_match   → healthy   (cheap path worked)
  //   no_match_fallback → warning   (operator action: configure inbound address)
  //   ambiguous_fallback→ warning   (operator action: deduplicate alias)
  // We deliberately do NOT raise to `critical` for either fallback — both
  // are correct (the global poll still discovers the sale), just expensive.
  const status = value.outcome === "recipient_match" ? "healthy" : "warning";
  const message =
    value.outcome === "recipient_match"
      ? `Routed via inbound alias ${value.recipient ?? "(unknown)"} → connection ${value.connection_id}`
      : value.outcome === "no_match_fallback"
        ? `No bandcamp_connections.inbound_forwarding_address matched recipients=${(
            value.recipients ?? []
          ).join(", ")} — fell back to global poll`
        : `Ambiguous match: ${value.candidate_count} bandcamp_connections share recipients=${(
            value.recipients ?? []
          ).join(", ")} — fell back to global poll`;

  const { error } = await supabase.from("sensor_readings").insert({
    workspace_id: workspaceId,
    sensor_name: "bandcamp.email_per_connection",
    status,
    value,
    message,
  });
  if (error) {
    // Sensor failure is never fatal — log and move on.
    Sentry.captureException(error, {
      tags: { route: "resend-inbound", failure: "sensor_insert_failed" },
      extra: { workspaceId, value },
    });
  }
}

async function appendMessageToConversation(
  supabase: ReturnType<typeof createServiceRoleClient>,
  conversationId: string,
  email: { body: string; messageId: string },
): Promise<void> {
  if (email.messageId) {
    const { data: existingByMessageId } = await supabase
      .from("support_messages")
      .select("id")
      .eq("email_message_id", email.messageId)
      .maybeSingle();
    if (existingByMessageId) return;
  }

  const { data: conversation } = await supabase
    .from("support_conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .single();

  if (!conversation) return;

  let messageInsert = await supabase.from("support_messages").insert({
    conversation_id: conversationId,
    workspace_id: conversation.workspace_id,
    sender_type: "client",
    source: "email",
    delivered_via_email: true,
    body: email.body,
    email_message_id: email.messageId || null,
  });
  if (
    messageInsert.error &&
    isMissingColumnMessage(messageInsert.error.message, OPTIONAL_SUPPORT_MESSAGE_COLUMNS)
  ) {
    messageInsert = await supabase.from("support_messages").insert({
      conversation_id: conversationId,
      workspace_id: conversation.workspace_id,
      sender_type: "client",
      body: email.body,
      email_message_id: email.messageId || null,
    });
  }

  let conversationUpdate = await supabase
    .from("support_conversations")
    .update({
      status: "waiting_on_staff",
      updated_at: new Date().toISOString(),
      client_last_read_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
  if (
    conversationUpdate.error &&
    isMissingColumnMessage(conversationUpdate.error.message, OPTIONAL_SUPPORT_CONVERSATION_COLUMNS)
  ) {
    conversationUpdate = await supabase
      .from("support_conversations")
      .update({
        status: "waiting_on_staff",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
  }
}

async function createConversationFromEmail(
  supabase: ReturnType<typeof createServiceRoleClient>,
  orgId: string,
  email: {
    subject: string;
    body: string;
    messageId: string;
    sourceChannel?: "email" | "bandcamp_fan";
    externalOrderId?: string | null;
    externalCustomerHandle?: string | null;
  },
): Promise<void> {
  if (email.messageId) {
    const { data: existingByMessageId } = await supabase
      .from("support_messages")
      .select("id")
      .eq("email_message_id", email.messageId)
      .maybeSingle();
    if (existingByMessageId) return;
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("workspace_id")
    .eq("id", orgId)
    .single();

  const wsId = org?.workspace_id;
  if (!wsId) return;

  let { data: conversation, error: conversationError } = await supabase
    .from("support_conversations")
    .insert({
      workspace_id: wsId,
      org_id: orgId,
      subject: email.subject,
      status: "waiting_on_staff",
      inbound_email_id: email.messageId || null,
      source_channel: email.sourceChannel ?? "email",
      external_order_id: email.externalOrderId ?? null,
      external_customer_handle: email.externalCustomerHandle ?? null,
      client_last_read_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (
    conversationError &&
    isMissingColumnMessage(conversationError.message, OPTIONAL_SUPPORT_CONVERSATION_COLUMNS)
  ) {
    const retry = await supabase
      .from("support_conversations")
      .insert({
        workspace_id: wsId,
        org_id: orgId,
        subject: email.subject,
        status: "waiting_on_staff",
        inbound_email_id: email.messageId || null,
        source_channel: email.sourceChannel ?? "email",
        external_order_id: email.externalOrderId ?? null,
        external_customer_handle: email.externalCustomerHandle ?? null,
      })
      .select("id")
      .single();
    conversation = retry.data;
    conversationError = retry.error;
  }

  if (conversationError || !conversation) return;

  let messageInsert = await supabase.from("support_messages").insert({
    conversation_id: conversation.id,
    workspace_id: wsId,
    sender_type: "client",
    source: "email",
    source_channel: email.sourceChannel ?? "email",
    direction: "inbound",
    delivered_via_email: true,
    body: email.body,
    email_message_id: email.messageId || null,
  });
  if (
    messageInsert.error &&
    isMissingColumnMessage(messageInsert.error.message, OPTIONAL_SUPPORT_MESSAGE_COLUMNS)
  ) {
    messageInsert = await supabase.from("support_messages").insert({
      conversation_id: conversation.id,
      workspace_id: wsId,
      sender_type: "client",
      body: email.body,
      email_message_id: email.messageId || null,
    });
  }
}
