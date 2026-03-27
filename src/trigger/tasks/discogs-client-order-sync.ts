/**
 * Sync orders from CLIENT Discogs accounts (not master catalog).
 *
 * CRITICAL ARCHITECTURE DIFFERENCE:
 *   This task handles CLIENT Discogs store connections.
 *   Orders go to warehouse_orders (fulfillment billing).
 *   Auth comes from client_store_connections (NOT discogs_credentials).
 *
 * Compare to discogs-mailorder-sync which handles the MASTER catalog:
 *   master → mailorder_orders (consignment billing, 50% payout)
 *   client → warehouse_orders (fulfillment fees charged to client)
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 * maxDuration: 300 — rate limit backoffs require extra time.
 */

import { schedules, task } from "@trigger.dev/sdk";
import type { DiscogsAuthConfig, DiscogsOrder } from "@/lib/clients/discogs-client";
import { getOrders } from "@/lib/clients/discogs-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

async function runClientOrderSync(payload: { workspaceId?: string }): Promise<{
  ordersCreated: number;
  skipped: number;
  errors: number;
}> {
  const supabase = createServiceRoleClient();
  const workspaceIds = payload.workspaceId
    ? [payload.workspaceId]
    : await getAllWorkspaceIds(supabase);

  let ordersCreated = 0;
  let skipped = 0;
  let errors = 0;

  for (const workspaceId of workspaceIds) {
    // Query only Discogs client store connections
    const { data: connections } = await supabase
      .from("client_store_connections")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("platform", "discogs")
      .eq("connection_status", "active");

    if (!connections?.length) continue;

    for (const connection of connections) {
      try {
        const apiKey = connection.api_key;
        const apiSecret = connection.api_secret;

        if (!apiKey || !apiSecret) {
          console.warn(
            `[discogs-client-order-sync] Connection ${connection.id} missing OAuth tokens`,
          );
          continue;
        }

        // OAuth 1.0a auth using client's tokens
        const config: DiscogsAuthConfig = {
          oauthToken: apiKey,
          oauthTokenSecret: apiSecret,
          consumerKey: env().DISCOGS_CONSUMER_KEY,
          consumerSecret: env().DISCOGS_CONSUMER_SECRET,
        };

        const since =
          connection.last_poll_at ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const { orders } = await getOrders(config, {
          status: "Payment Received",
          sortBy: "last_activity",
          sortOrder: "desc",
          perPage: 50,
        });

        // Filter to orders newer than since
        const sinceDate = new Date(since);
        const newOrders = orders.filter(
          (o) => new Date(o.created) >= sinceDate || new Date(o.last_activity) >= sinceDate,
        );

        for (const order of newOrders) {
          const result = await upsertClientDiscogsOrder(
            supabase,
            workspaceId,
            connection.org_id,
            connection.id,
            order,
          );
          if (result === "created") ordersCreated++;
          else skipped++;
        }

        // Update last_poll_at
        await supabase
          .from("client_store_connections")
          .update({
            last_poll_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", connection.id);
      } catch (err) {
        errors++;
        console.error(
          `[discogs-client-order-sync] Failed for connection ${connection.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { ordersCreated, skipped, errors };
}

async function upsertClientDiscogsOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  orgId: string,
  connectionId: string,
  order: DiscogsOrder,
): Promise<"created" | "skipped"> {
  // Deduplicate — client Discogs orders use warehouse_orders (NOT mailorder_orders)
  const { data: existing } = await supabase
    .from("warehouse_orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source", "discogs")
    .eq("external_order_id", order.id)
    .single();

  if (existing) return "skipped";

  // Parse shipping address (Discogs returns multi-line string)
  const shippingAddress = order.shipping_address
    ? parseDiscogsShippingAddress(order.shipping_address)
    : null;

  const totalPrice = order.total.value;
  const currency = order.total.currency;

  const lineItems = order.items.map((item) => ({
    discogs_listing_id: item.id,
    release_id: item.release.id,
    description: item.release.description,
    price: item.price.value,
    quantity: 1,
    condition: item.media_condition,
  }));

  const { error } = await supabase.from("warehouse_orders").insert({
    workspace_id: workspaceId,
    org_id: orgId,
    external_order_id: order.id,
    order_number: order.id,
    customer_email: null, // Discogs doesn't expose buyer email
    financial_status: "paid",
    fulfillment_status: "unfulfilled",
    platform_fulfillment_status: "pending",
    total_price: totalPrice,
    currency,
    source: "discogs",
    line_items: lineItems,
    shipping_address: shippingAddress,
    metadata: {
      platform_order_id: order.id,
      discogs_buyer_username: order.buyer.username,
      discogs_buyer_id: order.buyer.id,
      connection_id: connectionId,
    },
    updated_at: new Date().toISOString(),
    synced_at: new Date().toISOString(),
  });

  if (error) {
    console.error(`[discogs-client-order-sync] Insert failed for order ${order.id}:`, error);
    return "skipped";
  }

  return "created";
}

function parseDiscogsShippingAddress(addressString: string): Record<string, string> {
  const lines = addressString
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return {};

  const name = lines[0] ?? "";
  const street1 = lines[1] ?? "";
  const hasStreet2 = lines.length > 4;
  const street2 = hasStreet2 ? (lines[2] ?? "") : "";
  const cityStateLine = hasStreet2 ? (lines[3] ?? "") : (lines[2] ?? "");

  const match = cityStateLine.match(/^(.+),\s*(\w{2})\s*(\d{5}(?:-\d{4})?)$/);
  const city = match?.[1] ?? cityStateLine;
  const state = match?.[2] ?? "";
  const zip = match?.[3] ?? "";

  const countryLine = lines[lines.length - 1] ?? "";
  const country = countryLine.toLowerCase().includes("united states") ? "US" : countryLine;

  return { name, street1, ...(street2 ? { street2 } : {}), city, state, zip, country };
}

export const discogsClientOrderSyncTask = task({
  id: "discogs-client-order-sync",
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) => runClientOrderSync(payload),
});

export const discogsClientOrderSyncSchedule = schedules.task({
  id: "discogs-client-order-sync-cron",
  cron: "*/10 * * * *", // every 10 minutes
  maxDuration: 300,
  run: async () => runClientOrderSync({}),
});
