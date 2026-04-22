import crypto from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import { NextResponse } from "next/server";
import {
  type FetchedInboundEmail,
  fetchInboundEmail,
  parseInboundWebhook,
} from "@/lib/clients/resend-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPTIONAL_SUPPORT_CONVERSATION_COLUMNS = ["client_last_read_at"] as const;
const OPTIONAL_SUPPORT_MESSAGE_COLUMNS = ["source", "delivered_via_email"] as const;

function isMissingColumnMessage(message: string, columns: readonly string[]): boolean {
  return columns.some((column) => message.includes(`Could not find the '${column}' column`));
}

// Rule #63: Verify Resend Svix signature before any side effects
function verifySvixSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
): boolean {
  const secret = env().RESEND_INBOUND_WEBHOOK_SECRET;
  // Svix secrets are base64-encoded, prefixed with "whsec_"
  const secretBytes = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac("sha256", secretBytes)
    .update(toSign)
    .digest("base64");

  // Svix signature header may contain multiple signatures: "v1,<sig1> v1,<sig2>"
  const signatures = svixSignature.split(" ");
  for (const sig of signatures) {
    const sigValue = sig.startsWith("v1,") ? sig.slice(3) : sig;
    if (crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(sigValue))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the workspace that should own this inbound email.
 *
 * Single-tenant deployments: just the oldest workspace, deterministic
 * (matches the workspace seeded at install). When we go multi-tenant we'll
 * need to derive workspace from the destination address (envelopeTo).
 *
 * R-7: ORDER BY created_at ASC fixes the prior heap-order bug where the
 * "first" workspace returned by Postgres could vary between calls.
 */
async function resolveWorkspaceId(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    Sentry.captureException(error, {
      tags: { route: "resend-inbound", failure: "workspace_lookup_failed" },
    });
    return null;
  }
  return data?.id ?? null;
}

export async function POST(req: Request): Promise<Response> {
  // Rule #36: Always use req.text() for raw body
  const rawBody = await req.text();

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing signature headers" }, { status: 401 });
  }

  // Replay protection: reject webhooks older than 5 minutes
  const timestampSeconds = Number.parseInt(svixTimestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > 300) {
    return NextResponse.json({ error: "Timestamp too old" }, { status: 401 });
  }

  if (!verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  // R-7: deterministic workspace resolution.
  const workspaceId = await resolveWorkspaceId(supabase);
  if (!workspaceId) {
    Sentry.captureMessage("[resend-inbound] no workspace configured", {
      level: "error",
      tags: { route: "resend-inbound", failure: "no_workspace" },
    });
    return NextResponse.json({ error: "No workspace configured" }, { status: 500 });
  }

  // Rule #62: Dedup via webhook_events INSERT ON CONFLICT
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { data: dedupRow, error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      workspace_id: workspaceId,
      platform: "resend",
      external_webhook_id: svixId,
      topic: "email.received",
      metadata: parsedBody,
    })
    .select("id")
    .single();

  if (!dedupRow) {
    if (dedupError?.code === "23505") {
      // True duplicate — Resend retried a delivery we already processed.
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    // Any other failure (RLS, schema drift, network hiccup) — DO NOT
    // silently 200. Sentry-capture and 500 so Resend retries.
    Sentry.captureException(dedupError ?? new Error("webhook_events insert returned no row"), {
      tags: { route: "resend-inbound", failure: "dedup_insert_failed" },
    });
    return NextResponse.json({ error: "dedup insert failed" }, { status: 500 });
  }

  // R-1: parse the Resend webhook envelope (NOT the email body — that
  // requires a separate API call, see R-2 below).
  let envelope: ReturnType<typeof parseInboundWebhook>;
  try {
    envelope = parseInboundWebhook(parsedBody);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "resend-inbound", failure: "envelope_parse_failed" },
      extra: { rawBodyPreview: rawBody.slice(0, 500) },
    });
    await supabase
      .from("webhook_events")
      .update({ status: "envelope_parse_failed" })
      .eq("id", dedupRow.id);
    // 200 so Resend stops retrying — the row is in the DB for forensics
    // and the replay job (scripts/_replay-resend-inbound.ts) can re-run
    // once the schema is fixed.
    return NextResponse.json({ ok: true, status: "envelope_parse_failed" });
  }

  // Resend only sends `email.received` for inbound; bail safely on anything
  // else (the OUTBOUND delivery-status events go to /api/webhooks/resend).
  if (envelope.type !== "email.received") {
    await supabase
      .from("webhook_events")
      .update({ status: "ignored_event_type" })
      .eq("id", dedupRow.id);
    return NextResponse.json({ ok: true, status: "ignored_event_type", type: envelope.type });
  }

  // R-2: fetch the full email content (body + headers + recovered real
  // sender) via the Resend Receiving API. The webhook envelope alone has
  // none of these.
  let email: FetchedInboundEmail;
  try {
    email = await fetchInboundEmail(envelope.emailId);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "resend-inbound", failure: "fetch_body_failed" },
      extra: { emailId: envelope.emailId },
    });
    await supabase
      .from("webhook_events")
      .update({ status: "fetch_body_failed" })
      .eq("id", dedupRow.id);
    // 500 so Resend retries — the body fetch is transient (Resend API
    // outage, 429, etc.) and the email_id is stable.
    return NextResponse.json({ error: "fetch body failed" }, { status: 500 });
  }

  try {
    const result = await routeInboundEmail({
      supabase,
      workspaceId,
      webhookEventId: dedupRow.id,
      email,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "resend-inbound", failure: "routing_error" },
      extra: { emailId: envelope.emailId, realFrom: email.realFrom },
    });
    await supabase
      .from("webhook_events")
      .update({ status: "routing_error" })
      .eq("id", dedupRow.id);
    // 200 — the row is captured, replay job can re-fire after the bug fix.
    return NextResponse.json({ ok: true, status: "routing_error" });
  }
}

interface RouteResult {
  status: string;
}

/**
 * Top-level inbound-email router. Pure function over (supabase, workspaceId,
 * email) — no env reads, no header parsing — so the replay script can call
 * it directly to re-run historical webhook_events rows.
 */
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
        // Non-critical — regular poll will pick it up. Capture for
        // visibility but don't fail the route.
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
  const reviewInsert = await supabase.from("warehouse_review_queue").insert({
    workspace_id: workspaceId,
    category: "support_email_unmatched",
    severity: "medium",
    group_key: `unmatched_email:${senderAddress}`,
    title: `Unmatched inbound support email from ${senderAddress}`,
    description: `Subject: ${email.subject}\n\nBody preview: ${email.text.slice(0, 500)}`,
    metadata: {
      email_id: email.emailId,
      message_id: email.messageId,
      envelope_from: email.envelopeFrom,
      real_from: email.realFrom,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      body_text: email.text,
      body_html_preview: email.html?.slice(0, 2000) ?? null,
    },
  });
  if (reviewInsert.error) {
    Sentry.captureException(reviewInsert.error, {
      tags: { route: "resend-inbound", failure: "review_queue_insert_failed" },
      extra: { senderAddress, emailId: email.emailId },
    });
  }

  await supabase
    .from("webhook_events")
    .update({ status: "review_queued", topic: "support_email_unmatched" })
    .eq("id", webhookEventId);
  return { status: "review_queued" };
}

function extractEmailAddress(from: string): string {
  // Handles "Name <email@example.com>" or plain "email@example.com"
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from.trim()).toLowerCase();
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

  // Get conversation workspace_id for the message
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

  // Resolve workspace from the org
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
