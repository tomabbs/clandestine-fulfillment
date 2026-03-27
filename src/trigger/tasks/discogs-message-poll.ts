/**
 * Poll Discogs order messages and route buyer messages to the support system.
 *
 * Deduplication: SHA-256 hash of (order_id + from_username + timestamp + message)
 * stored in discogs_order_messages.message_hash.
 *
 * Creates support conversations for new buyer contacts, mapped via
 * discogs_support_mappings.
 *
 * Rule #7: Uses createServiceRoleClient().
 * maxDuration: 300 — rate limit backoffs require extra time.
 */

import crypto from "node:crypto";
import { schedules, task } from "@trigger.dev/sdk";
import type { DiscogsAuthConfig } from "@/lib/clients/discogs-client";
import { getOrderMessages } from "@/lib/clients/discogs-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function runMessagePoll(): Promise<{
  messagesProcessed: number;
  conversationsCreated: number;
}> {
  const supabase = createServiceRoleClient();
  const workspaceIds = await getAllWorkspaceIds(supabase);

  let messagesProcessed = 0;
  let conversationsCreated = 0;

  for (const workspaceId of workspaceIds) {
    const { data: credentials } = await supabase
      .from("discogs_credentials")
      .select("access_token")
      .eq("workspace_id", workspaceId)
      .single();

    if (!credentials?.access_token) continue;

    const config: DiscogsAuthConfig = { accessToken: credentials.access_token };

    // Get orders that need message polling (recent unfulfilled + shipped)
    const { data: mailOrders } = await supabase
      .from("mailorder_orders")
      .select("id, external_order_id, org_id, customer_name")
      .eq("workspace_id", workspaceId)
      .eq("source", "clandestine_discogs")
      .in("fulfillment_status", ["unfulfilled", "fulfilled"])
      .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()) // last 90 days
      .limit(50);

    if (!mailOrders?.length) continue;

    for (const order of mailOrders) {
      try {
        const messages = await getOrderMessages(config, order.external_order_id);

        for (const msg of messages) {
          // Only process buyer messages
          if (msg.from?.username === undefined) continue;
          const isBuyerMessage = msg.type === "message" && !!msg.message;
          if (!isBuyerMessage) continue;

          // Compute dedup hash
          const hashInput = `${order.external_order_id}:${msg.from.username}:${msg.timestamp}:${msg.message ?? ""}`;
          const messageHash = crypto.createHash("sha256").update(hashInput).digest("hex");

          // Skip if already processed
          const { data: existing } = await supabase
            .from("discogs_order_messages")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("message_hash", messageHash)
            .single();

          if (existing) continue;

          // Ensure a support conversation exists for this order
          let conversationId: string;
          const { data: existingMapping } = await supabase
            .from("discogs_support_mappings")
            .select("support_conversation_id")
            .eq("workspace_id", workspaceId)
            .eq("discogs_order_id", order.external_order_id)
            .single();

          if (existingMapping) {
            conversationId = existingMapping.support_conversation_id;
          } else {
            // Create a new support conversation
            const { data: newConversation } = await supabase
              .from("support_conversations")
              .insert({
                workspace_id: workspaceId,
                org_id: order.org_id,
                subject: `Discogs order ${order.external_order_id} — ${order.customer_name ?? msg.from.username}`,
                status: "open",
                priority: "normal",
              })
              .select("id")
              .single();

            if (!newConversation) continue;
            conversationId = newConversation.id;

            await supabase.from("discogs_support_mappings").insert({
              workspace_id: workspaceId,
              discogs_order_id: order.external_order_id,
              discogs_buyer_username: msg.from.username,
              discogs_buyer_id: msg.from.id,
              support_conversation_id: conversationId,
            });

            conversationsCreated++;
          }

          // Add message to the support conversation
          const { data: supportMsg } = await supabase
            .from("support_messages")
            .insert({
              conversation_id: conversationId,
              workspace_id: workspaceId,
              sender_type: "client",
              source: "app",
              delivered_via_email: false,
              body: `[Discogs: @${msg.from.username}]\n\n${msg.message}`,
            })
            .select("id")
            .single();

          // Record the message with dedup hash
          await supabase.from("discogs_order_messages").insert({
            workspace_id: workspaceId,
            discogs_order_id: order.external_order_id,
            message_hash: messageHash,
            timestamp: msg.timestamp,
            from_username: msg.from.username,
            from_type: "buyer",
            message_type: "message",
            message_text: msg.message ?? "",
            support_message_id: supportMsg?.id ?? null,
          });

          messagesProcessed++;
        }

        // Update last check time
        await supabase
          .from("discogs_support_mappings")
          .update({ last_message_check_at: new Date().toISOString() })
          .eq("workspace_id", workspaceId)
          .eq("discogs_order_id", order.external_order_id);
      } catch (err) {
        console.error(
          `[discogs-message-poll] Failed for order ${order.external_order_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { messagesProcessed, conversationsCreated };
}

export const discogsMessagePollTask = task({
  id: "discogs-message-poll",
  maxDuration: 300,
  run: async () => runMessagePoll(),
});

export const discogsMessagePollSchedule = schedules.task({
  id: "discogs-message-poll-schedule",
  cron: "*/5 * * * *", // every 5 minutes
  maxDuration: 300,
  run: async () => runMessagePoll(),
});
