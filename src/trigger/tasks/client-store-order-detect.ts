/**
 * Client store order detect — cron every 10 minutes.
 *
 * Polls each active client_store_connection for new orders.
 * Rule #65: Echo cancellation — if order quantities match last_pushed_quantity, it's our own push echoing.
 *
 * NOTE: Discogs connections are intentionally skipped here.
 * They are handled by discogs-client-order-sync, which:
 *   - Uses OAuth 1.0a auth with Redis-backed rate limiting
 *   - Does not apply echo detection (we don't push inventory to client Discogs)
 *   - Runs on its own 10-minute cron schedule
 */

import { schedules } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { clientStoreOrderQueue } from "@/trigger/lib/client-store-order-queue";

export function isEchoOrder(
  lineItems: Array<{ sku: string; quantity: number }>,
  lastPushedQuantities: Map<string, number>,
): boolean {
  if (lineItems.length === 0) return false;
  return lineItems.every((item) => {
    const lastPushed = lastPushedQuantities.get(item.sku);
    return lastPushed !== undefined && item.quantity === lastPushed;
  });
}

export const clientStoreOrderDetectTask = schedules.task({
  id: "client-store-order-detect",
  cron: "*/10 * * * *",
  maxDuration: 180,
  queue: clientStoreOrderQueue,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    let ordersCreated = 0;
    let echoesCancelled = 0;
    let errors = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("client_store_connections")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("connection_status", "active");

      if (!connections || connections.length === 0) continue;

      for (const connection of connections as ClientStoreConnection[]) {
        // Discogs handled by discogs-client-order-sync (OAuth 1.0a + Redis rate limiter)
        if (connection.platform === "discogs") continue;

        try {
          const since =
            connection.last_poll_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const client = createStoreSyncClient(connection);
          const remoteOrders = await client.getOrders(since);

          // Get last_pushed_quantity for echo detection (Rule #65)
          const { data: skuMappings } = await supabase
            .from("client_store_sku_mappings")
            .select("remote_sku, last_pushed_quantity")
            .eq("connection_id", connection.id);

          const lastPushedMap = new Map(
            (skuMappings ?? [])
              .filter((m) => m.remote_sku && m.last_pushed_quantity !== null)
              .map((m) => [m.remote_sku as string, m.last_pushed_quantity as number]),
          );

          for (const order of remoteOrders) {
            // Check for duplicate
            const { data: existing } = await supabase
              .from("warehouse_orders")
              .select("id")
              .eq("workspace_id", workspaceId)
              .eq("external_order_id", order.remoteOrderId)
              .eq("source", connection.platform)
              .single();

            if (existing) continue;

            // Rule #65: Echo cancellation
            if (isEchoOrder(order.lineItems, lastPushedMap)) {
              echoesCancelled++;
              continue;
            }

            // Create order + items
            const { data: newOrder } = await supabase
              .from("warehouse_orders")
              .insert({
                workspace_id: workspaceId,
                org_id: connection.org_id,
                external_order_id: order.remoteOrderId,
                order_number: order.orderNumber,
                source: connection.platform,
                line_items: order.lineItems,
                created_at: order.createdAt,
                updated_at: new Date().toISOString(),
              })
              .select("id")
              .single();

            if (newOrder) {
              const orderItems = order.lineItems.map((li) => ({
                order_id: newOrder.id,
                workspace_id: workspaceId,
                sku: li.sku,
                quantity: li.quantity,
                shopify_line_item_id: li.remoteVariantId,
              }));

              if (orderItems.length > 0) {
                await supabase.from("warehouse_order_items").insert(orderItems);
              }

              ordersCreated++;
            }
          }

          // Update last_poll_at
          await supabase
            .from("client_store_connections")
            .update({
              last_poll_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id);
        } catch (error) {
          errors++;
          console.error(
            `[client-store-order-detect] Failed for connection ${connection.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    return { ordersCreated, echoesCancelled, errors };
  },
});
