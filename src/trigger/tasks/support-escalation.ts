import { schedules } from "@trigger.dev/sdk";
import { sendSupportEmail } from "@/lib/clients/resend-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { STAFF_ROLES } from "@/lib/shared/constants";

type EscalationConversation = {
  id: string;
  workspace_id: string;
  subject: string;
  org_id: string;
  assigned_to: string | null;
  status: string;
  next_response_due_at: string | null;
  resolution_due_at: string | null;
  sla_breached_at: string | null;
  sla_paused: boolean | null;
  snoozed_until: string | null;
  last_staff_escalated_at: string | null;
  last_client_reminded_at: string | null;
  organizations?: { name: string } | { name: string }[] | null;
};

export const supportEscalationTask = schedules.task({
  id: "support-escalation",
  cron: "*/5 * * * *",
  run: async () => {
    const supabase = createServiceRoleClient();
    const now = new Date();
    const nowIso = now.toISOString();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    const { data: conversations, error } = await supabase
      .from("support_conversations")
      .select(
        "id, workspace_id, subject, org_id, assigned_to, status, next_response_due_at, resolution_due_at, sla_breached_at, sla_paused, snoozed_until, last_staff_escalated_at, last_client_reminded_at, organizations!inner(name)",
      )
      .not("status", "in", "(resolved,closed)");

    if (error) throw new Error(`Failed to load support SLA conversations: ${error.message}`);

    for (const conversation of (conversations ?? []) as EscalationConversation[]) {
      if (conversation.sla_paused) continue;
      if (conversation.snoozed_until && conversation.snoozed_until > nowIso) continue;

      const dueAt = conversation.next_response_due_at ?? conversation.resolution_due_at;
      const shouldAlertBeforeBreach =
        conversation.status === "waiting_on_staff" &&
        dueAt &&
        dueAt <= oneHourFromNow &&
        dueAt > nowIso &&
        (!conversation.last_staff_escalated_at ||
          conversation.last_staff_escalated_at < thirtyMinAgo);
      const breached =
        conversation.status === "waiting_on_staff" &&
        dueAt &&
        dueAt <= nowIso &&
        !conversation.sla_breached_at;

      if (shouldAlertBeforeBreach || breached) {
        await notifyStaff(supabase, conversation, breached ? "breached" : "breach_soon");
        await supabase
          .from("support_conversations")
          .update({
            last_staff_escalated_at: nowIso,
            ...(breached ? { sla_breached_at: nowIso } : {}),
          })
          .eq("id", conversation.id);

        await supabase.from("support_conversation_events").insert({
          workspace_id: conversation.workspace_id,
          conversation_id: conversation.id,
          event_type: breached ? "sla_breached" : "status_changed",
          metadata: {
            alert_type: breached ? "sla_breached" : "sla_breach_soon",
            due_at: dueAt,
          },
        });
      }

      if (conversation.status === "waiting_on_client") {
        await maybeRemindClient(supabase, conversation, now);
      }
    }
  },
});

async function notifyStaff(
  supabase: ReturnType<typeof createServiceRoleClient>,
  conversation: EscalationConversation,
  alertType: "breach_soon" | "breached",
) {
  const { data: staffUsers } = conversation.assigned_to
    ? await supabase.from("users").select("email, name").eq("id", conversation.assigned_to)
    : await supabase
        .from("users")
        .select("email, name")
        .eq("workspace_id", conversation.workspace_id)
        .in("role", [...STAFF_ROLES]);
  const orgName = organizationName(conversation.organizations);
  const subjectPrefix = alertType === "breached" ? "[SLA breached]" : "[SLA risk]";

  for (const staff of staffUsers ?? []) {
    if (!staff.email) continue;
    await sendSupportEmail(
      staff.email,
      `${subjectPrefix} ${conversation.subject}`,
      [
        `Support conversation from ${orgName} ${alertType === "breached" ? "has breached its SLA" : "is due soon"}.`,
        "",
        `Subject: ${conversation.subject}`,
        `Conversation ID: ${conversation.id}`,
        `Due at: ${conversation.next_response_due_at ?? conversation.resolution_due_at ?? "unknown"}`,
        "",
        "Open the Support Inbox to reply, assign, snooze, or resolve it.",
      ].join("\n"),
    );
  }
}

async function maybeRemindClient(
  supabase: ReturnType<typeof createServiceRoleClient>,
  conversation: EscalationConversation,
  now: Date,
) {
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (
    conversation.last_client_reminded_at &&
    conversation.last_client_reminded_at > twentyFourHoursAgo
  ) {
    return;
  }

  const { data: lastMessage } = await supabase
    .from("support_messages")
    .select("created_at, sender_type")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    !lastMessage ||
    lastMessage.sender_type === "client" ||
    lastMessage.created_at > twentyFourHoursAgo
  ) {
    return;
  }

  const { data: mappings } = await supabase
    .from("support_email_mappings")
    .select("email_address")
    .eq("org_id", conversation.org_id)
    .eq("is_active", true);

  for (const mapping of mappings ?? []) {
    await sendSupportEmail(
      mapping.email_address,
      `Reminder: ${conversation.subject}`,
      [
        "Hi there,",
        "",
        `We're following up on "${conversation.subject}".`,
        "Support has replied and is waiting for your response.",
        "",
        "You can reply to this email or open the portal support thread.",
      ].join("\n"),
    );
  }

  await supabase
    .from("support_conversations")
    .update({ last_client_reminded_at: now.toISOString() })
    .eq("id", conversation.id);
}

function organizationName(orgs: EscalationConversation["organizations"]): string {
  if (Array.isArray(orgs)) return orgs[0]?.name ?? "Unknown client";
  return orgs?.name ?? "Unknown client";
}
