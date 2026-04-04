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

            // Derive org_id from the SKUs in this order rather than using conn.org_id
            // (all bandcamp_connections use Clandestine Distribution's org_id, not the
            // individual label's org). Look up the first SKU that resolves to a product org.
            const skus = orderItems.map((i) => i.sku).filter((s): s is string => !!s);
            let resolvedOrgId: string = conn.org_id;
            if (skus.length > 0) {
              const { data: variants } = await supabase
                .from("warehouse_product_variants")
                .select("sku, warehouse_products!inner(org_id)")
                .eq("workspace_id", workspaceId)
                .in("sku", skus)
                .limit(1);
              const firstVariant = variants?.[0];
              if (firstVariant) {
                const product = firstVariant.warehouse_products as unknown as { org_id: string };
                if (product.org_id) resolvedOrgId = product.org_id;
              }
            }

            const { error } = await supabase.from("warehouse_orders").insert({
              workspace_id: workspaceId,
              org_id: resolvedOrgId,
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

          // Batch-backfill bandcamp_product_mappings.bandcamp_url from item_url.
          // Orders API returns verified album URLs — higher confidence than constructed slugs.
          // Covers only recently-sold products (30-day window); URL construction in
          // bandcamp-sync.ts covers the full catalog.
          // Never overwrites existing non-null URLs (confidence guard).
          const skuUrlPairs = items
            .filter((i) => i.item_url && i.sku)
            .map((i) => ({ sku: i.sku as string, url: i.item_url as string }));

          if (skuUrlPairs.length > 0) {
            const { data: variants } = await supabase
              .from("warehouse_product_variants")
              .select("id, sku")
              .eq("workspace_id", workspaceId)
              .in(
                "sku",
                skuUrlPairs.map((p) => p.sku),
              );

            const skuToVariantId = new Map((variants ?? []).map((v) => [v.sku, v.id]));

            for (const { sku, url } of skuUrlPairs) {
              const variantId = skuToVariantId.get(sku);
              if (!variantId) continue;

              await supabase
                .from("bandcamp_product_mappings")
                .update({
                  bandcamp_url: url,
                  bandcamp_url_source: "orders_api",
                  updated_at: new Date().toISOString(),
                })
                .eq("variant_id", variantId)
                .is("bandcamp_url", null);
            }

            logger.info("Backfilled bandcamp_url from order item_urls", {
              workspaceId,
              connectionBandId: conn.band_id,
              skuCount: skuUrlPairs.length,
            });
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
