/**
 * Mark a mail-order as shipped on its originating platform.
 *
 * Sources:
 *   clandestine_shopify → mark order fulfilled on main Clandestine Shopify (2026-01)
 *   clandestine_discogs → send shipping message + status update to Discogs
 *
 * On success: sets platform_fulfillment_status = 'confirmed'
 * On failure: sets platform_fulfillment_status = 'failed' + review queue item
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { task } from "@trigger.dev/sdk";
import OAuth from "oauth-1.0a";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

export const markMailorderFulfilledTask = task({
  id: "mark-mailorder-fulfilled",
  maxDuration: 60,
  run: async (payload: { mailorder_id: string; tracking_number: string; carrier: string }) => {
    const supabase = createServiceRoleClient();
    const { mailorder_id, tracking_number, carrier } = payload;

    const { data: order } = await supabase
      .from("mailorder_orders")
      .select("id, source, metadata, org_id, workspace_id, external_order_id")
      .eq("id", mailorder_id)
      .single();

    if (!order) return { skipped: true, reason: "order_not_found" };

    const platformOrderId =
      (order.metadata as Record<string, string> | null)?.platform_order_id ??
      order.external_order_id;

    if (!platformOrderId) return { skipped: true, reason: "no_platform_order_id" };

    try {
      switch (order.source) {
        case "clandestine_shopify":
          await markMainShopifyFulfilled(platformOrderId, tracking_number, carrier);
          break;
        case "clandestine_discogs":
          await markMainDiscogsFulfilled(platformOrderId, tracking_number, carrier);
          break;
        default:
          return { skipped: true, reason: `unsupported_source:${order.source}` };
      }

      await supabase
        .from("mailorder_orders")
        .update({ platform_fulfillment_status: "confirmed", updated_at: new Date().toISOString() })
        .eq("id", mailorder_id);

      return { success: true, source: order.source };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mark-mailorder-fulfilled] ${order.source} error:`, msg);

      await supabase
        .from("mailorder_orders")
        .update({ platform_fulfillment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", mailorder_id);

      await supabase.from("warehouse_review_queue").insert({
        workspace_id: order.workspace_id,
        org_id: order.org_id,
        category: "fulfillment",
        severity: "medium",
        title: `Failed to mark ${order.source} mail-order fulfilled`,
        description: `Order ${platformOrderId}: ${msg}`,
        metadata: {
          mailorder_id: order.id,
          source: order.source,
          platform_order_id: platformOrderId,
          tracking_number,
          error: msg,
        },
        group_key: `mailorder_fulfill:${order.id}`,
        status: "open",
      });

      return { success: false, error: msg };
    }
  },
});

// ── Platform implementations ──────────────────────────────────────────────────

async function markMainShopifyFulfilled(
  orderId: string,
  trackingNumber: string,
  carrier: string,
): Promise<void> {
  const shopifyUrl = env().SHOPIFY_STORE_URL.replace(/\/$/, "");
  const headers = {
    "X-Shopify-Access-Token": env().SHOPIFY_ADMIN_API_TOKEN,
    "Content-Type": "application/json",
  };

  const foRes = await fetch(
    `${shopifyUrl}/admin/api/2026-01/orders/${orderId}/fulfillment_orders.json`,
    { headers },
  );
  if (!foRes.ok) throw new Error(`Shopify fulfillment_orders ${foRes.status}`);

  const { fulfillment_orders } = (await foRes.json()) as {
    fulfillment_orders: Array<{ id: number; status: string }>;
  };
  const openFO = fulfillment_orders.find((fo) => fo.status === "open");
  if (!openFO) {
    // Already fulfilled — not an error
    return;
  }

  const fulfillRes = await fetch(`${shopifyUrl}/admin/api/2026-01/fulfillments.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: openFO.id }],
        tracking_info: { number: trackingNumber, company: carrier },
        // Phase 10.4 — channel='shopify_main' under "hybrid" strategy →
        // suppressShopifyEmail=false → Clandestine Shopify owns the
        // confirmation email. Hardcoded true here matches the canonical
        // matrix; flip via workspaces.flags.email_send_strategy if needed.
        notify_customer: true,
      },
    }),
  });

  if (!fulfillRes.ok) {
    const body = await fulfillRes.text();
    throw new Error(`Shopify fulfillment create ${fulfillRes.status}: ${body}`);
  }
}

async function markMainDiscogsFulfilled(
  orderId: string,
  trackingNumber: string,
  carrierName: string,
): Promise<void> {
  const { data: creds } = await createServiceRoleClient()
    .from("discogs_credentials")
    .select("access_token")
    .single();

  if (!creds?.access_token) throw new Error("No Discogs master credentials configured");

  const _oauth = new OAuth({
    consumer: {
      key: env().DISCOGS_CONSUMER_KEY,
      secret: env().DISCOGS_CONSUMER_SECRET,
    },
    signature_method: "PLAINTEXT",
    hash_function(_base, key) {
      return key;
    },
  });

  // Master catalog uses Personal Access Token — not OAuth token
  const messageUrl = `https://api.discogs.com/marketplace/orders/${orderId}/messages`;
  const message = `Your order has shipped! Tracking: ${trackingNumber}${carrierName ? ` via ${carrierName}` : ""}`;

  const res = await fetch(messageUrl, {
    method: "POST",
    headers: {
      Authorization: `Discogs token=${creds.access_token}`,
      "User-Agent": "ClandestineFulfillment/1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, status: "Shipped" }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs order message ${res.status}: ${body}`);
  }
}
