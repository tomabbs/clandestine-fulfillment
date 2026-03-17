import { schedules } from "@trigger.dev/sdk";
import { sendSupportEmail } from "@/lib/clients/resend-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { STAFF_ROLES } from "@/lib/shared/constants";

export const supportEscalationTask = schedules.task({
  id: "support-escalation",
  cron: "*/5 * * * *",
  run: async () => {
    const supabase = createServiceRoleClient();
    const now = new Date();

    // 1. Find conversations waiting on staff with no reply for 15+ minutes
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

    const { data: staffEscalations } = await supabase
      .from("support_conversations")
      .select("id, subject, org_id, assigned_to, organizations!inner(name)")
      .eq("status", "waiting_on_staff");

    if (staffEscalations) {
      for (const conversation of staffEscalations) {
        // Get last message timestamp
        const { data: lastMessage } = await supabase
          .from("support_messages")
          .select("created_at, sender_type")
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (!lastMessage) continue;

        // Skip if last message is from staff (already replied)
        if (lastMessage.sender_type === "staff") continue;

        // Skip if last message is recent
        if (lastMessage.created_at > fifteenMinAgo) continue;

        // Send escalation email to assigned staff or all staff
        const { data: staffUsers } = conversation.assigned_to
          ? await supabase
              .from("users")
              .select("email, full_name")
              .eq("id", conversation.assigned_to)
          : await supabase
              .from("users")
              .select("email, full_name")
              .in("role", [...STAFF_ROLES]);

        const orgs = conversation.organizations as unknown as
          | { name: string }
          | { name: string }[]
          | null;
        const orgName = Array.isArray(orgs)
          ? (orgs[0]?.name ?? "Unknown")
          : (orgs?.name ?? "Unknown");

        if (staffUsers) {
          for (const staff of staffUsers) {
            if (staff.email) {
              await sendSupportEmail(
                staff.email,
                `[Escalation] Awaiting reply: ${conversation.subject}`,
                `A support conversation from ${orgName} has been waiting for a staff reply for over 15 minutes.\n\nSubject: ${conversation.subject}\nConversation ID: ${conversation.id}\n\nPlease respond as soon as possible.`,
              );
            }
          }
        }
      }
    }

    // 2. Find conversations waiting on client with no reply for 24+ hours
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const { data: clientReminders } = await supabase
      .from("support_conversations")
      .select("id, subject, org_id")
      .eq("status", "waiting_on_client");

    if (clientReminders) {
      for (const conversation of clientReminders) {
        const { data: lastMessage } = await supabase
          .from("support_messages")
          .select("created_at, sender_type")
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (!lastMessage) continue;

        // Skip if last message is from client (they already replied)
        if (lastMessage.sender_type === "client") continue;

        // Skip if last message is recent
        if (lastMessage.created_at > twentyFourHoursAgo) continue;

        // Send gentle reminder to client
        const { data: mappings } = await supabase
          .from("support_email_mappings")
          .select("email_address")
          .eq("org_id", conversation.org_id)
          .eq("is_active", true);

        if (mappings) {
          for (const mapping of mappings) {
            await sendSupportEmail(
              mapping.email_address,
              `Reminder: ${conversation.subject}`,
              `Hi there,\n\nWe're following up on your support conversation: "${conversation.subject}"\n\nWe sent a reply and are waiting for your response. If you have any questions or need further assistance, please reply to this email or log in to your portal.\n\nBest regards,\nClandestine Fulfillment Support`,
            );
          }
        }
      }
    }
  },
});
