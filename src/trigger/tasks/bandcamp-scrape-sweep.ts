/**
 * Bandcamp scrape sweep — cron every 10 minutes on dedicated bandcamp-sweep queue.
 *
 * Processes Groups 1-3 with limit 100/group (vs 50 in the main sync).
 * Runs independently of bandcamp-api queue — no OAuth API calls, just DB queries
 * and bandcamp-scrape-page task triggers.
 *
 * Throughput: 100 items/group × 3 groups × 6 runs/hr = 1,800 triggers/hr max from this cron.
 * Worker throughput depends on bandcamp-scrape queue concurrency (5) and page task duration.
 *
 * Group 1: has bandcamp_url, missing bandcamp_type_name (needs scrape)
 * Group 2: no URL — construct from bandcamp_member_band_id → subdomain → slug
 * Group 3: scraped but missing about/credits/upc/tracks (added 2026-04-01)
 */

import { logger, schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { buildBandcampAlbumUrl, extractAlbumTitle } from "@/lib/clients/bandcamp-scraper";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampSweepQueue } from "@/trigger/lib/bandcamp-sweep-queue";
import { bandcampScrapePageTask } from "@/trigger/tasks/bandcamp-sync";

interface MemberBandEntry { band_id: number }

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
      let g2SelectedCount = 0;
      let g2SkipNoSubdomain = 0;
      let g2SkipEmptyTitle = 0;
      let g2SkipBadSlug = 0;
      let g2SkipUrlRace = 0;

      // Load connections for subdomain lookup maps (shared across all groups)
      const { data: allConns } = await supabase
        .from("bandcamp_connections")
        .select("band_id, band_url, member_bands_cache")
        .eq("workspace_id", workspaceId)
        .not("band_url", "is", null);

      // Primary: direct connection band_id → subdomain (17 unique keys)
      const bandIdToSubdomain = new Map<number, string>(
        (allConns ?? []).map((c) => [
          c.band_id as number,
          (c.band_url ?? "").replace("https://", "").split(".")[0],
        ]),
      );

      // Secondary: label sub-artists via member_bands_cache
      const memberBandParentSubdomain = new Map<number, string>();
      for (const conn of allConns ?? []) {
        const parentSub = (conn.band_url ?? "").replace("https://", "").split(".")[0];
        if (!parentSub) continue;
        let memberBands: MemberBandEntry[] = [];
        try {
          const raw = conn.member_bands_cache;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (Array.isArray(parsed?.member_bands)) {
            memberBands = parsed.member_bands as MemberBandEntry[];
          } else if (Array.isArray(parsed)) {
            memberBands = parsed as MemberBandEntry[];
          }
        } catch {
          logger.warn("bandcamp-scrape-sweep: member_bands_cache parse failed", {
            connectionBandId: conn.band_id,
          });
        }
        for (const mb of memberBands) {
          if (typeof mb?.band_id === "number" && !memberBandParentSubdomain.has(mb.band_id)) {
            memberBandParentSubdomain.set(mb.band_id, parentSub);
          }
        }
      }

      // ── Group 1: has URL, missing type_name ──────────────────────────────────
      // Skip items with 5+ failures (permanently blocked by Cloudflare or wrong URL)
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

      // ── Group 2: no URL — construct via member_band_id lookup ─────────────────
      const { data: group2 } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, variant_id, bandcamp_member_band_id")
        .eq("workspace_id", workspaceId)
        .is("bandcamp_url", null)
        .is("bandcamp_type_name", null)
        .limit(100);

      g2SelectedCount = group2?.length ?? 0;

      if (group2?.length) {
        const variantIds = group2.map((m) => m.variant_id);
        const { data: variants } = await supabase
          .from("warehouse_product_variants")
          .select("id, warehouse_products!inner(title)")
          .in("id", variantIds);

        const titleByVariant = new Map(
          (variants ?? []).map((v) => [
            v.id,
            (v.warehouse_products as unknown as { title: string }).title,
          ]),
        );

        for (const pm of group2) {
          const memberBandId = pm.bandcamp_member_band_id as number | null;
          const subdomain =
            (memberBandId ? bandIdToSubdomain.get(memberBandId) : null) ??
            (memberBandId ? memberBandParentSubdomain.get(memberBandId) : null) ??
            null;

          if (!subdomain) {
            g2SkipNoSubdomain++;
            await supabase.from("warehouse_review_queue").upsert(
              {
                workspace_id: workspaceId,
                category: "bandcamp_scraper",
                severity: "low" as const,
                title: `Cannot construct Bandcamp URL: no subdomain for member_band_id ${memberBandId}`,
                description: `Mapping ${pm.id} has member_band_id ${memberBandId} which does not match any active connection or member_bands_cache. Set bandcamp_url manually to enable scraping.`,
                metadata: { mappingId: pm.id, memberBandId },
                status: "open" as const,
                group_key: `bc_unresolvable_${pm.id}`,
                occurrence_count: 1,
              },
              { onConflict: "group_key", ignoreDuplicates: true },
            );
            continue;
          }

          const rawTitle = titleByVariant.get(pm.variant_id) ?? "";
          if (!rawTitle.trim()) {
            g2SkipEmptyTitle++;
            continue;
          }

          const albumTitle = extractAlbumTitle(rawTitle);

          const scrapeUrl = albumTitle ? buildBandcampAlbumUrl(subdomain, albumTitle) : null;
          if (!scrapeUrl) {
            g2SkipBadSlug++;
            continue;
          }

          logger.info("bandcamp-scrape-sweep group 2 item", {
            mappingId: pm.id,
            memberBandId,
            subdomain,
            constructedUrl: scrapeUrl,
            source: memberBandId && bandIdToSubdomain.has(memberBandId) ? "direct" : "member_cache",
          });

          // Idempotency guard: only write URL if not already set
          const { data: urlWritten } = await supabase
            .from("bandcamp_product_mappings")
            .update({
              bandcamp_url: scrapeUrl,
              bandcamp_url_source: "constructed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", pm.id)
            .is("bandcamp_url", null)
            .select("id")
            .single();

          if (!urlWritten) {
            g2SkipUrlRace++;
            continue;
          }

          await bandcampScrapePageTask.trigger({
            url: scrapeUrl,
            mappingId: pm.id,
            workspaceId,
            urlIsConstructed: true,
            albumTitle: albumTitle ?? undefined,
            urlSource: "constructed",
          });
          triggered++;
          g2Triggered++;
        }
      }

      // ── Group 3: scraped but missing about/credits/upc/tracks ─────────────────
      const { data: group3 } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_art_url", "is", null)
        .is("bandcamp_about", null)
        .not("bandcamp_url", "is", null)
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
          g2: {
            selected: g2SelectedCount,
            triggered: g2Triggered,
            skip_no_subdomain: g2SkipNoSubdomain,
            skip_empty_title: g2SkipEmptyTitle,
            skip_bad_slug: g2SkipBadSlug,
            skip_url_already_set: g2SkipUrlRace,
          },
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
