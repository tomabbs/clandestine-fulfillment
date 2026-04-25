import { schedules, task } from "@trigger.dev/sdk";
import { sendSupportEmail } from "@/lib/clients/resend-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { nextSupportDeliveryRetryAt } from "@/lib/server/support-delivery";
import { discogsMessageSendTask } from "./discogs-message-send";

type DeliveryRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  channel: "email" | "discogs" | "bandcamp" | "app" | "system";
  recipient: string | null;
  provider_thread_id: string | null;
  attempt_count: number;
  message?: {
    body: string;
    email_message_id: string | null;
    conversation?: {
      subject: string;
    } | null;
  } | null;
};

export const supportMessageDeliveryTask = task({
  id: "support-message-delivery",
  maxDuration: 300,
  run: async (payload: { messageId: string }) => {
    const supabase = createServiceRoleClient();
    const { data: deliveries, error } = await supabase
      .from("support_message_deliveries")
      .select(
        "*, message:support_messages(body, email_message_id, conversation:support_conversations(subject))",
      )
      .eq("message_id", payload.messageId)
      .in("status", ["pending", "failed"]);

    if (error) throw new Error(`Failed to load support deliveries: ${error.message}`);

    for (const delivery of (deliveries ?? []) as DeliveryRow[]) {
      if (delivery.channel === "app" || delivery.channel === "system") {
        await markDeliverySkipped(
          supabase,
          delivery.id,
          "No external provider for app/system channel",
        );
        continue;
      }

      await supabase
        .from("support_message_deliveries")
        .update({
          status: "queued",
          attempt_count: delivery.attempt_count + 1,
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", delivery.id);

      try {
        if (delivery.channel === "email") {
          await sendEmailDelivery(supabase, delivery);
        } else if (delivery.channel === "discogs") {
          await sendDiscogsDelivery(delivery);
        } else {
          await markDeliverySkipped(
            supabase,
            delivery.id,
            `Unsupported support channel: ${delivery.channel}`,
          );
          continue;
        }

        await supabase
          .from("support_message_deliveries")
          .update({
            status: "sent",
            error_code: null,
            error_message: null,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", delivery.id);

        await recordDeliveryEvent(supabase, delivery, "delivery_sent");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attemptCount = delivery.attempt_count + 1;
        const permanentlyFailed = attemptCount >= 5;
        await supabase
          .from("support_message_deliveries")
          .update({
            status: "failed",
            error_code: "provider_error",
            error_message: message,
            next_retry_at: permanentlyFailed ? null : nextSupportDeliveryRetryAt(attemptCount),
            updated_at: new Date().toISOString(),
          })
          .eq("id", delivery.id);

        await recordDeliveryEvent(supabase, delivery, "delivery_failed", {
          error_message: message,
          permanent: permanentlyFailed,
        });
      }
    }
  },
});

export const supportDeliveryRecoveryTask = schedules.task({
  id: "support-delivery-recovery",
  cron: "*/5 * * * *",
  maxDuration: 300,
  run: async () => {
    const supabase = createServiceRoleClient();
    const { data: rows, error } = await supabase
      .from("support_message_deliveries")
      .select("message_id")
      .eq("status", "failed")
      .lt("attempt_count", 5)
      .lte("next_retry_at", new Date().toISOString())
      .limit(100);

    if (error) throw new Error(`Failed to load support recovery rows: ${error.message}`);

    const messageIds = [...new Set((rows ?? []).map((row) => row.message_id))];
    for (const messageId of messageIds) {
      await supportMessageDeliveryTask.trigger({ messageId });
    }

    return { retriedMessageCount: messageIds.length };
  },
});

async function sendEmailDelivery(
  supabase: ReturnType<typeof createServiceRoleClient>,
  delivery: DeliveryRow,
) {
  const recipients = (delivery.recipient ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (recipients.length === 0) {
    throw new Error("No email recipient configured");
  }

  let lastProviderId: string | null = null;
  for (const recipient of recipients) {
    const result = await sendSupportEmail(
      recipient,
      `Re: ${delivery.message?.conversation?.subject ?? "Support request"}`,
      delivery.message?.body ?? "",
      delivery.message?.email_message_id ?? undefined,
    );
    lastProviderId = result.messageId;
  }

  await supabase
    .from("support_message_deliveries")
    .update({ provider_message_id: lastProviderId, provider: "resend" })
    .eq("id", delivery.id);

  if (lastProviderId) {
    await supabase
      .from("support_messages")
      .update({ email_message_id: lastProviderId, delivered_via_email: true })
      .eq("id", delivery.message_id);
  }
}

async function sendDiscogsDelivery(delivery: DeliveryRow) {
  const discogsOrderId = delivery.provider_thread_id ?? delivery.recipient;
  if (!discogsOrderId) {
    throw new Error("No Discogs order id configured");
  }

  const result = await discogsMessageSendTask.triggerAndWait({
    workspaceId: delivery.workspace_id,
    discogsOrderId,
    message: delivery.message?.body ?? "",
  });

  if (!result.ok || !result.output?.success) {
    throw new Error(
      result.ok
        ? (result.output?.error ?? "Discogs message task failed")
        : "Discogs message task failed",
    );
  }
}

async function markDeliverySkipped(
  supabase: ReturnType<typeof createServiceRoleClient>,
  deliveryId: string,
  reason: string,
) {
  await supabase
    .from("support_message_deliveries")
    .update({
      status: "skipped",
      error_message: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
}

async function recordDeliveryEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  delivery: DeliveryRow,
  eventType: "delivery_sent" | "delivery_failed",
  metadata: Record<string, unknown> = {},
) {
  await supabase.from("support_conversation_events").insert({
    workspace_id: delivery.workspace_id,
    conversation_id: delivery.conversation_id,
    event_type: eventType,
    metadata: { delivery_id: delivery.id, channel: delivery.channel, ...metadata },
  });
}
