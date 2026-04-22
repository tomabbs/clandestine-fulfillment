/**
 * Mark a fulfillment order as shipped on its originating platform.
 *
 * Platforms:
 *   shopify    → fulfillment_orders + fulfillments API (2026-01)
 *   woocommerce → PUT /orders/{id} status: completed + tracking meta
 *   squarespace → POST /commerce/orders/{id}/fulfillments  ← C1 fix (not "no API")
 *   discogs    → PLAINTEXT OAuth 1.0a message + status update
 *   bandcamp   → skipped — bandcamp-mark-shipped cron handles it
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
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { env } from "@/lib/shared/env";
import {
  deriveNotificationStrategy,
  type NotificationChannel,
} from "@/lib/shared/notification-strategy";

export const markPlatformFulfilledTask = task({
  id: "mark-platform-fulfilled",
  maxDuration: 60,
  run: async (payload: { order_id: string; tracking_number: string; carrier: string }) => {
    const supabase = createServiceRoleClient();
    const { order_id, tracking_number, carrier } = payload;

    const { data: order } = await supabase
      .from("warehouse_orders")
      .select("id, source, metadata, org_id, workspace_id, external_order_id")
      .eq("id", order_id)
      .single();

    if (!order) return { skipped: true, reason: "order_not_found" };

    // Bandcamp handled separately by bandcamp-mark-shipped cron
    if (order.source === "bandcamp")
      return { skipped: true, reason: "bandcamp_handled_separately" };
    if (order.source === "manual") return { skipped: true, reason: "manual_order" };

    const platformOrderId = (order.metadata as Record<string, string> | null)?.platform_order_id;
    if (!platformOrderId) return { skipped: true, reason: "no_platform_order_id_in_metadata" };

    const { data: connection } = await supabase
      .from("client_store_connections")
      .select("*")
      .eq("org_id", order.org_id)
      .eq("platform", order.source)
      .eq("connection_status", "active")
      .single();

    if (!connection) return { skipped: true, reason: "no_active_connection" };

    // Phase 10.4 — derive notify decision from the canonical strategy fn
    // BEFORE calling any platform API. Pass carrier so Asendia gap-fill is
    // resolved correctly (no impact on Shopify but logged for audit).
    const flags = await getWorkspaceFlags(order.workspace_id as string);
    const channel: NotificationChannel =
      order.source === "shopify"
        ? "shopify_client"
        : order.source === "squarespace"
          ? "squarespace"
          : order.source === "woocommerce"
            ? "woocommerce"
            : "unknown";
    const strategy = deriveNotificationStrategy({
      channel,
      carrier,
      workspaceFlags: {
        email_send_strategy: flags.email_send_strategy,
        bandcamp_skip_ss_email: flags.bandcamp_skip_ss_email,
      },
    });
    const notifyCustomer = !strategy.suppressShopifyEmail;
    await supabase.from("sensor_readings").insert({
      workspace_id: order.workspace_id,
      sensor_name: "notification.strategy_decision",
      status: "healthy",
      message: `[platform-fulfilled order=${order_id.slice(0, 8)}] channel=${channel} → ${strategy.rationale}`,
      value: { channel, carrier, suppressShopifyEmail: strategy.suppressShopifyEmail },
    });

    try {
      switch (order.source) {
        case "shopify":
          await markShopifyFulfilled(
            connection,
            platformOrderId,
            tracking_number,
            carrier,
            notifyCustomer,
          );
          break;
        case "woocommerce":
          await markWooCommerceFulfilled(connection, platformOrderId, tracking_number, carrier);
          break;
        case "squarespace":
          await markSquarespaceFulfilled(connection, platformOrderId, tracking_number, carrier);
          break;
        case "discogs":
          await markDiscogsFulfilled(connection, platformOrderId, tracking_number, carrier);
          break;
        default:
          return { skipped: true, reason: `unsupported_platform:${order.source}` };
      }

      await supabase
        .from("warehouse_orders")
        .update({ platform_fulfillment_status: "confirmed", updated_at: new Date().toISOString() })
        .eq("id", order_id);

      return { success: true, platform: order.source };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mark-platform-fulfilled] ${order.source} error:`, msg);

      await supabase
        .from("warehouse_orders")
        .update({ platform_fulfillment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", order_id);

      await supabase.from("warehouse_review_queue").insert({
        workspace_id: order.workspace_id,
        org_id: order.org_id,
        category: "fulfillment",
        severity: "medium",
        title: `Failed to mark ${order.source} order fulfilled`,
        description: `Order ${platformOrderId}: ${msg}`,
        metadata: {
          order_id: order.id,
          platform: order.source,
          platform_order_id: platformOrderId,
          tracking_number,
          error: msg,
        },
        group_key: `platform_fulfill:${order.id}`,
        status: "open",
      });

      return { success: false, error: msg };
    }
  },
});

// ── Platform implementations ──────────────────────────────────────────────────

async function markShopifyFulfilled(
  connection: { api_key: string | null; store_url: string },
  orderId: string,
  trackingNumber: string,
  carrier: string,
  notifyCustomer: boolean,
): Promise<void> {
  const apiKey = connection.api_key;
  if (!apiKey) throw new Error("Missing api_key for Shopify connection");

  const baseUrl = connection.store_url.replace(/\/$/, "");
  const headers = { "X-Shopify-Access-Token": apiKey, "Content-Type": "application/json" };

  // Get open fulfillment order
  const foRes = await fetch(
    `${baseUrl}/admin/api/2026-01/orders/${orderId}/fulfillment_orders.json`,
    { headers },
  );
  if (!foRes.ok) throw new Error(`Shopify fulfillment_orders ${foRes.status}`);

  const { fulfillment_orders } = (await foRes.json()) as {
    fulfillment_orders: Array<{ id: number; status: string }>;
  };
  const openFO = fulfillment_orders.find((fo) => fo.status === "open");
  if (!openFO) throw new Error("No open fulfillment order found on Shopify");

  const fulfillRes = await fetch(`${baseUrl}/admin/api/2026-01/fulfillments.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: openFO.id }],
        tracking_info: { number: trackingNumber, company: carrier },
        // Phase 10.4 — driven by deriveNotificationStrategy. Per the canonical
        // matrix, shopify_client under "hybrid" sends Shopify's native email
        // (notifyCustomer=true). The legacy "false → AfterShip handles" path
        // is gone; AfterShip is now event-ingestion-only (Phase 10.5 sunset).
        notify_customer: notifyCustomer,
      },
    }),
  });

  if (!fulfillRes.ok) {
    const body = await fulfillRes.text();
    throw new Error(`Shopify fulfillment create ${fulfillRes.status}: ${body}`);
  }
}

async function markWooCommerceFulfilled(
  connection: {
    api_key: string | null;
    api_secret: string | null;
    store_url: string;
    metadata?: Record<string, unknown> | null;
  },
  orderId: string,
  trackingNumber: string,
  carrierName: string,
): Promise<void> {
  const { api_key, api_secret } = connection;
  if (!api_key || !api_secret) throw new Error("Missing credentials for WooCommerce connection");

  const baseUrl = connection.store_url.replace(/\/$/, "");
  const auth = Buffer.from(`${api_key}:${api_secret}`).toString("base64");

  // Allow configuring meta key names per store (some plugins differ)
  const meta = connection.metadata as { tracking_meta_keys?: string[] } | null;
  const trackingMetaKeys = meta?.tracking_meta_keys ?? ["_tracking_number", "_tracking_provider"];

  const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders/${orderId}`, {
    method: "PUT",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      meta_data: [
        { key: trackingMetaKeys[0] ?? "_tracking_number", value: trackingNumber },
        { key: trackingMetaKeys[1] ?? "_tracking_provider", value: carrierName },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WooCommerce order update ${res.status}: ${body}`);
  }
}

async function markSquarespaceFulfilled(
  connection: { api_key: string | null; store_url: string },
  orderId: string,
  trackingNumber: string,
  carrierName: string,
): Promise<void> {
  const apiKey = connection.api_key;
  if (!apiKey) throw new Error("Missing api_key for Squarespace connection");

  // C1 fix: Squarespace DOES have a fulfillment API
  const res = await fetch(
    `https://api.squarespace.com/1.0/commerce/orders/${orderId}/fulfillments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "ClandestineFulfillment/1.0",
      },
      body: JSON.stringify({
        shouldSendNotification: false, // AfterShip handles notifications
        shipments: [
          {
            shipDate: new Date().toISOString(),
            carrierName,
            trackingNumber,
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Squarespace fulfillment ${res.status}: ${body}`);
  }
}

async function markDiscogsFulfilled(
  connection: {
    api_key: string | null;
    api_secret: string | null;
    metadata?: Record<string, unknown> | null;
  },
  orderId: string,
  trackingNumber: string,
  carrierName: string,
): Promise<void> {
  const { api_key, api_secret } = connection;
  if (!api_key || !api_secret) throw new Error("Missing OAuth tokens for Discogs connection");

  const oauth = new OAuth({
    consumer: {
      key: env().DISCOGS_CONSUMER_KEY,
      secret: env().DISCOGS_CONSUMER_SECRET,
    },
    signature_method: "PLAINTEXT",
    hash_function(_base, key) {
      return key;
    },
  });

  const token = { key: api_key, secret: api_secret };

  // Send shipping message + status update
  const messageUrl = `https://api.discogs.com/marketplace/orders/${orderId}/messages`;
  const messageData = {
    url: messageUrl,
    method: "POST",
    data: {
      message: `Your order has shipped! Tracking: ${trackingNumber}${carrierName ? ` via ${carrierName}` : ""}`,
      status: "Shipped",
    },
  };

  const authHeader = oauth.toHeader(oauth.authorize(messageData, token));
  const res = await fetch(messageUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader.Authorization,
      "User-Agent": "ClandestineFulfillment/1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: messageData.data.message,
      status: messageData.data.status,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs order message ${res.status}: ${body}`);
  }
}
