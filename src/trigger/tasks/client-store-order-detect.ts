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

import { schedules, tasks } from "@trigger.dev/sdk";
import { createStoreSyncClient } from "@/lib/clients/store-sync-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { shouldFanoutToConnection } from "@/lib/server/client-store-fanout-gate";
import {
  type IngressSensorWarning,
  runHoldIngressSafely,
  type SafeIngressVerdict,
} from "@/lib/server/order-hold-ingress";
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
    let holdsApplied = 0;
    let alertsEnqueued = 0;
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

        // Phase 0.8 — single dormancy gate. Order polling counts as fanout
        // because the stored order will trigger downstream pushes back to the
        // client store. Drop polling on dormant connections at the source.
        const fanoutDecision = shouldFanoutToConnection(connection);
        if (!fanoutDecision.allow) {
          console.log(
            `[client-store-order-detect] skip ${connection.platform} ${connection.id} (reason=${fanoutDecision.reason})`,
          );
          continue;
        }

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

              // Phase 8 (SKU-AUTO-3 + SKU-AUTO-21) — consult the shared
              // hold substrate. `runHoldIngressSafely` is the SAME
              // function `process-client-store-webhook.handleOrderCreated`
              // calls on the SAME (workspaceId, orderId) tuple. Because
              // both ingress paths call the same helper with the same
              // loader / evaluator / RPC wrapper against the same DB
              // state, the resulting `HoldDecision` is identical BY
              // CONSTRUCTION — that is SKU-AUTO-3's parity guarantee.
              //
              // Fail-open policy: every terminal failure kind returns
              // `verdict:"legacy"` and a structured warning, which we
              // persist as a `sensor_readings` row so the rollout page
              // surfaces hold-ingress failure rates.
              //
              // Unlike the webhook path, the poll path does NOT decrement
              // inventory on its own (the webhook is the canonical
              // decrement path; poll exists as a backfill for missed
              // webhooks). So the only Phase 8 side-effect here is:
              //   1. persist sensor warnings on failure,
              //   2. enqueue `send-non-warehouse-order-hold-alert` when
              //      a hold was applied AND the evaluator says the
              //      client should know. The alert task owns ALL
              //      policy (emergency pause / flags / idempotency /
              //      bulk suppression), so this enqueue is unconditional.
              const holdIngress = await runHoldIngressSafely(supabase, {
                workspaceId,
                orderId: newOrder.id,
                source: "poll",
                platform: connection.platform,
              });
              await persistIngressWarnings(supabase, workspaceId, holdIngress.warnings);
              const holdVerdict: SafeIngressVerdict = holdIngress.verdict;

              if (holdVerdict.kind === "hold_applied") {
                holdsApplied++;
                if (holdVerdict.clientAlertRequired) {
                  try {
                    await tasks.trigger("send-non-warehouse-order-hold-alert", {
                      orderId: newOrder.id,
                      holdCycleId: holdVerdict.cycleId,
                    });
                    alertsEnqueued++;
                  } catch (alertErr) {
                    const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
                    console.error(
                      `[client-store-order-detect] send-non-warehouse-order-hold-alert enqueue failed for order ${newOrder.id}:`,
                      msg,
                    );
                    await supabase.from("sensor_readings").insert({
                      workspace_id: workspaceId,
                      sensor_name: "hold_ingress.alert_enqueue_failed",
                      status: "warning",
                      message: `send-non-warehouse-order-hold-alert enqueue failed for order ${newOrder.id}: ${msg.slice(0, 200)}`,
                      value: {
                        order_id: newOrder.id,
                        hold_cycle_id: holdVerdict.cycleId,
                        platform: connection.platform,
                        source: "poll",
                        error: msg,
                      },
                    });
                  }
                }
              }
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

    return { ordersCreated, echoesCancelled, holdsApplied, alertsEnqueued, errors };
  },
});

/**
 * Best-effort persistence of `runHoldIngressSafely` sensor warnings.
 * Mirrors the helper in `process-client-store-webhook.ts` so the poll
 * path emits identical `sensor_readings` shape as the webhook path —
 * SKU-AUTO-3 parity for forensics.
 *
 * Swallowed errors: the rollout-page observability query is non-load-
 * bearing, so a sensor insert failure must NOT fail the poll run.
 * A failed sensor insert is logged to the task's stdout for debugging.
 */
async function persistIngressWarnings(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  warnings: ReadonlyArray<IngressSensorWarning>,
): Promise<void> {
  if (warnings.length === 0) return;
  try {
    await supabase.from("sensor_readings").insert(
      warnings.map((w) => ({
        workspace_id: workspaceId,
        sensor_name: w.sensor_name,
        status: w.status,
        message: w.message,
        value: w.value,
      })),
    );
  } catch (err) {
    console.error(
      "[client-store-order-detect] sensor_readings insert (hold ingress) failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
