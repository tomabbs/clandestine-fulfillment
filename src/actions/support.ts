"use server";

import { z } from "zod";
import { sendSupportEmail } from "@/lib/clients/resend-client";
import { requireAuth } from "@/lib/server/auth-context";
import { STAFF_ROLES } from "@/lib/shared/constants";
import type { ConversationStatus, SupportConversation, SupportMessage } from "@/lib/shared/types";

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
  })[];
  total: number;
}> {
  const { status, orgId, assignedTo, page, pageSize } = getConversationsSchema.parse(filters);
  const { supabase } = await getAuthContext();

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
  const lastMessages: Record<string, { body: string; created_at: string }> = {};

  if (conversationIds.length > 0) {
    const { data: messages } = await supabase
      .from("support_messages")
      .select("conversation_id, body, created_at")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: false });

    if (messages) {
      for (const msg of messages) {
        if (!lastMessages[msg.conversation_id]) {
          lastMessages[msg.conversation_id] = { body: msg.body, created_at: msg.created_at };
        }
      }
    }
  }

  const conversations = (data ?? []).map((c: Record<string, unknown>) => {
    const org = c.organizations as { name: string } | null;
    const lastMsg = lastMessages[(c as { id: string }).id];
    return {
      ...(c as unknown as SupportConversation),
      org_name: org?.name,
      last_message_at: lastMsg?.created_at,
      last_message_preview: lastMsg?.body?.slice(0, 120),
    };
  });

  return { conversations, total: count ?? 0 };
}

export async function getConversationDetail(id: string): Promise<{
  conversation: SupportConversation & { org_name?: string; assigned_name?: string };
  messages: SupportMessage[];
}> {
  z.string().uuid().parse(id);
  const { supabase } = await getAuthContext();

  const { data: conversation, error: convError } = await supabase
    .from("support_conversations")
    .select(
      "*, organizations!inner(name), assigned_user:users!support_conversations_assigned_to_fkey(full_name)",
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
  const assignedUser = conversation.assigned_user as { full_name: string } | null;

  return {
    conversation: {
      ...(conversation as unknown as SupportConversation),
      org_name: org?.name,
      assigned_name: assignedUser?.full_name,
    },
    messages: (messages ?? []) as SupportMessage[],
  };
}

const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10000),
  orgId: z.string().uuid().optional(),
});

export async function createConversation(
  input: z.input<typeof createConversationSchema>,
): Promise<{ conversationId: string }> {
  const { subject, body, orgId } = createConversationSchema.parse(input);
  const { supabase, user, isStaff, workspaceId } = await getAuthContext();

  // Staff can specify orgId; clients use their own org
  const targetOrgId = isStaff ? orgId : user.org_id;
  if (!targetOrgId) throw new Error("Organization required");

  const { data: conversation, error: convError } = await supabase
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

  if (convError || !conversation)
    throw new Error(`Failed to create conversation: ${convError?.message}`);

  await supabase.from("support_messages").insert({
    conversation_id: conversation.id,
    workspace_id: workspaceId,
    sender_id: user.id,
    sender_type: isStaff ? "staff" : "client",
    body,
  });

  // Send email notification
  if (isStaff) {
    // Staff created — email the client org's contacts
    const { data: mappings } = await supabase
      .from("support_email_mappings")
      .select("email_address")
      .eq("org_id", targetOrgId)
      .eq("is_active", true);

    if (mappings?.length) {
      for (const mapping of mappings) {
        await sendSupportEmail(mapping.email_address, subject, body);
      }
    }
  }

  return { conversationId: conversation.id };
}

const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1).max(10000),
});

export async function sendMessage(
  input: z.input<typeof sendMessageSchema>,
): Promise<{ messageId: string }> {
  const { conversationId, body } = sendMessageSchema.parse(input);
  const { supabase, user, isStaff, workspaceId } = await getAuthContext();

  // Verify conversation access (RLS will enforce, but get details for email)
  const { data: conversation, error: convError } = await supabase
    .from("support_conversations")
    .select("id, subject, org_id, assigned_to, status")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) throw new Error("Conversation not found");

  const senderType = isStaff ? "staff" : "client";
  const newStatus: ConversationStatus = isStaff ? "waiting_on_client" : "waiting_on_staff";

  const { data: message, error: msgError } = await supabase
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

  if (msgError || !message) throw new Error(`Failed to send message: ${msgError?.message}`);

  await supabase
    .from("support_conversations")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  // Send email
  if (isStaff) {
    // Staff reply → email the client
    const { data: mappings } = await supabase
      .from("support_email_mappings")
      .select("email_address")
      .eq("org_id", conversation.org_id)
      .eq("is_active", true);

    // Find the latest email_message_id for threading
    const { data: lastEmailMsg } = await supabase
      .from("support_messages")
      .select("email_message_id")
      .eq("conversation_id", conversationId)
      .not("email_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (mappings?.length) {
      for (const mapping of mappings) {
        const result = await sendSupportEmail(
          mapping.email_address,
          `Re: ${conversation.subject}`,
          body,
          lastEmailMsg?.email_message_id ?? undefined,
        );
        // Store the outgoing email message ID for threading
        await supabase
          .from("support_messages")
          .update({ email_message_id: result.messageId })
          .eq("id", message.id);
      }
    }
  } else {
    // Client reply → email assigned staff or all staff
    const { data: staffUsers } = conversation.assigned_to
      ? await supabase.from("users").select("email").eq("id", conversation.assigned_to)
      : await supabase
          .from("users")
          .select("email")
          .in("role", [...STAFF_ROLES]);

    if (staffUsers?.length) {
      for (const staffUser of staffUsers) {
        if (staffUser.email) {
          await sendSupportEmail(
            staffUser.email,
            `Re: ${conversation.subject}`,
            `New reply from client:\n\n${body}`,
          );
        }
      }
    }
  }

  return { messageId: message.id };
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
