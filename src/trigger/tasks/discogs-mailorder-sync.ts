/**
 * Sync orders from Clandestine Discogs master account.
 * Orders go to mailorder_orders (consignment billing).
 *
 * CRITICAL INVARIANT:
 *   client_payout_amount = subtotal * 0.5  (NOT total_price)
 *   subtotal = sum of item prices (excludes shipping)
 *
 * Uses discogs_credentials (NOT client_store_connections).
 *
 * Rule #7: Uses createServiceRoleClient().
 * maxDuration: 300 — rate limit backoffs require extra time.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import type { DiscogsAuthConfig } from "@/lib/clients/discogs-client";
import { getOrder, getOrders } from "@/lib/clients/discogs-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function runSync(): Promise<{ imported: number; skipped: number; total: number }> {
  const supabase = createServiceRoleClient();
  const workspaceIds = await getAllWorkspaceIds(supabase);

  let imported = 0;
  let skipped = 0;
  let total = 0;

  for (const workspaceId of workspaceIds) {
    const { data: credentials } = await supabase
      .from("discogs_credentials")
      .select("*")
      .eq("workspace_id", workspaceId)
      .single();

    if (!credentials) {
      logger.info("No Discogs credentials for workspace", {
        task: "discogs-mailorder-sync",
        workspaceId,
      });
      continue;
    }

    const config: DiscogsAuthConfig = { accessToken: credentials.access_token };

    const { orders } = await getOrders(config, {
      status: "Payment Received",
      sortBy: "last_activity",
      sortOrder: "desc",
      perPage: 50,
    });

    total += orders.length;

    for (const order of orders) {
      // Deduplicate
      const { data: existing } = await supabase
        .from("mailorder_orders")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("source", "clandestine_discogs")
        .eq("external_order_id", order.id)
        .single();

      if (existing) {
        skipped++;
        continue;
      }

      // Fetch full order details
      const fullOrder = await getOrder(config, order.id);

      // CRITICAL: subtotal = line items only (excludes shipping)
      const subtotal = fullOrder.items.reduce((sum, item) => sum + item.price.value, 0);
      const shippingAmount = fullOrder.shipping?.value ?? 0;
      const totalPrice = subtotal + shippingAmount;

      const shippingAddress = parseDiscogsAddress(fullOrder.shipping_address ?? "");

      // Determine org via buyer — for now use workspace default org
      // TODO: when SKU → org mapping is complete, route to correct org
      const { data: firstOrg } = await supabase
        .from("organizations")
        .select("id")
        .eq("workspace_id", workspaceId)
        .limit(1)
        .single();

      const orgId = firstOrg?.id;
      if (!orgId) continue;

      const { error } = await supabase.from("mailorder_orders").insert({
        workspace_id: workspaceId,
        org_id: orgId,
        source: "clandestine_discogs",
        external_order_id: fullOrder.id,
        order_number: fullOrder.id,
        customer_name: shippingAddress.name,
        customer_email: null, // Discogs does not expose buyer email
        financial_status: "paid",
        fulfillment_status: "unfulfilled",
        platform_fulfillment_status: "pending",
        subtotal,
        shipping_amount: shippingAmount,
        total_price: totalPrice,
        currency: fullOrder.total.currency,
        line_items: fullOrder.items.map((item) => ({
          discogs_listing_id: item.id,
          release_id: item.release.id,
          description: item.release.description,
          price: item.price.value,
          quantity: 1,
          condition: item.media_condition,
        })),
        shipping_address: shippingAddress,
        // INVARIANT: client_payout_amount = subtotal * 0.5 (NOT total_price)
        client_payout_amount: subtotal * 0.5,
        client_payout_status: "pending",
        metadata: {
          platform_order_id: fullOrder.id,
          discogs_buyer_username: fullOrder.buyer.username,
          discogs_buyer_id: fullOrder.buyer.id,
        },
        synced_at: new Date().toISOString(),
      });

      if (error) {
        logger.error("Insert failed for order", {
          task: "discogs-mailorder-sync",
          orderId: fullOrder.id,
          error: String(error),
        });
      } else {
        imported++;
      }
    }
  }

  return { imported, skipped, total };
}

export const discogsMailorderSyncTask = task({
  id: "discogs-mailorder-sync",
  maxDuration: 300,
  run: async () => runSync(),
});

export const discogsMailorderSyncSchedule = schedules.task({
  id: "discogs-mailorder-sync-schedule",
  cron: "*/10 * * * *", // every 10 minutes
  maxDuration: 300,
  run: async () => runSync(),
});

// ── Address parsing ───────────────────────────────────────────────────────────

/**
 * Parse a Discogs multi-line shipping address string:
 * "John Doe\n123 Main Street\nApt 4B\nBrooklyn, NY 11201\nUnited States"
 */
function parseDiscogsAddress(addressString: string): Record<string, string> {
  const lines = addressString
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { name: "", street1: "", city: "", state: "", zip: "", country: "" };
  }

  const name = lines[0] ?? "";
  const street1 = lines[1] ?? "";
  const hasStreet2 = lines.length > 4;
  const street2 = hasStreet2 ? lines[2] : undefined;

  const cityStateLine = hasStreet2 ? (lines[3] ?? "") : (lines[2] ?? "");
  const cityStateMatch = cityStateLine.match(/^(.+),\s*(\w{2})\s*(\d{5}(?:-\d{4})?)$/);

  const city = cityStateMatch?.[1] ?? cityStateLine;
  const state = cityStateMatch?.[2] ?? "";
  const zip = cityStateMatch?.[3] ?? "";

  const countryLine = lines[lines.length - 1] ?? "";
  const country = countryLine.toLowerCase().includes("united states") ? "US" : countryLine;

  return {
    name,
    street1,
    ...(street2 ? { street2 } : {}),
    city,
    state,
    zip,
    country,
  };
}
