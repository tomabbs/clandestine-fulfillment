import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { parseInboundEmail } from "@/lib/clients/resend-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

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

  // Resolve workspace from DB (no user auth in webhook context)
  const workspaceIds = await getAllWorkspaceIds(supabase);
  const workspaceId = workspaceIds[0];
  if (!workspaceId) {
    return NextResponse.json({ error: "No workspace configured" }, { status: 500 });
  }

  // Rule #62: Dedup via webhook_events INSERT ON CONFLICT
  const { data: dedupRow } = await supabase
    .from("webhook_events")
    .insert({
      workspace_id: workspaceId,
      platform: "resend",
      external_webhook_id: svixId,
      payload: JSON.parse(rawBody),
    })
    .select("id")
    .single();

  if (!dedupRow) {
    // Already processed — return 200 OK immediately
    return NextResponse.json({ ok: true });
  }

  // Parse the Resend inbound email event
  const eventData = JSON.parse(rawBody);
  // Resend wraps inbound email in a `data` field for event payloads
  const emailPayload = eventData.data ?? eventData;
  const email = parseInboundEmail(emailPayload);

  const relatedMessageIdCandidates = [email.inReplyTo, ...email.references].filter(
    (value): value is string => Boolean(value),
  );

  // Strategy 1: Match by In-Reply-To / References against existing messages
  if (relatedMessageIdCandidates.length > 0) {
    const { data: existingMessage } = await supabase
      .from("support_messages")
      .select("conversation_id")
      .in("email_message_id", relatedMessageIdCandidates)
      .limit(1)
      .maybeSingle();

    if (existingMessage) {
      await appendMessageToConversation(supabase, existingMessage.conversation_id, email);
      return NextResponse.json({ ok: true });
    }
  }

  // Strategy 2: Match by sender email address via support_email_mappings
  const senderAddress = extractEmailAddress(email.from);
  const { data: emailMapping } = await supabase
    .from("support_email_mappings")
    .select("org_id")
    .eq("email_address", senderAddress)
    .eq("is_active", true)
    .single();

  if (emailMapping) {
    await createConversationFromEmail(supabase, emailMapping.org_id, email);
    return NextResponse.json({ ok: true });
  }

  // Strategy 3: Unmatched — create review queue item for staff to manually route
  await supabase.from("warehouse_review_queue").insert({
    workspace_id: workspaceId,
    source: "support_email",
    severity: "medium",
    group_key: `unmatched_email:${senderAddress}`,
    title: `Unmatched inbound support email from ${senderAddress}`,
    description: `Subject: ${email.subject}\n\nBody preview: ${email.body.slice(0, 500)}`,
    payload: { email },
  });

  return NextResponse.json({ ok: true });
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
  const { data: existingByMessageId } = await supabase
    .from("support_messages")
    .select("id")
    .eq("email_message_id", email.messageId)
    .maybeSingle();

  if (existingByMessageId) return;

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
    email_message_id: email.messageId,
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
      email_message_id: email.messageId,
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
  const { data: existingByMessageId } = await supabase
    .from("support_messages")
    .select("id")
    .eq("email_message_id", email.messageId)
    .maybeSingle();

  if (existingByMessageId) return;

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
      inbound_email_id: email.messageId,
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
        inbound_email_id: email.messageId,
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
    email_message_id: email.messageId,
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
      email_message_id: email.messageId,
    });
  }
}
