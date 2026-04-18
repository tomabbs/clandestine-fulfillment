/**
 * Bandcamp sales backfill — self-healing cron monitor.
 *
 * The cron runs every 10 minutes and:
 *   1. Checks if the manual script is running (pause flag) and skips if so.
 *   2. Detects stale "running" connections (>2 hours no new log) and flips to "partial".
 *   3. For "partial" connections, retries up to 3 failed chunks per run using
 *      the sync sales_report API (same code path as the manual script).
 *   4. Does NOT do full scans (Mode A) — only targeted gap retries.
 *
 * The on-demand task is DEPRECATED. It is kept exported for the Trigger.dev
 * registry but should not be triggered. All full backfill work goes through
 * scripts/run-sales-backfill.mjs.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import { refreshBandcampToken, type SalesReportItem, salesReport } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

// Keep in sync with safeBigint in scripts/run-sales-backfill.mjs
function safeBigint(val: unknown): number | null {
  if (val == null) return null;
  const s = String(val);
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  return null;
}

// Keep in sync with insertRows in scripts/run-sales-backfill.mjs
async function insertSalesRows(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  connectionId: string,
  items: SalesReportItem[],
): Promise<number> {
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

/**
 * DEPRECATED on-demand task. Kept for registry compatibility.
 * All backfill work now goes through scripts/run-sales-backfill.mjs.
 *
 * Rule #9: pinned to bandcampQueue for defense-in-depth even though the body
 * no longer hits the OAuth API — guards against accidental future revival.
 */
export const bandcampSalesBackfillTask = task({
  id: "bandcamp-sales-backfill",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async (payload: { connectionId: string }) => {
    logger.warn(
      "bandcamp-sales-backfill task is DEPRECATED. Use scripts/run-sales-backfill.mjs instead.",
      {
        connectionId: payload.connectionId,
      },
    );
    return { status: "deprecated", message: "Use scripts/run-sales-backfill.mjs" };
  },
});

/**
 * Self-healing cron: retries failed chunks and detects stale connections.
 *
 * Rule #9 (CLAUDE.md): MUST share the bandcampQueue (concurrencyLimit: 1) with
 * every other Bandcamp OAuth task to serialize all `refreshBandcampToken()`
 * calls. Without this, two concurrent token refreshes can return distinct
 * access_tokens, the older one is invalidated by the next refresh, and
 * subsequent calls receive `duplicate_grant` — which destroys the OAuth token
 * family and requires manual re-auth in the Bandcamp dashboard.
 */
export const bandcampSalesBackfillCron = schedules.task({
  id: "bandcamp-sales-backfill-cron",
  cron: "*/10 * * * *",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async () => {
    const supabase = createServiceRoleClient();

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
    let chunksRetried = 0;
    let staleFixed = 0;
    const startTime = Date.now();
    const MAX_RUNTIME_MS = 240_000;
    const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

    for (const workspaceId of workspaceIds) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) break;

      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, band_id, band_name")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      for (const conn of connections ?? []) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) break;

        const { data: bfState } = await supabase
          .from("bandcamp_sales_backfill_state")
          .select("status, updated_at")
          .eq("connection_id", conn.id)
          .single();

        if (bfState?.status === "completed" || bfState?.status === "pending") continue;

        // Detect stale "running" — no updates for >2 hours
        if (bfState?.status === "running" && bfState.updated_at) {
          const lastUpdate = new Date(bfState.updated_at).getTime();
          if (Date.now() - lastUpdate > STALE_THRESHOLD_MS) {
            logger.warn("Backfill cron: stale running connection, flipping to partial", {
              band: conn.band_name,
              lastUpdate: bfState.updated_at,
            });
            await supabase
              .from("bandcamp_sales_backfill_state")
              .update({
                status: "partial",
                last_error: "Stale running detected by cron",
                updated_at: new Date().toISOString(),
              })
              .eq("connection_id", conn.id);
            staleFixed++;
            continue;
          }
          continue;
        }

        // For partial/failed: retry up to 3 failed chunks
        if (bfState?.status === "partial" || bfState?.status === "failed") {
          const { data: failedChunks } = await supabase
            .from("bandcamp_sales_backfill_log")
            .select("chunk_start, chunk_end, attempt_number")
            .eq("connection_id", conn.id)
            .eq("status", "failed")
            .order("chunk_start")
            .limit(3);

          if (!failedChunks?.length) continue;

          logger.info("Backfill cron: retrying failed chunks", {
            band: conn.band_name,
            chunks: failedChunks.length,
          });

          try {
            const accessToken = await refreshBandcampToken(workspaceId);

            for (const fc of failedChunks) {
              if (Date.now() - startTime > MAX_RUNTIME_MS) break;

              const chunkStartedAt = new Date();
              const startStr = fc.chunk_start;
              const endStr = fc.chunk_end;

              try {
                const items = await salesReport(conn.band_id, accessToken, startStr, endStr);
                const inserted = await insertSalesRows(supabase, workspaceId, conn.id, items);

                await supabase.from("bandcamp_sales_backfill_log").insert({
                  workspace_id: workspaceId,
                  connection_id: conn.id,
                  chunk_start: startStr,
                  chunk_end: endStr,
                  status: "success",
                  sales_returned: items.length,
                  sales_inserted: inserted,
                  http_status: 200,
                  attempt_number: (fc.attempt_number ?? 0) + 1,
                  started_at: chunkStartedAt.toISOString(),
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - chunkStartedAt.getTime(),
                });

                chunksRetried++;
                logger.info("Backfill cron: chunk retry succeeded", {
                  band: conn.band_name,
                  chunk: startStr,
                  inserted,
                });
              } catch (err) {
                await supabase.from("bandcamp_sales_backfill_log").insert({
                  workspace_id: workspaceId,
                  connection_id: conn.id,
                  chunk_start: startStr,
                  chunk_end: endStr,
                  status: "failed",
                  sales_returned: 0,
                  sales_inserted: 0,
                  error_message: String(err).slice(0, 500),
                  attempt_number: (fc.attempt_number ?? 0) + 1,
                  started_at: chunkStartedAt.toISOString(),
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - chunkStartedAt.getTime(),
                });

                logger.warn("Backfill cron: chunk retry failed", {
                  band: conn.band_name,
                  chunk: startStr,
                  error: String(err).slice(0, 200),
                });
              }

              await new Promise((r) => setTimeout(r, 3000));
            }
          } catch (err) {
            logger.error("Backfill cron: token refresh failed", {
              band: conn.band_name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    logger.info("Backfill cron: run complete", { chunksRetried, staleFixed });
    return { chunksRetried, staleFixed, status: "done" };
  },
});
