/**
 * Send a message on a Discogs order.
 *
 * Triggered by staff from the support UI when replying to a buyer.
 * Optionally updates the order status (e.g., "Shipped").
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 * maxDuration: 300 — rate limit backoffs require extra time.
 */

import { task } from "@trigger.dev/sdk";
import type { DiscogsAuthConfig } from "@/lib/clients/discogs-client";
import { sendOrderMessage } from "@/lib/clients/discogs-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const discogsMessageSendTask = task({
  id: "discogs-message-send",
  maxDuration: 300,
  run: async (payload: {
    workspaceId: string;
    discogsOrderId: string;
    message: string;
    status?: string;
  }) => {
    const supabase = createServiceRoleClient();

    const { data: credentials } = await supabase
      .from("discogs_credentials")
      .select("access_token")
      .eq("workspace_id", payload.workspaceId)
      .single();

    if (!credentials?.access_token) {
      return { success: false, error: "No Discogs credentials configured" };
    }

    const config: DiscogsAuthConfig = { accessToken: credentials.access_token };

    try {
      await sendOrderMessage(config, payload.discogsOrderId, {
        message: payload.message,
        status: payload.status,
      });

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[discogs-message-send] Failed for order ${payload.discogsOrderId}:`, msg);
      return { success: false, error: msg };
    }
  },
});
