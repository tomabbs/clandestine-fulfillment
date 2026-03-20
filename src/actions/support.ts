"use server";

import { z } from "zod";
import { sendSupportEmail } from "@/lib/clients/resend-client";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { STAFF_ROLES } from "@/lib/shared/constants";
import type { ConversationStatus, SupportConversation, SupportMessage } from "@/lib/shared/types";

const OPTIONAL_SUPPORT_CONVERSATION_COLUMNS = [
  "client_last_read_at",
  "staff_last_read_at",
] as const;
const OPTIONAL_SUPPORT_MESSAGE_COLUMNS = ["source", "delivered_via_email"] as const;

function isMissingColumnMessage(message: string, columns: readonly string[]): boolean {
  return columns.some((column) => message.includes(`Could not find the '${column}' column`));
}

function isMissingColumnError(error: unknown, columns: readonly string[]): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return isMissingColumnMessage(msg, columns);
}

async function getAuthContext() {
  const { supabase, userRecord, isStaff } = await requireAuth();
  return {
    supabase,
    user: userRecord,
    isStaff,
    workspaceId: userRecord.workspace_id,
  };
}

const getConversationsSchema = z.object({
  status: z
    .enum(["open", "waiting_on_client", "waiting_on_staff", "resolved", "closed"])
    .optional(),
  orgId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export async function getConversations(
  filters: z.input<typeof getConversationsSchema> = {},
): Promise<{
  conversations: (SupportConversation & {
    org_name?: string;
    last_message_at?: string;
    last_message_preview?: string;
    unread_count?: number;
    counterpart_last_seen_at?: string | null;
  })[];
  total: number;
}> {
  const { status, orgId, assignedTo, page, pageSize } = getConversationsSchema.parse(filters);
  let supabase: Awaited<ReturnType<typeof getAuthContext>>["supabase"];
  let isStaff = false;
  try {
    const auth = await getAuthContext();
    supabase = auth.supabase;
    isStaff = auth.isStaff;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      return { conversations: [], total: 0 };
    }
    throw error;
  }

  // RLS handles staff-sees-all vs client-sees-own-org
  let query = supabase
    .from("support_conversations")
    .select("*, organizations!inner(name)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (orgId) query = query.eq("org_id", orgId);
  if (assignedTo) query = query.eq("assigned_to", assignedTo);

  query = query
    .order("updated_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(`Failed to fetch conversations: ${error.message}`);

  // Fetch last message per conversation for preview
  const conversationIds = (data ?? []).map((c: { id: string }) => c.id);
  const lastMessages: Record<
    string,
    { body: string; created_at: string; sender_type: SupportMessage["sender_type"] }
  > = {};

  if (conversationIds.length > 0) {
    const { data: messages } = await supabase
      .from("support_messages")
      .select("conversation_id, body, created_at, sender_type")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: false });

    if (messages) {
      for (const msg of messages) {
        if (!lastMessages[msg.conversation_id]) {
          lastMessages[msg.conversation_id] = {
            body: msg.body,
            created_at: msg.created_at,
            sender_type: (msg.sender_type as SupportMessage["sender_type"]) ?? "system",
          };
        }
      }
    }
  }

  const conversations = (data ?? []).map((c: Record<string, unknown>) => {
    const org = c.organizations as { name: string } | null;
    const lastMsg = lastMessages[(c as { id: string }).id];
    const readAt = isStaff
      ? (c.staff_last_read_at as string | null | undefined)
      : (c.client_last_read_at as string | null | undefined);
    const unreadCount = lastMsg
      ? lastMsg.sender_type === (isStaff ? "staff" : "client")
        ? 0
        : readAt
          ? lastMsg.created_at > readAt
            ? 1
            : 0
          : 1
      : 0;

    return {
      ...(c as unknown as SupportConversation),
      org_name: org?.name,
      last_message_at: lastMsg?.created_at,
      last_message_preview: lastMsg?.body?.slice(0, 120),
      unread_count: unreadCount,
      counterpart_last_seen_at: isStaff
        ? ((c.client_last_read_at as string | null | undefined) ?? null)
        : ((c.staff_last_read_at as string | null | undefined) ?? null),
    };
  });

  return { conversations, total: count ?? 0 };
}

export async function getConversationDetail(id: string): Promise<{
  conversation: SupportConversation & { org_name?: string; assigned_name?: string };
  messages: SupportMessage[];
}> {
  z.string().uuid().parse(id);
  let supabase: Awaited<ReturnType<typeof getAuthContext>>["supabase"];
  try {
    const auth = await getAuthContext();
    supabase = auth.supabase;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      throw new Error("Conversation not found");
    }
    throw error;
  }

  const { data: conversation, error: convError } = await supabase
    .from("support_conversations")
    .select(
      "*, organizations!inner(name), assigned_user:users!support_conversations_assigned_to_fkey(name)",
    )
    .eq("id", id)
    .single();

  if (convError || !conversation) throw new Error("Conversation not found");

  const { data: messages, error: msgError } = await supabase
    .from("support_messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  if (msgError) throw new Error(`Failed to fetch messages: ${msgError.message}`);

  const org = conversation.organizations as { name: string } | null;
  const assignedUser = conversation.assigned_user as { name: string } | null;

  return {
    conversation: {
      ...(conversation as unknown as SupportConversation),
      org_name: org?.name,
      assigned_name: assignedUser?.name,
    },
    messages: (messages ?? []) as SupportMessage[],
  };
}

export async function getSupportViewerContext(): Promise<{
  userId: string;
  userName: string;
  role: "staff" | "client";
  orgId: string | null;
}> {
  const { user, isStaff } = await getAuthContext();
  return {
    userId: user.id,
    userName: user.name ?? user.email ?? "Unknown User",
    role: isStaff ? "staff" : "client",
    orgId: user.org_id,
  };
}

const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10000),
  orgId: z.string().uuid().optional(),
});

export type CreateConversationResult =
  | { success: true; conversationId: string }
  | { success: false; error: string };

export async function createConversation(
  input: z.input<typeof createConversationSchema>,
): Promise<CreateConversationResult> {
  try {
    const parsed = createConversationSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: "Please provide a valid subject and message." };
    }
    const { subject, body, orgId } = parsed.data;
    const { user, isStaff, workspaceId } = await getAuthContext();
    const serviceClient = createServiceRoleClient();

    // Staff can specify orgId; clients can only use their own org.
    const targetOrgId = isStaff ? orgId : user.org_id;
    if (!targetOrgId) {
      return { success: false, error: "Organization required." };
    }
    if (!isStaff && targetOrgId !== user.org_id) {
      return { success: false, error: "Unauthorized organization access." };
    }

    const createConversationPayload = {
      workspace_id: workspaceId,
      org_id: targetOrgId,
      subject,
      status: isStaff ? "waiting_on_client" : "waiting_on_staff",
      created_by: user.id,
      ...(isStaff
        ? { staff_last_read_at: new Date().toISOString() }
        : { client_last_read_at: new Date().toISOString() }),
    };

    let { data: conversation, error: convError } = await serviceClient
      .from("support_conversations")
      .insert(createConversationPayload)
      .select("id")
      .single();

    if (
      convError &&
      isMissingColumnMessage(convError.message, OPTIONAL_SUPPORT_CONVERSATION_COLUMNS)
    ) {
      const retry = await serviceClient
        .from("support_conversations")
        .insert({
          workspace_id: workspaceId,
          org_id: targetOrgId,
          subject,
          status: isStaff ? "waiting_on_client" : "waiting_on_staff",
          created_by: user.id,
        })
        .select("id")
        .single();
      conversation = retry.data;
      convError = retry.error;
    }

    if (convError || !conversation) {
      return {
        success: false,
        error: `Failed to create conversation: ${convError?.message ?? "unknown error"}`,
      };
    }

    let { error: messageError } = await serviceClient.from("support_messages").insert({
      conversation_id: conversation.id,
      workspace_id: workspaceId,
      sender_id: user.id,
      sender_type: isStaff ? "staff" : "client",
      source: "app",
      body,
    });
    if (
      messageError &&
      isMissingColumnError(messageError.message, OPTIONAL_SUPPORT_MESSAGE_COLUMNS)
    ) {
      const retry = await serviceClient.from("support_messages").insert({
        conversation_id: conversation.id,
        workspace_id: workspaceId,
        sender_id: user.id,
        sender_type: isStaff ? "staff" : "client",
        body,
      });
      messageError = retry.error;
    }
    if (messageError) {
      return { success: false, error: `Failed to create message: ${messageError.message}` };
    }

    // Best-effort notification email when staff opens a conversation.
    if (isStaff) {
      const { data: mappings } = await serviceClient
        .from("support_email_mappings")
        .select("email_address")
        .eq("org_id", targetOrgId)
        .eq("is_active", true);

      if (mappings?.length) {
        for (const mapping of mappings) {
          try {
            await sendSupportEmail(mapping.email_address, subject, body);
          } catch (emailError) {
            console.error("[support] failed to send conversation email:", emailError);
          }
        }
      }
    }

    return { success: true, conversationId: conversation.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unexpected support error: ${msg}` };
  }
}

const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1).max(10000),
});

export type SendMessageResult =
  | { success: true; messageId: string }
  | { success: false; error: string };

export async function sendMessage(
  input: z.input<typeof sendMessageSchema>,
): Promise<SendMessageResult> {
  try {
    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: "Please enter a valid message." };

    const { conversationId, body } = parsed.data;
    const { user, isStaff, workspaceId } = await getAuthContext();
    const serviceClient = createServiceRoleClient();

    // Load conversation and enforce access for client users.
    const { data: conversation, error: convError } = await serviceClient
      .from("support_conversations")
      .select("id, subject, org_id, assigned_to, status")
      .eq("id", conversationId)
      .single();

    if (convError || !conversation) return { success: false, error: "Conversation not found." };
    if (!isStaff && conversation.org_id !== user.org_id) {
      return { success: false, error: "You do not have access to this conversation." };
    }

    const senderType = isStaff ? "staff" : "client";
    const newStatus: ConversationStatus = isStaff ? "waiting_on_client" : "waiting_on_staff";

    let { data: message, error: msgError } = await serviceClient
      .from("support_messages")
      .insert({
        conversation_id: conversationId,
        workspace_id: workspaceId,
        sender_id: user.id,
        sender_type: senderType,
        source: "app",
        body,
      })
      .select("id, email_message_id")
      .single();

    if (msgError && isMissingColumnMessage(msgError.message, OPTIONAL_SUPPORT_MESSAGE_COLUMNS)) {
      const retry = await serviceClient
        .from("support_messages")
        .insert({
          conversation_id: conversationId,
          workspace_id: workspaceId,
          sender_id: user.id,
          sender_type: senderType,
          body,
        })
        .select("id, email_message_id")
        .single();
      message = retry.data;
      msgError = retry.error;
    }

    if (msgError || !message) {
      return { success: false, error: `Failed to send message: ${msgError?.message}` };
    }

    const conversationUpdate = await serviceClient
      .from("support_conversations")
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
        ...(isStaff
          ? { staff_last_read_at: new Date().toISOString() }
          : { client_last_read_at: new Date().toISOString() }),
      })
      .eq("id", conversationId);
    if (
      conversationUpdate.error &&
      isMissingColumnMessage(
        conversationUpdate.error.message,
        OPTIONAL_SUPPORT_CONVERSATION_COLUMNS,
      )
    ) {
      await serviceClient
        .from("support_conversations")
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    }

    // Best-effort email fanout.
    if (isStaff) {
      const { data: mappings } = await serviceClient
        .from("support_email_mappings")
        .select("email_address")
        .eq("org_id", conversation.org_id)
        .eq("is_active", true);

      const { data: lastEmailMsg } = await serviceClient
        .from("support_messages")
        .select("email_message_id")
        .eq("conversation_id", conversationId)
        .not("email_message_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (mappings?.length) {
        for (const mapping of mappings) {
          try {
            const result = await sendSupportEmail(
              mapping.email_address,
              `Re: ${conversation.subject}`,
              body,
              lastEmailMsg?.email_message_id ?? undefined,
            );
            // Older DBs may not have delivered_via_email yet.
            // Retry with minimal payload to avoid failing message send flow.
            const updateResult = await serviceClient
              .from("support_messages")
              .update({ email_message_id: result.messageId, delivered_via_email: true })
              .eq("id", message.id);
            if (
              updateResult.error &&
              isMissingColumnMessage(updateResult.error.message, OPTIONAL_SUPPORT_MESSAGE_COLUMNS)
            ) {
              await serviceClient
                .from("support_messages")
                .update({ email_message_id: result.messageId })
                .eq("id", message.id);
            }
          } catch (emailError) {
            console.error("[support] failed to send staff reply email:", emailError);
          }
        }
      }
    } else {
      const { data: staffUsers } = conversation.assigned_to
        ? await serviceClient.from("users").select("email").eq("id", conversation.assigned_to)
        : await serviceClient
            .from("users")
            .select("email")
            .eq("workspace_id", workspaceId)
            .in("role", [...STAFF_ROLES]);

      if (staffUsers?.length) {
        for (const staffUser of staffUsers) {
          if (staffUser.email) {
            try {
              await sendSupportEmail(
                staffUser.email,
                `Re: ${conversation.subject}`,
                `New reply from client:\n\n${body}`,
              );
            } catch (emailError) {
              console.error("[support] failed to send client reply email:", emailError);
            }
          }
        }
      }
    }

    return { success: true, messageId: message.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unexpected support error: ${msg}` };
  }
}

export async function resolveConversation(id: string): Promise<void> {
  z.string().uuid().parse(id);
  const { supabase } = await getAuthContext();

  const { error } = await supabase
    .from("support_conversations")
    .update({ status: "resolved" as ConversationStatus, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(`Failed to resolve conversation: ${error.message}`);
}

export async function assignConversation(id: string, staffUserId: string): Promise<void> {
  z.string().uuid().parse(id);
  z.string().uuid().parse(staffUserId);
  const { supabase, isStaff } = await getAuthContext();

  if (!isStaff) throw new Error("Only staff can assign conversations");

  const { error } = await supabase
    .from("support_conversations")
    .update({ assigned_to: staffUserId, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(`Failed to assign conversation: ${error.message}`);
}

export async function markConversationRead(conversationId: string): Promise<void> {
  z.string().uuid().parse(conversationId);
  const { isStaff, supabase } = await getAuthContext();
  const payload = isStaff
    ? { staff_last_read_at: new Date().toISOString() }
    : { client_last_read_at: new Date().toISOString() };

  const { error } = await supabase
    .from("support_conversations")
    .update(payload)
    .eq("id", conversationId);
  if (error) {
    if (isMissingColumnMessage(error.message, OPTIONAL_SUPPORT_CONVERSATION_COLUMNS)) {
      return;
    }
    throw new Error(`Failed to mark conversation as read: ${error.message}`);
  }
}

export async function suggestSupportReply(_params: {
  conversationId: string;
  latestMessage: string;
}): Promise<{ suggestions: string[] }> {
  return { suggestions: [] };
}
