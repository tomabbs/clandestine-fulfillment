"use server";

import { z } from "zod";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  enqueuePendingSupportDeliveryForMessage,
  nextSupportDeliveryRetryAt,
  normalizeDeliveryRoutes,
  type SupportDeliveryRoute,
} from "@/lib/server/support-delivery";
import {
  conversationMatchesQueue,
  getSupportQueueFlags,
  type SupportQueueType,
} from "@/lib/server/support-queues";
import {
  calculateSupportSlaDeadlines,
  defaultPolicyForPriority,
  type SupportSlaPolicy,
} from "@/lib/server/support-sla";
import { STAFF_ROLES } from "@/lib/shared/constants";
import {
  type SupportEventType,
  supportCategorySchema,
  supportResolutionCodeSchema,
  supportSourceChannelSchema,
} from "@/lib/shared/support-taxonomy";
import type {
  ConversationStatus,
  SupportConversation,
  SupportMessage,
  SupportMessageDelivery,
} from "@/lib/shared/types";

type SupportConversationListItem = SupportConversation & {
  org_name?: string;
  assigned_name?: string | null;
  last_message_at?: string;
  last_message_preview?: string;
  unread_count?: number;
  counterpart_last_seen_at?: string | null;
  queue_flags?: ReturnType<typeof getSupportQueueFlags>;
};

interface SupportEventInput {
  workspaceId: string;
  conversationId: string;
  actorId?: string | null;
  eventType: SupportEventType;
  metadata?: Record<string, unknown>;
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
  queue: z
    .enum([
      "needs_triage",
      "mine",
      "waiting_on_staff",
      "waiting_on_client",
      "sla_breach_soon",
      "sla_breached",
      "unassigned",
      "snoozed",
      "resolved",
    ])
    .optional(),
  search: z.string().trim().min(1).optional(),
  orgId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  category: supportCategorySchema.optional(),
  sourceChannel: supportSourceChannelSchema.optional(),
  launcher: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10000),
  orgId: z.string().uuid().optional(),
  category: supportCategorySchema.optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  sourceChannel: supportSourceChannelSchema.default("app"),
});

const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1).max(10000),
  clientMutationId: z.string().min(8).max(120).optional(),
  lastSeenMessageId: z.string().uuid().optional(),
  lastSeenMessageCreatedAt: z.string().optional(),
  forceSendAfterCollision: z.boolean().optional(),
});

export type SendMessageResult =
  | { success: true; messageId: string; deliveries?: SupportMessageDelivery[] }
  | {
      success: false;
      error: string;
      code?: "CONVERSATION_CHANGED";
      latestMessage?: SupportMessage;
    };

export type CreateConversationResult =
  | { success: true; conversationId: string }
  | { success: false; error: string };

export async function getConversations(
  filters: z.input<typeof getConversationsSchema> = {},
): Promise<{
  conversations: SupportConversationListItem[];
  total: number;
}> {
  const parsed = getConversationsSchema.parse(filters);
  let auth: Awaited<ReturnType<typeof getAuthContext>>;
  try {
    auth = await getAuthContext();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      return { conversations: [], total: 0 };
    }
    throw error;
  }

  let query = auth.supabase
    .from("support_conversations")
    .select(
      "*, organizations!inner(name), assigned_user:users!support_conversations_assigned_to_fkey(name)",
      {
        count: "exact",
      },
    );

  if (parsed.status) query = query.eq("status", parsed.status);
  if (parsed.orgId) query = query.eq("org_id", parsed.orgId);
  if (parsed.assignedTo) query = query.eq("assigned_to", parsed.assignedTo);
  if (parsed.priority) query = query.eq("priority", parsed.priority);
  if (parsed.category) query = query.eq("category", parsed.category);
  if (parsed.sourceChannel) query = query.eq("source_channel", parsed.sourceChannel);
  if (parsed.search) query = query.ilike("subject", `%${parsed.search}%`);

  query = query
    .order("updated_at", { ascending: false })
    .range((parsed.page - 1) * parsed.pageSize, parsed.page * parsed.pageSize - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(`Failed to fetch conversations: ${error.message}`);

  const conversationIds = (data ?? []).map((c: { id: string }) => c.id);
  const lastMessages = await fetchLastMessages(auth.supabase, conversationIds);
  const now = new Date();

  let conversations = (data ?? []).map((c: Record<string, unknown>) => {
    const org = c.organizations as { name: string } | null;
    const assignedUser = c.assigned_user as { name: string } | null;
    const conversation = c as unknown as SupportConversation;
    const lastMsg = lastMessages[conversation.id];
    const readAt = auth.isStaff
      ? conversation.staff_last_read_at
      : conversation.client_last_read_at;
    const unreadCount = lastMsg
      ? lastMsg.sender_type === (auth.isStaff ? "staff" : "client")
        ? 0
        : readAt && lastMsg.created_at <= readAt
          ? 0
          : 1
      : 0;

    return {
      ...conversation,
      org_name: org?.name,
      assigned_name: assignedUser?.name ?? null,
      last_message_at: lastMsg?.created_at,
      last_message_preview: lastMsg?.body?.slice(0, 160),
      unread_count: unreadCount,
      counterpart_last_seen_at: auth.isStaff
        ? conversation.client_last_read_at
        : conversation.staff_last_read_at,
      queue_flags: getSupportQueueFlags(conversation, auth.user.id, now),
    };
  });

  if (parsed.queue) {
    conversations = conversations.filter((conversation) =>
      conversationMatchesQueue(conversation, parsed.queue as SupportQueueType, auth.user.id, now),
    );
  }

  return { conversations, total: parsed.queue ? conversations.length : (count ?? 0) };
}

export async function getSupportInboxSummary(): Promise<{
  needsTriage: number;
  mine: number;
  unassigned: number;
  waitingOnStaff: number;
  waitingOnClient: number;
  slaBreachSoon: number;
  slaBreached: number;
  snoozed: number;
  onTrack: number;
  resolvedToday: number;
  failedDeliveries: number;
}> {
  const auth = await getAuthContext();
  const { data, error } = await auth.supabase
    .from("support_conversations")
    .select(
      "id, status, assigned_to, category, priority, snoozed_until, next_response_due_at, sla_paused, resolved_at, updated_at",
    )
    .eq("workspace_id", auth.workspaceId);

  if (error) throw new Error(`Failed to fetch support summary: ${error.message}`);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const summary = {
    needsTriage: 0,
    mine: 0,
    unassigned: 0,
    waitingOnStaff: 0,
    waitingOnClient: 0,
    slaBreachSoon: 0,
    slaBreached: 0,
    snoozed: 0,
    onTrack: 0,
    resolvedToday: 0,
    failedDeliveries: 0,
  };

  for (const row of data ?? []) {
    const flags = getSupportQueueFlags(row as SupportConversation, auth.user.id);
    if (flags.needsTriage) summary.needsTriage++;
    if (flags.mine) summary.mine++;
    if (flags.unassigned) summary.unassigned++;
    if (flags.waitingOnStaff) summary.waitingOnStaff++;
    if (flags.waitingOnClient) summary.waitingOnClient++;
    if (flags.slaBreachSoon) summary.slaBreachSoon++;
    if (flags.slaBreached) summary.slaBreached++;
    if (flags.snoozed) summary.snoozed++;
    if (flags.onTrack) summary.onTrack++;
    const resolvedAt = (row as { resolved_at?: string | null }).resolved_at;
    if (resolvedAt && new Date(resolvedAt) >= todayStart) summary.resolvedToday++;
  }

  const { count } = await auth.supabase
    .from("support_message_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "failed");
  summary.failedDeliveries = count ?? 0;

  return summary;
}

export async function getConversationDetail(id: string): Promise<{
  conversation: SupportConversation & { org_name?: string; assigned_name?: string };
  messages: SupportMessage[];
  deliveries: SupportMessageDelivery[];
  internalNotes: Array<{ id: string; body: string; author_id: string | null; created_at: string }>;
  events: Array<{
    id: string;
    event_type: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>;
}> {
  z.string().uuid().parse(id);
  const auth = await getAuthContext();

  const { data: conversation, error: convError } = await auth.supabase
    .from("support_conversations")
    .select(
      "*, organizations!inner(name), assigned_user:users!support_conversations_assigned_to_fkey(name)",
    )
    .eq("id", id)
    .single();

  if (convError || !conversation) throw new Error("Conversation not found");

  const { data: messages, error: msgError } = await auth.supabase
    .from("support_messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  if (msgError) throw new Error(`Failed to fetch messages: ${msgError.message}`);

  const { data: deliveries } = auth.isStaff
    ? await auth.supabase
        .from("support_message_deliveries")
        .select("*")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true })
    : { data: [] };

  const { data: internalNotes } = auth.isStaff
    ? await auth.supabase
        .from("support_internal_notes")
        .select("id, body, author_id, created_at")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true })
    : { data: [] };

  const { data: events } = auth.isStaff
    ? await auth.supabase
        .from("support_conversation_events")
        .select("id, event_type, metadata, created_at")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true })
    : { data: [] };

  const org = conversation.organizations as { name: string } | null;
  const assignedUser = conversation.assigned_user as { name: string } | null;

  return {
    conversation: {
      ...(conversation as unknown as SupportConversation),
      org_name: org?.name,
      assigned_name: assignedUser?.name,
    },
    messages: (messages ?? []) as SupportMessage[],
    deliveries: (deliveries ?? []) as SupportMessageDelivery[],
    internalNotes: (internalNotes ?? []) as Array<{
      id: string;
      body: string;
      author_id: string | null;
      created_at: string;
    }>,
    events: (events ?? []) as Array<{
      id: string;
      event_type: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>,
  };
}

export async function getSupportViewerContext(): Promise<{
  userId: string;
  userName: string;
  role: "staff" | "client";
  orgId: string | null;
  workspaceId: string;
}> {
  const { user, isStaff, workspaceId } = await getAuthContext();
  return {
    userId: user.id,
    userName: user.name ?? user.email ?? "Unknown User",
    role: isStaff ? "staff" : "client",
    orgId: user.org_id,
    workspaceId,
  };
}

export async function createConversation(
  input: z.input<typeof createConversationSchema>,
): Promise<CreateConversationResult> {
  try {
    const parsed = createConversationSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: "Please provide a valid subject and message." };
    }
    const { subject, body, orgId, priority, category, sourceChannel } = parsed.data;
    const auth = await getAuthContext();
    const serviceClient = createServiceRoleClient();

    const targetOrgId = auth.isStaff ? orgId : auth.user.org_id;
    if (!targetOrgId) return { success: false, error: "Organization required." };
    if (!auth.isStaff && targetOrgId !== auth.user.org_id) {
      return { success: false, error: "Unauthorized organization access." };
    }

    const { data: policy } = await serviceClient
      .from("support_sla_policies")
      .select(
        "id, first_response_minutes, next_response_minutes, resolution_minutes, business_hours_only",
      )
      .eq("workspace_id", auth.workspaceId)
      .eq("priority", priority)
      .is("category", null)
      .is("source_channel", null)
      .eq("is_active", true)
      .maybeSingle();
    const deadlines = calculateSupportSlaDeadlines(
      (policy as SupportSlaPolicy | null) ?? defaultPolicyForPriority(priority),
    );

    const { data: conversation, error: convError } = await serviceClient
      .from("support_conversations")
      .insert({
        workspace_id: auth.workspaceId,
        org_id: targetOrgId,
        subject,
        status: auth.isStaff ? "waiting_on_client" : "waiting_on_staff",
        priority,
        category: category ?? null,
        source_channel: sourceChannel,
        sla_policy_id: (policy as { id?: string } | null)?.id ?? null,
        ...deadlines,
        created_by: auth.user.id,
        ...(auth.isStaff
          ? { staff_last_read_at: new Date().toISOString() }
          : { client_last_read_at: new Date().toISOString() }),
      })
      .select("id")
      .single();

    if (convError || !conversation) {
      return {
        success: false,
        error: `Failed to create conversation: ${convError?.message ?? "unknown error"}`,
      };
    }

    const { data: message, error: messageError } = await serviceClient
      .from("support_messages")
      .insert({
        conversation_id: conversation.id,
        workspace_id: auth.workspaceId,
        sender_id: auth.user.id,
        sender_type: auth.isStaff ? "staff" : "client",
        source: "app",
        source_channel: sourceChannel,
        direction: auth.isStaff ? "outbound" : "inbound",
        body,
      })
      .select("id")
      .single();

    if (messageError || !message) {
      return { success: false, error: `Failed to create message: ${messageError?.message}` };
    }

    await recordSupportEvent(serviceClient, {
      workspaceId: auth.workspaceId,
      conversationId: conversation.id,
      actorId: auth.user.id,
      eventType: "conversation_created",
      metadata: { source_channel: sourceChannel, category: category ?? null, priority },
    });
    await recordSupportEvent(serviceClient, {
      workspaceId: auth.workspaceId,
      conversationId: conversation.id,
      actorId: auth.user.id,
      eventType: "message_created",
      metadata: { message_id: message.id },
    });
    await detectDuplicateCandidates(serviceClient, conversation.id);

    return { success: true, conversationId: conversation.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unexpected support error: ${msg}` };
  }
}

export async function sendMessage(
  input: z.input<typeof sendMessageSchema>,
): Promise<SendMessageResult> {
  try {
    const parsed = sendMessageSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: "Please enter a valid message." };

    const { conversationId, body, clientMutationId, lastSeenMessageId, forceSendAfterCollision } =
      parsed.data;
    const auth = await getAuthContext();
    const serviceClient = createServiceRoleClient();

    const { data: conversation, error: convError } = await serviceClient
      .from("support_conversations")
      .select(
        "id, workspace_id, subject, org_id, assigned_to, status, source_channel, external_thread_id, external_order_id",
      )
      .eq("id", conversationId)
      .single();

    if (convError || !conversation) return { success: false, error: "Conversation not found." };
    if (!auth.isStaff && conversation.org_id !== auth.user.org_id) {
      return { success: false, error: "You do not have access to this conversation." };
    }

    if (clientMutationId) {
      const { data: existing } = await serviceClient
        .from("support_messages")
        .select("id")
        .eq("workspace_id", auth.workspaceId)
        .eq("conversation_id", conversationId)
        .eq("client_mutation_id", clientMutationId)
        .maybeSingle();
      if (existing?.id) {
        await ensureMessageDeliveriesAndEnqueue(serviceClient, {
          auth,
          conversation,
          messageId: existing.id,
          body,
          isStaff: auth.isStaff,
        });
        const deliveries = await fetchDeliveries(serviceClient, existing.id);
        return { success: true, messageId: existing.id, deliveries };
      }
    }

    if (lastSeenMessageId && !forceSendAfterCollision) {
      const { data: latest } = await serviceClient
        .from("support_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest && latest.id !== lastSeenMessageId) {
        await recordSupportEvent(serviceClient, {
          workspaceId: auth.workspaceId,
          conversationId,
          actorId: auth.user.id,
          eventType: "collision_detected",
          metadata: {
            latest_message_id: latest.id,
            attempted_client_mutation_id: clientMutationId,
          },
        });
        return {
          success: false,
          code: "CONVERSATION_CHANGED",
          error: "A newer message arrived before you sent this reply.",
          latestMessage: latest as SupportMessage,
        };
      }
    }

    const senderType = auth.isStaff ? "staff" : "client";
    const newStatus: ConversationStatus = auth.isStaff ? "waiting_on_client" : "waiting_on_staff";
    const messageDirection = auth.isStaff ? "outbound" : "inbound";
    const now = new Date().toISOString();

    const { data: message, error: msgError } = await serviceClient
      .from("support_messages")
      .insert({
        conversation_id: conversationId,
        workspace_id: auth.workspaceId,
        sender_id: auth.user.id,
        sender_type: senderType,
        source: "app",
        source_channel: "app",
        direction: messageDirection,
        client_mutation_id: clientMutationId ?? null,
        body,
      })
      .select("id")
      .single();

    if (msgError || !message) {
      return { success: false, error: `Failed to send message: ${msgError?.message}` };
    }

    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      updated_at: now,
      ...(auth.isStaff ? { staff_last_read_at: now } : { client_last_read_at: now }),
    };
    if (
      auth.isStaff &&
      !(conversation as { first_responded_at?: string | null }).first_responded_at
    ) {
      updatePayload.first_responded_at = now;
    }
    if (!auth.isStaff) {
      const policy = defaultPolicyForPriority(
        (conversation as { priority?: string }).priority ?? "normal",
      );
      updatePayload.next_response_due_at =
        calculateSupportSlaDeadlines(policy).next_response_due_at;
    }

    await serviceClient
      .from("support_conversations")
      .update(updatePayload)
      .eq("id", conversationId);

    await recordSupportEvent(serviceClient, {
      workspaceId: auth.workspaceId,
      conversationId,
      actorId: auth.user.id,
      eventType: "message_created",
      metadata: {
        message_id: message.id,
        direction: messageDirection,
        force_send_after_collision: !!forceSendAfterCollision,
      },
    });

    await ensureMessageDeliveriesAndEnqueue(serviceClient, {
      auth,
      conversation,
      messageId: message.id,
      body,
      isStaff: auth.isStaff,
    });

    const deliveries = await fetchDeliveries(serviceClient, message.id);
    return { success: true, messageId: message.id, deliveries };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unexpected support error: ${msg}` };
  }
}

export async function listSupportAssignees(): Promise<
  Array<{ id: string; name: string; email: string }>
> {
  const { supabase, isStaff, workspaceId } = await getAuthContext();
  if (!isStaff) throw new Error("Only staff can list support assignees");

  const { data, error } = await supabase
    .from("users")
    .select("id, name, email")
    .eq("workspace_id", workspaceId)
    .in("role", [...STAFF_ROLES])
    .order("name", { ascending: true });
  if (error) throw new Error(`Failed to list assignees: ${error.message}`);
  return (data ?? []).map((user) => ({
    id: user.id,
    name: user.name ?? user.email,
    email: user.email,
  }));
}

export async function assignConversation(id: string, staffUserId: string | null): Promise<void> {
  z.string().uuid().parse(id);
  if (staffUserId) z.string().uuid().parse(staffUserId);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can assign conversations");

  const { error } = await auth.supabase
    .from("support_conversations")
    .update({ assigned_to: staffUserId, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Failed to assign conversation: ${error.message}`);
  await recordSupportEvent(auth.supabase, {
    workspaceId: auth.workspaceId,
    conversationId: id,
    actorId: auth.user.id,
    eventType: "assignment_changed",
    metadata: { assigned_to: staffUserId },
  });
}

export async function updateConversationTriage(input: {
  conversationId: string;
  priority?: "low" | "normal" | "high" | "urgent";
  category?: z.infer<typeof supportCategorySchema> | null;
  tags?: string[];
}): Promise<void> {
  const schema = z.object({
    conversationId: z.string().uuid(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    category: supportCategorySchema.nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  });
  const parsed = schema.parse(input);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can update triage");

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.priority) payload.priority = parsed.priority;
  if (parsed.category !== undefined) payload.category = parsed.category;
  if (parsed.tags) payload.tags = parsed.tags;

  const { error } = await auth.supabase
    .from("support_conversations")
    .update(payload)
    .eq("id", parsed.conversationId);
  if (error) throw new Error(`Failed to update triage: ${error.message}`);

  if (parsed.priority) {
    await recordSupportEvent(auth.supabase, {
      workspaceId: auth.workspaceId,
      conversationId: parsed.conversationId,
      actorId: auth.user.id,
      eventType: "priority_changed",
      metadata: { priority: parsed.priority },
    });
  }
  if (parsed.category !== undefined) {
    await recordSupportEvent(auth.supabase, {
      workspaceId: auth.workspaceId,
      conversationId: parsed.conversationId,
      actorId: auth.user.id,
      eventType: "category_changed",
      metadata: { category: parsed.category },
    });
  }
}

export async function snoozeConversation(
  conversationId: string,
  snoozedUntil: string | null,
): Promise<void> {
  z.string().uuid().parse(conversationId);
  if (snoozedUntil) z.string().datetime().parse(snoozedUntil);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can snooze conversations");
  const { error } = await auth.supabase
    .from("support_conversations")
    .update({ snoozed_until: snoozedUntil, updated_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (error) throw new Error(`Failed to snooze conversation: ${error.message}`);
  await recordSupportEvent(auth.supabase, {
    workspaceId: auth.workspaceId,
    conversationId,
    actorId: auth.user.id,
    eventType: "snoozed",
    metadata: { snoozed_until: snoozedUntil },
  });
}

export async function addInternalNote(conversationId: string, body: string): Promise<void> {
  z.string().uuid().parse(conversationId);
  z.string().min(1).max(10000).parse(body);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can add internal notes");
  const { error } = await auth.supabase.from("support_internal_notes").insert({
    workspace_id: auth.workspaceId,
    conversation_id: conversationId,
    author_id: auth.user.id,
    body,
  });
  if (error) throw new Error(`Failed to add internal note: ${error.message}`);
  await recordSupportEvent(auth.supabase, {
    workspaceId: auth.workspaceId,
    conversationId,
    actorId: auth.user.id,
    eventType: "internal_note_created",
  });
}

export async function listSavedReplies(): Promise<
  Array<{ id: string; title: string; body: string; category: string | null; tags: string[] }>
> {
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can list saved replies");
  const { data, error } = await auth.supabase
    .from("support_saved_replies")
    .select("id, title, body, category, tags")
    .eq("workspace_id", auth.workspaceId)
    .eq("is_active", true)
    .order("title", { ascending: true });
  if (error) throw new Error(`Failed to list saved replies: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    title: string;
    body: string;
    category: string | null;
    tags: string[];
  }>;
}

export async function createSavedReply(input: {
  title: string;
  body: string;
  category?: z.infer<typeof supportCategorySchema> | null;
  tags?: string[];
}): Promise<void> {
  const schema = z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(10000),
    category: supportCategorySchema.nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  });
  const parsed = schema.parse(input);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can create saved replies");
  const { error } = await auth.supabase.from("support_saved_replies").insert({
    workspace_id: auth.workspaceId,
    title: parsed.title,
    body: parsed.body,
    category: parsed.category ?? null,
    tags: parsed.tags ?? [],
    created_by: auth.user.id,
  });
  if (error) throw new Error(`Failed to create saved reply: ${error.message}`);
}

export async function resolveConversation(
  id: string,
  input: { resolutionCode?: z.infer<typeof supportResolutionCodeSchema>; summary?: string } = {},
): Promise<void> {
  z.string().uuid().parse(id);
  const parsed = z
    .object({
      resolutionCode: supportResolutionCodeSchema.default("answered"),
      summary: z.string().max(2000).optional(),
    })
    .parse(input);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can resolve conversations");
  const now = new Date().toISOString();
  const { error } = await auth.supabase
    .from("support_conversations")
    .update({
      status: "resolved" as ConversationStatus,
      resolved_at: now,
      resolved_by: auth.user.id,
      resolution_code: parsed.resolutionCode,
      resolution_summary: parsed.summary ?? null,
      updated_at: now,
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to resolve conversation: ${error.message}`);
  await recordSupportEvent(auth.supabase, {
    workspaceId: auth.workspaceId,
    conversationId: id,
    actorId: auth.user.id,
    eventType: "resolved",
    metadata: { resolution_code: parsed.resolutionCode },
  });
}

export async function reopenConversation(id: string): Promise<void> {
  z.string().uuid().parse(id);
  const auth = await getAuthContext();
  const { error } = await auth.supabase
    .from("support_conversations")
    .update({
      status: "waiting_on_staff" as ConversationStatus,
      resolved_at: null,
      resolved_by: null,
      resolution_code: null,
      resolution_summary: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to reopen conversation: ${error.message}`);
  await recordSupportEvent(auth.supabase, {
    workspaceId: auth.workspaceId,
    conversationId: id,
    actorId: auth.user.id,
    eventType: "reopened",
  });
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
  if (error) throw new Error(`Failed to mark conversation as read: ${error.message}`);
}

export async function getSupportClientContext(conversationId: string): Promise<{
  org: { id: string; name: string; status?: string };
  contacts: Array<{ id: string; email_address: string; is_active: boolean }>;
  recentConversations: Array<{
    id: string;
    subject: string;
    status: ConversationStatus;
    updated_at: string;
  }>;
  openOrders: unknown[];
  openShipments: unknown[];
  inventoryAlerts: unknown[];
  links: { orgAdminUrl: string; ordersUrl: string; shipmentsUrl: string; inventoryUrl: string };
}> {
  z.string().uuid().parse(conversationId);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can read support client context");

  const { data: conversation, error } = await auth.supabase
    .from("support_conversations")
    .select("org_id, organizations!inner(id, name)")
    .eq("id", conversationId)
    .single();
  if (error || !conversation) throw new Error("Conversation not found");

  const orgs = conversation.organizations as
    | { id: string; name: string }
    | { id: string; name: string }[];
  const org = Array.isArray(orgs) ? orgs[0] : orgs;
  const { data: contacts } = await auth.supabase
    .from("support_email_mappings")
    .select("id, email_address, is_active")
    .eq("org_id", conversation.org_id)
    .order("email_address", { ascending: true });
  const { data: recent } = await auth.supabase
    .from("support_conversations")
    .select("id, subject, status, updated_at")
    .eq("org_id", conversation.org_id)
    .neq("id", conversationId)
    .order("updated_at", { ascending: false })
    .limit(5);

  return {
    org,
    contacts: contacts ?? [],
    recentConversations: (recent ?? []) as Array<{
      id: string;
      subject: string;
      status: ConversationStatus;
      updated_at: string;
    }>,
    openOrders: [],
    openShipments: [],
    inventoryAlerts: [],
    links: {
      orgAdminUrl: `/admin/clients/${conversation.org_id}`,
      ordersUrl: `/admin/orders?org=${conversation.org_id}`,
      shipmentsUrl: `/admin/shipping?org=${conversation.org_id}`,
      inventoryUrl: `/admin/inventory?org=${conversation.org_id}`,
    },
  };
}

export async function getDuplicateCandidates(conversationId: string): Promise<
  Array<{
    id: string;
    duplicate_of_conversation_id: string;
    confidence: number;
    match_reason: string;
    created_at: string;
  }>
> {
  z.string().uuid().parse(conversationId);
  const auth = await getAuthContext();
  if (!auth.isStaff) return [];
  const { data, error } = await auth.supabase
    .from("support_duplicate_candidates")
    .select("id, duplicate_of_conversation_id, confidence, match_reason, created_at")
    .eq("conversation_id", conversationId)
    .eq("reviewed", false)
    .order("confidence", { ascending: false });
  if (error) throw new Error(`Failed to fetch duplicates: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    duplicate_of_conversation_id: string;
    confidence: number;
    match_reason: string;
    created_at: string;
  }>;
}

export async function markDuplicateCandidateReviewed(
  id: string,
  decision: "merge" | "keep_separate" | "ignore",
): Promise<void> {
  z.string().uuid().parse(id);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can review duplicate candidates");
  const { error } = await auth.supabase
    .from("support_duplicate_candidates")
    .update({
      reviewed: true,
      review_decision: decision,
      reviewed_by: auth.user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to review duplicate candidate: ${error.message}`);
}

export async function retrySupportDelivery(deliveryId: string): Promise<void> {
  z.string().uuid().parse(deliveryId);
  const auth = await getAuthContext();
  if (!auth.isStaff) throw new Error("Only staff can retry delivery");
  const { data: delivery, error } = await auth.supabase
    .from("support_message_deliveries")
    .select("message_id")
    .eq("id", deliveryId)
    .single();
  if (error || !delivery) throw new Error("Delivery not found");
  await auth.supabase
    .from("support_message_deliveries")
    .update({
      status: "pending",
      next_retry_at: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
  await enqueuePendingSupportDeliveryForMessage(delivery.message_id);
}

export async function suggestSupportReply(_params: {
  conversationId: string;
  latestMessage: string;
}): Promise<{ suggestions: string[] }> {
  return { suggestions: [] };
}

async function ensureMessageDeliveriesAndEnqueue(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  params: {
    auth: Awaited<ReturnType<typeof getAuthContext>>;
    conversation: Record<string, unknown>;
    messageId: string;
    body: string;
    isStaff: boolean;
  },
) {
  const routes = await determineDeliveryRoutes(serviceClient, params);
  if (routes.length === 0) return;

  for (const route of routes) {
    await serviceClient.from("support_message_deliveries").upsert(
      {
        workspace_id: params.auth.workspaceId,
        conversation_id: params.conversation.id,
        message_id: params.messageId,
        channel: route.channel,
        recipient: route.recipient ?? null,
        provider: route.provider ?? route.channel,
        provider_thread_id: route.providerThreadId ?? null,
        status: "pending",
        next_retry_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "message_id,channel", ignoreDuplicates: true },
    );
  }

  await enqueuePendingSupportDeliveryForMessage(params.messageId);
}

async function determineDeliveryRoutes(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  params: {
    auth: Awaited<ReturnType<typeof getAuthContext>>;
    conversation: Record<string, unknown>;
    isStaff: boolean;
  },
): Promise<SupportDeliveryRoute[]> {
  if (!params.isStaff) {
    return [];
  }

  const routes: SupportDeliveryRoute[] = [];
  const { data: discogsMapping } = await serviceClient
    .from("discogs_support_mappings")
    .select("discogs_order_id")
    .eq("support_conversation_id", params.conversation.id)
    .maybeSingle();

  if (discogsMapping?.discogs_order_id) {
    routes.push({
      channel: "discogs",
      provider: "discogs",
      recipient: discogsMapping.discogs_order_id,
      providerThreadId: discogsMapping.discogs_order_id,
    });
  }

  const { data: mappings } = await serviceClient
    .from("support_email_mappings")
    .select("email_address")
    .eq("org_id", params.conversation.org_id)
    .eq("is_active", true);
  if (mappings?.length) {
    routes.push({
      channel: "email",
      provider: "resend",
      recipient: mappings.map((mapping) => mapping.email_address).join(","),
    });
  }

  return normalizeDeliveryRoutes(routes);
}

async function fetchDeliveries(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  messageId: string,
): Promise<SupportMessageDelivery[]> {
  const { data } = await serviceClient
    .from("support_message_deliveries")
    .select("*")
    .eq("message_id", messageId)
    .order("created_at", { ascending: true });
  return (data ?? []) as SupportMessageDelivery[];
}

async function fetchLastMessages(
  supabase: Awaited<ReturnType<typeof getAuthContext>>["supabase"],
  conversationIds: string[],
): Promise<
  Record<string, { body: string; created_at: string; sender_type: SupportMessage["sender_type"] }>
> {
  if (conversationIds.length === 0) return {};
  const { data: messages } = await supabase
    .from("support_messages")
    .select("conversation_id, body, created_at, sender_type")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false });

  const lastMessages: Record<
    string,
    { body: string; created_at: string; sender_type: SupportMessage["sender_type"] }
  > = {};
  for (const msg of messages ?? []) {
    if (!lastMessages[msg.conversation_id]) {
      lastMessages[msg.conversation_id] = {
        body: msg.body,
        created_at: msg.created_at,
        sender_type: (msg.sender_type as SupportMessage["sender_type"]) ?? "system",
      };
    }
  }
  return lastMessages;
}

async function recordSupportEvent(
  supabase: {
    from: (table: string) => {
      insert: (value: Record<string, unknown>) => PromiseLike<unknown> | unknown;
    };
  },
  input: SupportEventInput,
): Promise<void> {
  await supabase.from("support_conversation_events").insert({
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    actor_id: input.actorId ?? null,
    event_type: input.eventType,
    metadata: input.metadata ?? {},
  });
}

async function detectDuplicateCandidates(
  supabase: ReturnType<typeof createServiceRoleClient>,
  conversationId: string,
): Promise<void> {
  const { data: conversation } = await supabase
    .from("support_conversations")
    .select(
      "id, workspace_id, org_id, subject, category, priority, external_thread_id, external_order_id, created_at",
    )
    .eq("id", conversationId)
    .single();
  if (!conversation) return;

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: candidates } = await supabase
    .from("support_conversations")
    .select("id, subject, category, priority, external_thread_id, external_order_id, created_at")
    .eq("workspace_id", conversation.workspace_id)
    .eq("org_id", conversation.org_id)
    .neq("id", conversation.id)
    .not("status", "in", "(resolved,closed)")
    .gte("created_at", since)
    .limit(20);

  for (const candidate of candidates ?? []) {
    const confidence = calculateDuplicateConfidence(conversation, candidate);
    if (confidence < 0.8) continue;
    const matchReason = duplicateMatchReason(conversation, candidate);
    await supabase.from("support_duplicate_candidates").upsert(
      {
        workspace_id: conversation.workspace_id,
        conversation_id: conversation.id,
        duplicate_of_conversation_id: candidate.id,
        confidence,
        match_reason: matchReason,
      },
      { onConflict: "conversation_id,duplicate_of_conversation_id", ignoreDuplicates: true },
    );
    await recordSupportEvent(supabase, {
      workspaceId: conversation.workspace_id,
      conversationId: conversation.id,
      eventType: "duplicate_candidate_created",
      metadata: {
        duplicate_of_conversation_id: candidate.id,
        confidence,
        match_reason: matchReason,
      },
    });
  }
}

function calculateDuplicateConfidence(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  let score = 0.4; // same org/workspace by query.
  if (a.external_thread_id && a.external_thread_id === b.external_thread_id) score += 0.4;
  if (a.external_order_id && a.external_order_id === b.external_order_id) score += 0.4;
  score += subjectSimilarity(String(a.subject ?? ""), String(b.subject ?? "")) * 0.3;
  if (a.category && a.category === b.category) score += 0.2;
  if (a.priority && a.priority === b.priority) score += 0.1;
  return Math.min(score, 1);
}

function duplicateMatchReason(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const reasons = ["same_customer"];
  if (a.external_thread_id && a.external_thread_id === b.external_thread_id)
    reasons.push("same_thread");
  if (a.external_order_id && a.external_order_id === b.external_order_id)
    reasons.push("same_order");
  if (subjectSimilarity(String(a.subject ?? ""), String(b.subject ?? "")) > 0.75) {
    reasons.push("similar_subject");
  }
  if (a.category && a.category === b.category) reasons.push("same_category");
  return reasons.join(",");
}

function subjectSimilarity(a: string, b: string): number {
  const aWords = new Set(normalizeSubject(a).split(" ").filter(Boolean));
  const bWords = new Set(normalizeSubject(b).split(" ").filter(Boolean));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }
  return overlap / Math.max(aWords.size, bWords.size);
}

function normalizeSubject(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export { nextSupportDeliveryRetryAt };
