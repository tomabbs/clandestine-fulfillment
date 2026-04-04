/**
 * Bandcamp daily sales sync — cron 5am UTC.
 *
 * Pulls yesterday's sales via synchronous sales_report (v4) and upserts
 * into bandcamp_sales. Keeps the sales table current after the historical
 * backfill is complete.
 */

import { logger, schedules } from "@trigger.dev/sdk";
import { refreshBandcampToken, salesReport } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { crossReferenceAlbumUrls } from "@/trigger/lib/bandcamp-url-crossref";

export const bandcampSalesSyncSchedule = schedules.task({
  id: "bandcamp-sales-sync",
  cron: "0 5 * * *",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    let totalInserted = 0;

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const startTime = yesterday.toISOString().slice(0, 10) + " 00:00:00";
    const endTime = new Date().toISOString().slice(0, 10) + " 00:00:00";

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, band_id, band_name")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections?.length) continue;

      try {
        const accessToken = await refreshBandcampToken(workspaceId);

        for (const conn of connections) {
          try {
            const items = await salesReport(conn.band_id, accessToken, startTime, endTime);

            if (!items.length) continue;

            const rows = items.map((item) => ({
              workspace_id: workspaceId,
              connection_id: conn.id,
              bandcamp_transaction_id: item.bandcamp_transaction_id,
              bandcamp_transaction_item_id: item.bandcamp_transaction_item_id,
              bandcamp_related_transaction_id: item.bandcamp_related_transaction_id ?? null,
              sale_date: new Date(item.date).toISOString(),
              item_type: item.item_type ?? null,
              item_name: item.item_name ?? null,
              artist: item.artist ?? null,
              package: item.package ?? null,
              option_name: item.option ?? null,
              sku: item.sku ?? null,
              catalog_number: item.catalog_number ?? null,
              upc: item.upc ?? null,
              isrc: item.isrc ?? null,
              item_url: item.item_url ?? null,
              currency: item.currency ?? null,
              item_price: item.item_price ?? null,
              quantity: item.quantity ?? null,
              sub_total: item.sub_total ?? null,
              shipping: item.shipping ?? null,
              seller_tax: item.seller_tax ?? null,
              marketplace_tax: item.marketplace_tax ?? null,
              tax_rate: item.tax_rate ?? null,
              transaction_fee: item.transaction_fee ?? null,
              fee_type: item.fee_type ?? null,
              item_total: item.item_total ?? null,
              amount_received: item.amount_you_received ?? null,
              net_amount: item.net_amount ?? null,
              additional_fan_contribution: item.additional_fan_contribution ?? null,
              discount_code: item.discount_code ?? null,
              collection_society_share: item.collection_society_share ?? null,
              buyer_name: item.buyer_name ?? null,
              buyer_email: item.buyer_email ?? null,
              paid_to: item.paid_to ?? null,
              payment_state: item.payment_state ?? null,
              referer: item.referer ?? null,
              referer_url: item.referer_url ?? null,
              country: item.country ?? null,
              country_code: item.country_code ?? null,
              region_or_state: item.region_or_state ?? null,
              city: item.city ?? null,
            }));

            const { error } = await supabase.from("bandcamp_sales").upsert(rows, {
              onConflict: "workspace_id,bandcamp_transaction_id,bandcamp_transaction_item_id",
              ignoreDuplicates: true,
            });

            if (!error) totalInserted += items.length;

            // Backfill catalog_number/upc/url to mappings
            for (const item of items) {
              if (!item.sku || (!item.catalog_number && !item.upc && !item.item_url)) continue;
              const { data: variants } = await supabase
                .from("warehouse_product_variants")
                .select("id")
                .eq("workspace_id", workspaceId)
                .eq("sku", item.sku)
                .limit(1);
              if (!variants?.length) continue;
              const updateData: Record<string, unknown> = {};
              if (item.catalog_number) updateData.bandcamp_catalog_number = item.catalog_number;
              if (item.upc) updateData.bandcamp_upc = item.upc;
              if (item.item_url) {
                updateData.bandcamp_url = item.item_url;
                updateData.bandcamp_url_source = "orders_api";
              }
              await supabase
                .from("bandcamp_product_mappings")
                .update(updateData)
                .eq("variant_id", variants[0].id)
                .then(
                  () => {},
                  (err) =>
                    logger.warn("Mapping enrichment failed", {
                      error: String(err),
                      task: "bandcamp-sales-sync",
                      sku: item.sku,
                      variantId: variants[0].id,
                    }),
                );
            }
          } catch (err) {
            logger.error("Sales sync error for connection", {
              task: "bandcamp-sales-sync",
              band: conn.band_name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.error("Token refresh failed", {
          task: "bandcamp-sales-sync",
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Cross-reference album URLs from new sales to mappings
    for (const workspaceId of workspaceIds) {
      await crossReferenceAlbumUrls(supabase, workspaceId);
    }

    await supabase.from("channel_sync_log").insert({
      workspace_id: workspaceIds[0] ?? "00000000-0000-0000-0000-000000000000",
      channel: "bandcamp",
      sync_type: "sales_sync",
      status: "completed",
      items_processed: totalInserted,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    return { totalInserted };
  },
});
