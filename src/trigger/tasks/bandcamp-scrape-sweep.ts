/**
 * Bandcamp scrape sweep — cron every 10 minutes on dedicated bandcamp-sweep queue.
 *
 * Enrichment only: scrapes album pages for about, credits, tracks, and package photos.
 * URLs come from the Bandcamp API (stored on mappings during bandcamp-sync).
 *
 * Group 1: has URL, missing type_name (initial scrape needed)
 * Group 3: has URL + art, missing about/credits/tracks (enrichment backfill)
 *
 * Group 2 (URL construction) removed — API provides URLs directly.
 */

import { logger, schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampSweepQueue } from "@/trigger/lib/bandcamp-sweep-queue";
import { bandcampScrapePageTask } from "@/trigger/tasks/bandcamp-sync";

export const bandcampScrapeSweepTask = schedules.task({
  id: "bandcamp-scrape-sweep",
  cron: "*/10 * * * *",
  queue: bandcampSweepQueue,
  maxDuration: 120,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    let totalTriggered = 0;

    for (const workspaceId of workspaceIds) {
      const startedAt = new Date().toISOString();
      let triggered = 0;
      let g1Triggered = 0;
      let g2Triggered = 0;
      let g3Triggered = 0;

      // ── Group 1: has URL, missing type_name (enrichment scrape) ────────────
      const { data: group1 } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_url", "is", null)
        .is("bandcamp_type_name", null)
        .or("scrape_failure_count.is.null,scrape_failure_count.lt.5")
        .limit(100);

      for (const pm of group1 ?? []) {
        await bandcampScrapePageTask.trigger({
          url: pm.bandcamp_url as string,
          mappingId: pm.id,
          workspaceId,
          urlIsConstructed: false,
          urlSource: "orders_api",
        });
        triggered++;
        g1Triggered++;
      }

      // Group 2 removed — URLs now come from the Bandcamp API, not construction.

      // ── Group 3: has URL + art but missing about/credits/tracks (enrichment) ──
      const { data: group3 } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_url", "is", null)
        .is("bandcamp_about", null)
        .not("bandcamp_art_url", "is", null)
        .or("scrape_failure_count.is.null,scrape_failure_count.lt.5")
        .limit(100);

      for (const pm of group3 ?? []) {
        await bandcampScrapePageTask.trigger({
          url: pm.bandcamp_url as string,
          mappingId: pm.id,
          workspaceId,
          urlIsConstructed: false,
          urlSource: "orders_api",
        });
        triggered++;
        g3Triggered++;
      }

      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "bandcamp",
        sync_type: "scrape_sweep",
        status: "completed",
        items_processed: triggered,
        items_failed: 0,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        metadata: {
          source: "bandcamp_scrape_sweep_cron",
          limits: { per_group: 100 },
          scrape_queue_concurrency: 5,
          scrape_task_max_duration_sec: 60,
          g1: { selected: group1?.length ?? 0, triggered: g1Triggered },
          g3: { selected: group3?.length ?? 0, triggered: g3Triggered },
        },
      });

      logger.info("bandcamp-scrape-sweep complete", {
        workspaceId,
        triggered,
        group1Count: group1?.length ?? 0,
        group3Count: group3?.length ?? 0,
      });

      totalTriggered += triggered;
    }

    return { totalTriggered };
  },
});
