/**
 * Bandcamp sales backfill — cron-driven, resumable in yearly chunks.
 *
 * Pulls all-time sales history from the Sales Report API (v4) and stores
 * in bandcamp_sales. The cron schedule processes one chunk per connection
 * per run, cycling through all connections until all are complete.
 *
 * NOTE: API-triggered tasks (.trigger()) never start on this Trigger.dev
 * project — they stay QUEUED and expire. Only cron-scheduled tasks work.
 * So the backfill runs as a cron (every 10 min) instead of self-triggering.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import {
  fetchSalesReport,
  generateSalesReport,
  refreshBandcampToken,
  type SalesReportItem,
} from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { crossReferenceAlbumUrls } from "@/trigger/lib/bandcamp-url-crossref";

async function pollForReport(
  token: string,
  accessToken: string,
  maxAttempts = 60,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await fetchSalesReport(token, accessToken);
    if (result.ready) return result.url;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Sales report generation timed out");
}

function safeBigint(val: unknown): number | null {
  if (val == null) return null;
  const s = String(val);
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  return null;
}

async function insertSalesRows(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  connectionId: string,
  items: SalesReportItem[],
): Promise<number> {
  // Filter out items with non-numeric transaction IDs (payouts, transfers have "t" prefix)
  const validItems = items.filter((item) => {
    return (
      safeBigint(item.bandcamp_transaction_id) !== null &&
      safeBigint(item.bandcamp_transaction_item_id) !== null
    );
  });

  let inserted = 0;
  const batchSize = 100;

  for (let i = 0; i < validItems.length; i += batchSize) {
    const batch = validItems.slice(i, i + batchSize);
    const rows = batch.map((item) => ({
      workspace_id: workspaceId,
      connection_id: connectionId,
      bandcamp_transaction_id: safeBigint(item.bandcamp_transaction_id),
      bandcamp_transaction_item_id: safeBigint(item.bandcamp_transaction_item_id),
      bandcamp_related_transaction_id: safeBigint(item.bandcamp_related_transaction_id),
      sale_date: new Date(item.date).toISOString(),
      item_type: item.item_type ?? null,
      item_name: item.item_name ?? null,
      artist: item.artist ?? null,
      album_title: null,
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
      tax: null,
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
      buyer_phone: item.buyer_phone ?? null,
      buyer_note: item.buyer_note ?? null,
      ship_to_name: item.ship_to_name ?? null,
      ship_to_street: item.ship_to_street ?? null,
      ship_to_street_2: item.ship_to_street_2 ?? null,
      ship_to_city: item.ship_to_city ?? null,
      ship_to_state: item.ship_to_state ?? null,
      ship_to_zip: item.ship_to_zip ?? null,
      ship_to_country: item.ship_to_country ?? null,
      ship_to_country_code: item.ship_to_country_code ?? null,
      ship_date: item.ship_date ? new Date(item.ship_date).toISOString() : null,
      ship_notes: item.ship_notes ?? null,
      ship_from_country_name: item.ship_from_country_name ?? null,
      paid_to: item.paid_to ?? null,
      payment_state: item.payment_state ?? null,
      referer: item.referer ?? null,
      referer_url: item.referer_url ?? null,
      country: item.country ?? null,
      country_code: item.country_code ?? null,
      region_or_state: item.region_or_state ?? null,
      city: item.city ?? null,
      paypal_transaction_id: item.paypal_transaction_id ?? null,
    }));

    const { error } = await supabase.from("bandcamp_sales").upsert(rows, {
      onConflict: "workspace_id,bandcamp_transaction_id,bandcamp_transaction_item_id",
      ignoreDuplicates: true,
    });

    if (!error) inserted += batch.length;
  }

  return inserted;
}

export const bandcampSalesBackfillTask = task({
  id: "bandcamp-sales-backfill",
  maxDuration: 300,
  run: async (payload: { connectionId: string }) => {
    const supabase = createServiceRoleClient();
    const { connectionId } = payload;

    const { data: conn } = await supabase
      .from("bandcamp_connections")
      .select("band_id, band_name, workspace_id")
      .eq("id", connectionId)
      .single();

    if (!conn) throw new Error(`Connection ${connectionId} not found`);
    const workspaceId = conn.workspace_id;

    // Read existing state, then insert or update (never upsert -- upsert resets unspecified columns to defaults)
    const { data: existingState } = await supabase
      .from("bandcamp_sales_backfill_state")
      .select("status, total_transactions, last_processed_date")
      .eq("connection_id", connectionId)
      .single();

    if (!existingState) {
      await supabase.from("bandcamp_sales_backfill_state").insert({
        connection_id: connectionId,
        workspace_id: workspaceId,
        status: "running",
        total_transactions: 0,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } else {
      await supabase
        .from("bandcamp_sales_backfill_state")
        .update({
          status: "running",
          updated_at: new Date().toISOString(),
        })
        .eq("connection_id", connectionId);
    }

    const state = existingState ?? { last_processed_date: null, total_transactions: 0 };

    const chunkStart = state?.last_processed_date
      ? new Date(state.last_processed_date)
      : new Date("2010-01-01");
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setFullYear(chunkEnd.getFullYear() + 1);
    const now = new Date();

    if (chunkStart >= now) {
      await supabase
        .from("bandcamp_sales_backfill_state")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("connection_id", connectionId);
      return { status: "completed", connectionId };
    }

    const effectiveEnd = chunkEnd > now ? now : chunkEnd;

    try {
      const accessToken = await refreshBandcampToken(workspaceId);

      const reportToken = await generateSalesReport(
        conn.band_id,
        accessToken,
        chunkStart.toISOString().slice(0, 10),
        effectiveEnd.toISOString().slice(0, 10),
      );

      const reportUrl = await pollForReport(reportToken, accessToken);

      // Download the report
      const reportResponse = await fetch(reportUrl);
      if (!reportResponse.ok) throw new Error(`Report download failed: ${reportResponse.status}`);
      const reportData = await reportResponse.json();
      const items: SalesReportItem[] = Array.isArray(reportData)
        ? reportData
        : (reportData.report ?? []);

      const inserted = await insertSalesRows(supabase, workspaceId, connectionId, items);

      // Backfill catalog_number, upc, and item_url to mappings where we find matching SKUs
      for (const item of items) {
        if (item.sku && (item.catalog_number || item.upc || item.item_url)) {
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
            .eq("workspace_id", workspaceId)
            .is("bandcamp_catalog_number", null)
            .eq("bandcamp_item_id", 0)
            .then(
              () => {},
              (err) =>
                logger.warn("Mapping enrichment failed (broad match)", {
                  error: String(err),
                  task: "bandcamp-sales-backfill",
                  sku: item.sku,
                }),
            );

          // Match by joining through variant SKU
          const { data: variants } = await supabase
            .from("warehouse_product_variants")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("sku", item.sku)
            .limit(1);

          if (variants?.length) {
            await supabase
              .from("bandcamp_product_mappings")
              .update(updateData)
              .eq("variant_id", variants[0].id)
              .then(
                () => {},
                (err) =>
                  logger.warn("Mapping enrichment failed (variant match)", {
                    error: String(err),
                    task: "bandcamp-sales-backfill",
                    sku: item.sku,
                    variantId: variants[0].id,
                  }),
              );
          }
        }
      }

      // Cross-reference album URLs from digital sales to physical merch mappings
      const urlsMatched = await crossReferenceAlbumUrls(supabase, workspaceId);
      if (urlsMatched > 0) {
        logger.info("Cross-referenced album URLs", {
          task: "bandcamp-sales-backfill",
          urlsMatched,
        });
      }

      // Update state
      const prevTotal = state?.total_transactions ?? 0;
      await supabase
        .from("bandcamp_sales_backfill_state")
        .update({
          last_processed_date: effectiveEnd.toISOString(),
          total_transactions: prevTotal + inserted,
          earliest_sale_date:
            items.length > 0 ? new Date(items[items.length - 1].date).toISOString() : undefined,
          latest_sale_date: items.length > 0 ? new Date(items[0].date).toISOString() : undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("connection_id", connectionId);

      // Mark completed if we've reached the present
      if (effectiveEnd >= now) {
        await supabase
          .from("bandcamp_sales_backfill_state")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("connection_id", connectionId);
      }

      return {
        status: "chunk_done",
        chunkStart: chunkStart.toISOString(),
        chunkEnd: effectiveEnd.toISOString(),
        inserted,
        band: conn.band_name,
      };
    } catch (error) {
      await supabase
        .from("bandcamp_sales_backfill_state")
        .update({
          status: "failed",
          last_error: String(error).slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("connection_id", connectionId);
      throw error;
    }
  },
});

/**
 * Cron schedule: process backfill chunks every 10 minutes.
 * Iterates ALL non-completed connections per run (up to a time limit),
 * running one yearly chunk per connection via triggerAndWait.
 */
export const bandcampSalesBackfillCron = schedules.task({
  id: "bandcamp-sales-backfill-cron",
  cron: "*/10 * * * *",
  maxDuration: 300,
  run: async () => {
    const supabase = createServiceRoleClient();

    // Check pause flag — skip if manual backfill script is running
    const { data: ws } = await supabase
      .from("workspaces")
      .select("bandcamp_scraper_settings")
      .limit(1)
      .single();
    if ((ws?.bandcamp_scraper_settings as Record<string, unknown>)?.pause_sales_backfill_cron) {
      logger.info("Backfill cron: PAUSED (pause_sales_backfill_cron flag set)");
      return { processed: 0, status: "paused" };
    }

    const workspaceIds = await getAllWorkspaceIds(supabase);
    let processed = 0;
    const startTime = Date.now();
    const MAX_CRON_RUNTIME_MS = 240_000;

    for (const workspaceId of workspaceIds) {
      if (Date.now() - startTime > MAX_CRON_RUNTIME_MS) {
        logger.info("Backfill cron: time limit reached, will continue next run", { processed });
        break;
      }

      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, band_name")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      for (const conn of connections ?? []) {
        if (Date.now() - startTime > MAX_CRON_RUNTIME_MS) {
          logger.info("Backfill cron: time limit reached, will continue next run", { processed });
          break;
        }

        const { data: bfState } = await supabase
          .from("bandcamp_sales_backfill_state")
          .select("status")
          .eq("connection_id", conn.id)
          .single();

        if (bfState?.status === "completed") continue;

        try {
          logger.info("Backfill cron: processing chunk", {
            band: conn.band_name,
            connectionId: conn.id,
          });
          const result = await bandcampSalesBackfillTask.triggerAndWait({ connectionId: conn.id });
          logger.info("Backfill cron: chunk done", { band: conn.band_name, result });
          processed++;
        } catch (err) {
          logger.error("Backfill cron: chunk failed", { band: conn.band_name, error: String(err) });
        }
      }
    }

    if (processed === 0) {
      logger.info("Backfill cron: all connections completed or no connections found");
    }

    return { processed, status: "all_done" };
  },
});
