/**
 * Bandcamp tag backfill — on-demand, resumable.
 *
 * Fetches album HTML pages for all mappings with a URL but no tags,
 * extracts genre tags from <a class="tag"> elements, and writes them
 * to bandcamp_product_mappings.
 *
 * Uses bandcamp-scrape queue (concurrency 5) to share rate limiting
 * with normal scrape tasks.
 */

import { logger, task } from "@trigger.dev/sdk";
import { fetchBandcampPage, parseBandcampPage } from "@/lib/clients/bandcamp-scraper";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { matchTagToTaxonomy } from "@/lib/shared/genre-taxonomy";
import { bandcampScrapeQueue } from "@/trigger/lib/bandcamp-scrape-queue";

const BATCH_SIZE = 50;
const DELAY_MS = 500;

export const bandcampTagBackfillTask = task({
  id: "bandcamp-tag-backfill",
  queue: bandcampScrapeQueue,
  maxDuration: 300,
  run: async (payload?: { cursor?: string }) => {
    const supabase = createServiceRoleClient();
    let processed = 0;
    let failed = 0;
    let cursor = payload?.cursor ?? null;
    const startTime = Date.now();
    const MAX_RUNTIME_MS = 240_000;

    while (Date.now() - startTime < MAX_RUNTIME_MS) {
      let query = supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url, bandcamp_tags")
        .not("bandcamp_url", "is", null)
        .is("bandcamp_tags", null)
        .in("scrape_status", ["active", "probation"])
        .not("product_category", "in", '("apparel","merch")')
        .order("id", { ascending: true })
        .limit(BATCH_SIZE);

      if (cursor) {
        query = query.gt("id", cursor);
      }

      const { data: batch, error: queryError } = await query;
      if (queryError) {
        logger.error("Backfill query failed", { error: queryError.message });
        break;
      }
      if (!batch?.length) {
        logger.info("Tag backfill complete — no more items to process", { processed, failed });
        break;
      }

      for (const mapping of batch) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) break;

        try {
          const html = await fetchBandcampPage(mapping.bandcamp_url);
          const scraped = parseBandcampPage(html);

          if (scraped && scraped.tags.length > 0) {
            const { bcGenre } = matchTagToTaxonomy(scraped.tagNorms);

            await supabase
              .from("bandcamp_product_mappings")
              .update({
                bandcamp_tags: scraped.tags,
                bandcamp_tag_norms: scraped.tagNorms,
                bandcamp_primary_genre: bcGenre,
                bandcamp_tralbum_id: scraped.tralbumId,
                bandcamp_tags_fetched_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", mapping.id);

            processed++;
          } else if (scraped) {
            await supabase
              .from("bandcamp_product_mappings")
              .update({
                bandcamp_tags: [],
                bandcamp_tag_norms: [],
                bandcamp_tralbum_id: scraped.tralbumId,
                bandcamp_tags_fetched_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", mapping.id);
            processed++;
          } else {
            failed++;
          }
        } catch (err) {
          failed++;
          logger.warn("Tag fetch failed for mapping", {
            mappingId: mapping.id,
            url: mapping.bandcamp_url,
            error: String(err),
          });
        }

        cursor = mapping.id;
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }

      // Log progress
      logger.info("Tag backfill progress", { processed, failed, cursor });

      await supabase.from("channel_sync_log").insert({
        workspace_id: "1e59b9ca-ab4e-442b-952b-a649e2aadb0e",
        channel: "bandcamp",
        sync_type: "tag_backfill",
        status: "partial",
        items_processed: processed,
        items_failed: failed,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        metadata: { cursor, batchSize: BATCH_SIZE },
      });
    }

    return { processed, failed, cursor, completed: !cursor };
  },
});
