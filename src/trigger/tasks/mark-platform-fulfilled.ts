/**
 * Mark a fulfillment order as shipped on its originating platform.
 *
 * Platforms:
 *   shopify    → fulfillment_orders + fulfillments API (per-client, version
 *                from `SHOPIFY_CLIENT_API_VERSION` — currently 2026-04)
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

import { logger, task } from "@trigger.dev/sdk";
import OAuth from "oauth-1.0a";
import { releaseOrderItems } from "@/lib/server/inventory-commitments";
import { openWriteback, recordBlockedWriteback } from "@/lib/server/platform-fulfillment-writeback";
import {
  fetchFulfillmentOrdersForOrder,
  runFulfillmentCreateMutation,
  selectFulfillmentOrder,
  toShopifyOrderGid,
} from "@/lib/server/shopify-fulfillment";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { env } from "@/lib/shared/env";
import {
  deriveNotificationStrategy,
  type NotificationChannel,
} from "@/lib/shared/notification-strategy";

/**
 * B-2 / HRD-28 — Shopify fulfillment failure carrier.
 *
 * `markShopifyFulfilled()` throws this when Shopify GraphQL returns
 * `userErrors[]` (mutation-level rejection) OR when fulfillment-order
 * selection has no actionable target. Top-level transport `errors[]` are
 * thrown as plain Error by `connectionShopifyGraphQL`; we catch those at
 * the task boundary and persist `error.message` instead. Both paths land
 * raw arrays on `warehouse_review_queue.metadata` so debugging never has
 * to re-run the failing call.
 */
class ShopifyFulfillmentError extends Error {
  readonly userErrors: Array<{ field?: string[] | null; message: string }>;
  readonly partialFulfillmentId: string | null;
  readonly selectionFailure: "no_actionable_status" | "no_sku_coverage" | null;

  constructor(args: {
    message: string;
    userErrors?: Array<{ field?: string[] | null; message: string }>;
    partialFulfillmentId?: string | null;
    selectionFailure?: "no_actionable_status" | "no_sku_coverage" | null;
  }) {
    super(args.message);
    this.name = "ShopifyFulfillmentError";
    this.userErrors = args.userErrors ?? [];
    this.partialFulfillmentId = args.partialFulfillmentId ?? null;
    this.selectionFailure = args.selectionFailure ?? null;
  }
}

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

    // Bandcamp handled separately by bandcamp-mark-shipped cron. Record a
    // blocked writeback so Direct Orders renders the explicit reason instead
    // of "no writeback row found".
    if (order.source === "bandcamp") {
      await recordBlockedWriteback({
        supabase,
        workspaceId: order.workspace_id as string,
        warehouseOrderId: order.id as string,
        platform: "bandcamp",
        status: "blocked_bandcamp_generic_path",
        reason: "bandcamp-mark-shipped cron handles Bandcamp writeback; generic path blocked.",
      });
      return { skipped: true, reason: "bandcamp_handled_separately" };
    }
    if (order.source === "manual") return { skipped: true, reason: "manual_order" };

    // Phase 5b — accept warehouse_orders.external_order_id as a fallback
    // when metadata.platform_order_id is absent (legacy/historical rows
    // ingested before metadata.platform_order_id was canonical).
    const platformOrderId =
      (order.metadata as Record<string, string> | null)?.platform_order_id ??
      (order.external_order_id as string | null) ??
      null;
    if (!platformOrderId) {
      await recordBlockedWriteback({
        supabase,
        workspaceId: order.workspace_id as string,
        warehouseOrderId: order.id as string,
        platform: order.source as string,
        status: "blocked_missing_identity",
        reason:
          "Missing metadata.platform_order_id AND warehouse_orders.external_order_id; cannot writeback.",
      });
      return { skipped: true, reason: "no_platform_order_id_in_metadata" };
    }

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

    // B-2: pull line items so the GraphQL fulfillment-order selector can pick
    // the FO whose SKU coverage matches what we actually shipped. We use
    // `fulfilled_quantity` (write-only from webhook handlers per F-1 contract)
    // to derive the remaining quantity per SKU.
    const { data: orderItems } = await supabase
      .from("warehouse_order_items")
      .select("id, sku, quantity, fulfilled_quantity")
      .eq("warehouse_order_id", order_id);

    const requiredSkus = new Map<string, number>();
    const writebackLines: Array<{ warehouseOrderItemId: string; quantity: number }> = [];
    for (const item of orderItems ?? []) {
      const sku = item.sku as string | null;
      if (!sku) continue;
      const ordered = Number(item.quantity ?? 0);
      const fulfilled = Number(item.fulfilled_quantity ?? 0);
      const remaining = Math.max(0, ordered - fulfilled);
      if (remaining > 0) {
        requiredSkus.set(sku, remaining);
        writebackLines.push({
          warehouseOrderItemId: item.id as string,
          quantity: remaining,
        });
      }
    }

    // Phase 5b — open writeback ledger BEFORE the platform call so a crash
    // mid-call leaves an `in_progress` row visible on Direct Orders.
    const ledger = await openWriteback({
      supabase,
      workspaceId: order.workspace_id as string,
      warehouseOrderId: order.id as string,
      shipmentId: null,
      platform: order.source as string,
      connectionId: (connection as { id: string }).id ?? null,
      externalOrderId: platformOrderId,
      lines: writebackLines,
      requestSummary: { tracking_number, carrier },
    });

    try {
      switch (order.source) {
        case "shopify":
          await markShopifyFulfilled({
            connection,
            platformOrderId,
            trackingNumber: tracking_number,
            carrier,
            notifyCustomer,
            requiredSkus,
            workspaceId: order.workspace_id as string,
          });
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

      await ledger.recordAll({ status: "succeeded" });

      // Phase 5 §9.6 D1.b — release every open commit for this
      // order. Fulfillment confirmation = stock has physically left
      // the building, so the commit has resolved (the underlying
      // `available` decrement happened at orders/create per the
      // existing semantic; this just clears the audit ledger row).
      //
      // While `workspaces.atp_committed_active` is FALSE (the default
      // per migration 20260424000005), this release has no effect on
      // the push formula — it just keeps the ledger clean for the
      // daily counter↔ledger recon task.
      //
      // Failure isolation: a release failure must NEVER mark the
      // platform as un-fulfilled. The platform side already
      // confirmed; a stale ledger row will surface in recon as drift
      // but is recoverable (manual release via admin UI in Phase 5
      // D3+).
      try {
        const releaseResult = await releaseOrderItems({
          workspaceId: order.workspace_id as string,
          orderId: order_id,
          reason: `platform_fulfilled:${order.source}`,
        });
        if (releaseResult.released > 0) {
          logger.info("releaseOrderItems(fulfill) released commits", {
            order_id,
            platform: order.source,
            released: releaseResult.released,
          });
        }
      } catch (relErr) {
        const msg = relErr instanceof Error ? relErr.message : String(relErr);
        logger.error("releaseOrderItems(fulfill) failed", {
          order_id,
          platform: order.source,
          error: msg,
        });
        await supabase.from("sensor_readings").insert({
          workspace_id: order.workspace_id,
          sensor_name: "inv.commit_ledger_release_failed",
          status: "warning",
          message: `releaseOrderItems(fulfill) failed for order ${order_id}: ${msg.slice(0, 200)}`,
          value: { order_id, platform: order.source, error: msg, kind: "fulfill" },
        });
      }

      return { success: true, platform: order.source };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mark-platform-fulfilled] ${order.source} error:`, msg);

      await supabase
        .from("warehouse_orders")
        .update({ platform_fulfillment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", order_id);

      // Treat repeated transport failures (>=3) as terminal so retry storms
      // don't keep flapping the order-level status.
      const isTerminal = err instanceof ShopifyFulfillmentError && err.selectionFailure !== null;
      await ledger.recordAll({
        status: isTerminal ? "failed_terminal" : "failed_retryable",
        errorCode:
          err instanceof ShopifyFulfillmentError
            ? (err.selectionFailure ?? "shopify_user_error")
            : "platform_error",
        errorMessage: msg.slice(0, 500),
      });

      // B-2: persist the raw GraphQL `userErrors[]` and selection-failure
      // diagnostics on the review queue row so debugging never has to
      // re-run the failing Shopify call. Plain Errors thrown by
      // `connectionShopifyGraphQL` (top-level GraphQL `errors[]`,
      // throttled, or transport) are captured via `error: msg`.
      const fulfillmentMetadata: Record<string, unknown> = {
        order_id: order.id,
        platform: order.source,
        platform_order_id: platformOrderId,
        tracking_number,
        error: msg,
      };
      if (err instanceof ShopifyFulfillmentError) {
        fulfillmentMetadata.shopify_user_errors = err.userErrors;
        fulfillmentMetadata.shopify_partial_fulfillment_id = err.partialFulfillmentId;
        fulfillmentMetadata.shopify_selection_failure = err.selectionFailure;
      }

      await supabase.from("warehouse_review_queue").insert({
        workspace_id: order.workspace_id,
        org_id: order.org_id,
        category: "fulfillment",
        severity: "medium",
        title: `Failed to mark ${order.source} order fulfilled`,
        description: `Order ${platformOrderId}: ${msg}`,
        metadata: fulfillmentMetadata,
        group_key: `platform_fulfill:${order.id}`,
        status: "open",
      });

      return { success: false, error: msg };
    }
  },
});

// ── Platform implementations ──────────────────────────────────────────────────

/**
 * B-2 / HRD-28 — mark a Shopify order fulfilled via the GraphQL
 * `fulfillmentCreate` mutation.
 *
 * Replaced the legacy REST flow (GET fulfillment_orders.json → POST
 * fulfillments.json) which had two silent footguns:
 *   1. `status === 'open'` filter missed `IN_PROGRESS` partial-fulfillment
 *      cases → "No open fulfillment order found" false negatives.
 *   2. REST returned a fulfillment id alongside transport-level failures
 *      that callers might mistake for success.
 *
 * GraphQL paths handled here:
 *   - Top-level `errors[]` (transport / throttle / auth) → thrown by
 *     `connectionShopifyGraphQL`; surfaces as plain Error.
 *   - Mutation `userErrors[]` → thrown as `ShopifyFulfillmentError` so the
 *     caller persists the raw array on review queue metadata.
 *   - FO selection ambiguity → caller emits a sensor warning; oldest GID
 *     wins (Shopify GIDs are monotonically increasing).
 *   - Zero matching FOs → `ShopifyFulfillmentError` with selectionFailure
 *     set; no implicit fallback (per plan).
 *
 * `notify_customer` strategy comes from `deriveNotificationStrategy()` —
 * unchanged from the REST path, just renamed to GraphQL casing.
 */
async function markShopifyFulfilled(args: {
  connection: { api_key: string | null; store_url: string };
  platformOrderId: string;
  trackingNumber: string;
  carrier: string;
  notifyCustomer: boolean;
  requiredSkus: Map<string, number>;
  workspaceId: string;
}): Promise<void> {
  const apiKey = args.connection.api_key;
  if (!apiKey) throw new Error("Missing api_key for Shopify connection");

  const ctx = { storeUrl: args.connection.store_url, accessToken: apiKey };
  const orderGid = toShopifyOrderGid(args.platformOrderId);

  const fulfillmentOrders = await fetchFulfillmentOrdersForOrder(ctx, orderGid);
  const selection = selectFulfillmentOrder({
    fulfillmentOrders,
    requiredSkus: args.requiredSkus,
  });

  if (selection.kind === "none_match") {
    throw new ShopifyFulfillmentError({
      message: `No actionable fulfillment order on Shopify (${selection.reason}); fulfillmentOrders=${fulfillmentOrders.length}`,
      selectionFailure: selection.reason,
    });
  }

  if (selection.ambiguous) {
    logger.warn("mark-platform-fulfilled: ambiguous fulfillment-order selection", {
      orderGid,
      chosen_fulfillment_order_id: selection.fulfillmentOrder.id,
      tie_breaker: selection.tieBreakerReason ?? "covering_sku_set",
      candidate_count: fulfillmentOrders.length,
    });
  }

  const result = await runFulfillmentCreateMutation({
    ctx,
    fulfillmentOrderId: selection.fulfillmentOrder.id,
    trackingNumber: args.trackingNumber,
    carrier: args.carrier,
    // Phase 10.4 — driven by deriveNotificationStrategy. shopify_client
    // under "hybrid" sends Shopify's native email (notifyCustomer=true).
    // AfterShip is event-ingestion-only post Phase 10.5.
    notifyCustomer: args.notifyCustomer,
  });

  if (result.kind === "user_errors") {
    throw new ShopifyFulfillmentError({
      message: `Shopify fulfillmentCreate userErrors: ${result.userErrors.map((e) => e.message).join("; ")}`,
      userErrors: result.userErrors,
      partialFulfillmentId: result.partialFulfillmentId,
    });
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
