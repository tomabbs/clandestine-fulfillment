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
  const senderAddress = extractEmailAddress(email.realFrom);
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
      try {
        await tasks.trigger("bandcamp-sale-poll", {});
        await supabase
          .from("webhook_events")
          .update({ status: "processed", topic: "bandcamp_order" })
          .eq("id", webhookEventId);
      } catch (err) {
        Sentry.captureException(err, {
          tags: { route: "resend-inbound", failure: "bandcamp_poll_trigger_failed" },
        });
      }
      return { status: "bandcamp_order_poll_triggered" };
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

  // Strategy 2: sender-address match against support_email_mappings.
  const { data: emailMapping } = await supabase
    .from("support_email_mappings")
    .select("org_id")
    .eq("email_address", senderAddress)
    .eq("is_active", true)
    .maybeSingle();

  if (emailMapping) {
    await createConversationFromEmail(supabase, emailMapping.org_id, {
      subject: email.subject,
      body: email.text,
      messageId: email.messageId,
    });
    await supabase
      .from("webhook_events")
      .update({ status: "processed", topic: "support_new_conversation" })
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

function extractEmailAddress(from: string): string {
  // Handles:
  //   "Name <email@example.com>"   → email@example.com
  //   "email@example.com"          → email@example.com
  //   "a@x.com, b@y.com"           → a@x.com  (first only — defensive against
  //                                   recipient-list blobs leaking into the
  //                                   sender field)
  if (!from) return "";
  const angled = from.match(/<([^>]+)>/);
  if (angled) return angled[1].trim().toLowerCase();
  // Find FIRST RFC-ish address in the string (handles comma/space separated).
  const flat = from.match(/[\w.!#$%&'*+\-/=?^_`{|}~]+@[\w.-]+\.[A-Za-z]{2,}/);
  return (flat ? flat[0] : from.trim()).toLowerCase();
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
  email: { subject: string; body: string; messageId: string },
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
