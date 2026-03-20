/**
 * Bandcamp order sync — poll get_orders and create warehouse_orders.
 *
 * Rule #9: Uses bandcampQueue.
 * Rule #48: API calls in Trigger tasks.
 *
 * Creates warehouse_orders with bandcamp_payment_id so shipments can be linked.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export const bandcampOrderSyncTask = task({
  id: "bandcamp-order-sync",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = payload.workspaceId
      ? [payload.workspaceId]
      : await getAllWorkspaceIds(supabase);

    let totalCreated = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, org_id, band_id")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections?.length) continue;

      const accessToken = await refreshBandcampToken(workspaceId);

      for (const conn of connections) {
        try {
          const endTime = new Date();
          const startTime = new Date(endTime);
          startTime.setDate(startTime.getDate() - 30);

          const items = await getOrders(
            {
              bandId: conn.band_id,
              startTime: startTime.toISOString().replace("T", " ").slice(0, 19),
              endTime: endTime.toISOString().replace("T", " ").slice(0, 19),
            },
            accessToken,
          );

          // Group by payment_id (one order per payment)
          const byPayment = new Map<number, typeof items>();
          for (const item of items) {
            const list = byPayment.get(item.payment_id) ?? [];
            list.push(item);
            byPayment.set(item.payment_id, list);
          }

          for (const [paymentId, orderItems] of Array.from(byPayment.entries())) {
            const first = orderItems[0]!;
            const { data: existing } = await supabase
              .from("warehouse_orders")
              .select("id")
              .eq("workspace_id", workspaceId)
              .eq("bandcamp_payment_id", paymentId)
              .maybeSingle();

            if (existing) continue;

            const lineItems = orderItems.map((i: BandcampOrderItem) => ({
              sku: i.sku,
              title: i.item_name,
              quantity: i.quantity ?? 1,
              price: i.sub_total,
            }));

            const { error } = await supabase.from("warehouse_orders").insert({
              workspace_id: workspaceId,
              org_id: conn.org_id,
              bandcamp_payment_id: paymentId,
              order_number: `BC-${paymentId}`,
              customer_name: first.buyer_name,
              customer_email: first.buyer_email,
              financial_status: "paid",
              fulfillment_status: first.ship_date ? "fulfilled" : "unfulfilled",
              total_price: first.order_total ?? 0,
              currency: first.currency ?? "USD",
              line_items: lineItems,
              shipping_address: first.ship_to_name
                ? {
                    name: first.ship_to_name,
                    street1: first.ship_to_street,
                    street2: first.ship_to_street_2,
                    city: first.ship_to_city,
                    state: first.ship_to_state,
                    postalCode: first.ship_to_zip,
                    country: first.ship_to_country,
                    countryCode: first.ship_to_country_code,
                  }
                : null,
              source: "bandcamp",
              synced_at: new Date().toISOString(),
            });

            if (error) {
              logger.warn("Bandcamp order insert failed", {
                paymentId,
                error: error.message,
              });
              continue;
            }

            totalCreated++;
          }
        } catch (err) {
          logger.error("Bandcamp order sync failed", {
            connectionId: conn?.id,
            bandId: conn?.band_id,
            error: String(err),
          });
        }
      }
    }

    return { totalCreated };
  },
});

export const bandcampOrderSyncSchedule = schedules.task({
  id: "bandcamp-order-sync-cron",
  cron: "0 */6 * * *", // Every 6 hours
  queue: bandcampQueue,
  run: async () => {
    await bandcampOrderSyncTask.trigger({});
    return { ok: true };
  },
});
