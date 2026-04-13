/**
 * Scraper reconciliation — cron every 6 hours.
 *
 * Bulk-resolves stale review queue items, probes dead URLs monthly,
 * enforces dead-URL lifecycle transitions, backfills categories,
 * and emits health metrics.
 *
 * Queue: bandcamp-sweep (concurrency 1) — no Bandcamp API contention.
 */

import { logger, schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { classifyProduct } from "@/lib/shared/product-categories";
import { bandcampSweepQueue } from "@/trigger/lib/bandcamp-sweep-queue";
import { bandcampScrapePageTask } from "@/trigger/tasks/bandcamp-sync";

const ACTION_LIMIT = 50;

export const scraperReconcileSchedule = schedules.task({
  id: "scraper-reconcile",
  cron: "0 */6 * * *",
  queue: bandcampSweepQueue,
  maxDuration: 300,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const metrics = {
      resolvedStaleSuccess: 0,
      resolvedCategoryMismatch: 0,
      reattemptTriggered: 0,
      deadEnforced: 0,
      deadProbed: 0,
      categoryBackfilled: 0,
    };

    for (const workspaceId of workspaceIds) {
      // 1. Stale-success cleanup: resolve review items where mapping now succeeds
      const { data: staleSuccess } = await supabase
        .from("warehouse_review_queue")
        .select("id, metadata")
        .eq("category", "bandcamp_scraper")
        .eq("status", "open")
        .limit(ACTION_LIMIT);

      if (staleSuccess && staleSuccess.length > 0) {
        const mappingIds = staleSuccess
          .map((r) => (r.metadata as Record<string, unknown>)?.mappingId as string)
          .filter(Boolean);

        if (mappingIds.length > 0) {
          const { data: successMappings } = await supabase
            .from("bandcamp_product_mappings")
            .select("id, last_synced_at")
            .in("id", mappingIds)
            .eq("scrape_failure_count", 0);

          const successIds = new Set((successMappings ?? []).map((m) => m.id));

          for (const item of staleSuccess) {
            const mappingId = (item.metadata as Record<string, unknown>)?.mappingId as string;
            if (successIds.has(mappingId)) {
              await supabase
                .from("warehouse_review_queue")
                .update({ status: "resolved", resolved_at: new Date().toISOString() })
                .eq("id", item.id);
              metrics.resolvedStaleSuccess++;
            }
          }
        }
      }

      // 2. Category mismatch cleanup: resolve items for apparel/merch
      const { data: merchReview } = await supabase
        .from("warehouse_review_queue")
        .select("id, metadata")
        .eq("category", "bandcamp_scraper")
        .eq("status", "open")
        .limit(ACTION_LIMIT);

      if (merchReview && merchReview.length > 0) {
        const merchMappingIds = merchReview
          .map((r) => (r.metadata as Record<string, unknown>)?.mappingId as string)
          .filter(Boolean);

        if (merchMappingIds.length > 0) {
          const { data: merchMappings } = await supabase
            .from("bandcamp_product_mappings")
            .select("id")
            .in("id", merchMappingIds)
            .in("product_category", ["apparel", "merch"]);

          const merchIds = new Set((merchMappings ?? []).map((m) => m.id));

          for (const item of merchReview) {
            const mappingId = (item.metadata as Record<string, unknown>)?.mappingId as string;
            if (merchIds.has(mappingId)) {
              await supabase
                .from("warehouse_review_queue")
                .update({ status: "resolved", resolved_at: new Date().toISOString() })
                .eq("id", item.id);
              metrics.resolvedCategoryMismatch++;
            }
          }
        }
      }

      // 3. Re-attempt stale review items (open > 24h)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: staleItems } = await supabase
        .from("warehouse_review_queue")
        .select("id, metadata")
        .eq("category", "bandcamp_scraper")
        .eq("status", "open")
        .lt("created_at", oneDayAgo)
        .limit(ACTION_LIMIT);

      if (staleItems && staleItems.length > 0) {
        const staleMappingIds = staleItems
          .map((r) => (r.metadata as Record<string, unknown>)?.mappingId as string)
          .filter(Boolean);

        if (staleMappingIds.length > 0) {
          const { data: staleMappings } = await supabase
            .from("bandcamp_product_mappings")
            .select("id, bandcamp_url, product_category, bandcamp_type_name, scrape_status")
            .in("id", staleMappingIds)
            .in("scrape_status", ["active", "probation"]);

          for (const m of staleMappings ?? []) {
            if (!m.bandcamp_url) continue;
            const cat =
              m.product_category ?? classifyProduct(m.bandcamp_type_name, m.bandcamp_url, null);
            await bandcampScrapePageTask.trigger({
              url: m.bandcamp_url,
              mappingId: m.id,
              workspaceId,
              urlIsConstructed: false,
              urlSource: "manual",
              productCategory: cat,
            });
            metrics.reattemptTriggered++;
          }
        }
      }

      // 4. Dead URL lifecycle enforcement: probation with 10+ failures -> dead
      const { data: overdueProb } = await supabase
        .from("bandcamp_product_mappings")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("scrape_status", "probation")
        .gte("consecutive_failures", 10)
        .limit(ACTION_LIMIT);

      for (const m of overdueProb ?? []) {
        await supabase
          .from("bandcamp_product_mappings")
          .update({ scrape_status: "dead", updated_at: new Date().toISOString() })
          .eq("id", m.id);
        metrics.deadEnforced++;
      }

      // 5. Monthly dead URL probe: pick 20 dead URLs not probed in 30+ days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: deadForProbe } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url, product_category, bandcamp_type_name")
        .eq("workspace_id", workspaceId)
        .eq("scrape_status", "dead")
        .not("bandcamp_url", "is", null)
        .or(`last_scrape_attempt_at.is.null,last_scrape_attempt_at.lt.${thirtyDaysAgo}`)
        .limit(20);

      for (const m of deadForProbe ?? []) {
        if (!m.bandcamp_url) continue;
        const cat =
          m.product_category ?? classifyProduct(m.bandcamp_type_name, m.bandcamp_url, null);
        await bandcampScrapePageTask.trigger({
          url: m.bandcamp_url,
          mappingId: m.id,
          workspaceId,
          urlIsConstructed: false,
          urlSource: "manual",
          productCategory: cat,
          isDeadUrlProbe: true,
        });
        metrics.deadProbed++;
      }

      // 6. Category backfill: classify mappings with null product_category
      const { data: uncat } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_type_name, bandcamp_url")
        .eq("workspace_id", workspaceId)
        .is("product_category", null)
        .not("bandcamp_url", "is", null)
        .limit(ACTION_LIMIT);

      for (const m of uncat ?? []) {
        const cat = classifyProduct(m.bandcamp_type_name, m.bandcamp_url, null);
        await supabase
          .from("bandcamp_product_mappings")
          .update({ product_category: cat, updated_at: new Date().toISOString() })
          .eq("id", m.id);
        metrics.categoryBackfilled++;
      }
    }

    // 7. Emit reconciliation metrics as sensor readings
    const metricEntries = [
      { key: "reconcile.resolved_stale", value: metrics.resolvedStaleSuccess },
      { key: "reconcile.resolved_category", value: metrics.resolvedCategoryMismatch },
      { key: "reconcile.reattempts", value: metrics.reattemptTriggered },
      { key: "reconcile.dead_enforced", value: metrics.deadEnforced },
      { key: "reconcile.dead_probed", value: metrics.deadProbed },
      { key: "reconcile.category_backfilled", value: metrics.categoryBackfilled },
    ];

    for (const entry of metricEntries) {
      await supabase.from("sensor_readings").insert({
        sensor_key: entry.key,
        value: entry.value,
        unit: "count",
        metadata: { runAt: new Date().toISOString() },
      });
    }

    logger.info("Scraper reconciliation complete", metrics);
    return metrics;
  },
});
