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
 *
 * Inventory-aware prioritization: in-stock items fill 80% of the budget,
 * OOS items get the remaining 20% for catalog completeness catch-up.
 */

import { logger, schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { classifyProduct } from "@/lib/shared/product-categories";
import { bandcampSweepQueue } from "@/trigger/lib/bandcamp-sweep-queue";
import { bandcampScrapePageTask } from "@/trigger/tasks/bandcamp-sync";

const IN_STOCK_LIMIT = 80;
const OOS_CATCHUP_LIMIT = 20;

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
      let g1InStock = 0;
      let g1Oos = 0;
      let g3Triggered = 0;
      let g3InStock = 0;
      let g3Oos = 0;

      // ── Group 1: has URL, missing type_name (enrichment scrape) ────────────
      // Only active/probation mappings — dead handled by reconciliation probes
      const { data: g1All } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url, variant_id, raw_api_data, product_category, bandcamp_type_name")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_url", "is", null)
        .is("bandcamp_type_name", null)
        .in("scrape_status", ["active", "probation"])
        .limit(200);

      const g1Prioritized = await prioritizeByStock(
        supabase,
        g1All ?? [],
        IN_STOCK_LIMIT,
        OOS_CATCHUP_LIMIT,
      );

      for (const pm of g1Prioritized.items) {
        const cat =
          pm.product_category ?? classifyProduct(pm.bandcamp_type_name, pm.bandcamp_url, null);
        await bandcampScrapePageTask.trigger({
          url: pm.bandcamp_url as string,
          mappingId: pm.id,
          workspaceId,
          urlIsConstructed: false,
          urlSource: "orders_api",
          productCategory: cat,
        });
        triggered++;
        g1Triggered++;
      }
      g1InStock = g1Prioritized.inStockCount;
      g1Oos = g1Prioritized.oosCount;

      // Group 2 removed — URLs now come from the Bandcamp API, not construction.

      // ── Group 3: has URL + art but missing about/credits/tracks (enrichment) ──
      // Skip apparel/merch — they never have about/credits/tracks on Bandcamp.
      // Safety valve: items with null category are still scraped (not yet classified).
      const { data: g3All } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url, variant_id, raw_api_data, product_category, bandcamp_type_name")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_url", "is", null)
        .is("bandcamp_about", null)
        .not("bandcamp_art_url", "is", null)
        .or("product_category.is.null,product_category.not.in.(apparel,merch)")
        .in("scrape_status", ["active", "probation"])
        .limit(200);

      const g3Prioritized = await prioritizeByStock(
        supabase,
        g3All ?? [],
        IN_STOCK_LIMIT,
        OOS_CATCHUP_LIMIT,
      );

      for (const pm of g3Prioritized.items) {
        const cat =
          pm.product_category ?? classifyProduct(pm.bandcamp_type_name, pm.bandcamp_url, null);
        await bandcampScrapePageTask.trigger({
          url: pm.bandcamp_url as string,
          mappingId: pm.id,
          workspaceId,
          urlIsConstructed: false,
          urlSource: "orders_api",
          productCategory: cat,
        });
        triggered++;
        g3Triggered++;
      }
      g3InStock = g3Prioritized.inStockCount;
      g3Oos = g3Prioritized.oosCount;

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
          limits: { in_stock: IN_STOCK_LIMIT, oos_catchup: OOS_CATCHUP_LIMIT },
          scrape_queue_concurrency: 5,
          scrape_task_max_duration_sec: 60,
          g1: {
            candidates: g1All?.length ?? 0,
            triggered: g1Triggered,
            in_stock: g1InStock,
            oos_catchup: g1Oos,
          },
          g3: {
            candidates: g3All?.length ?? 0,
            triggered: g3Triggered,
            in_stock: g3InStock,
            oos_catchup: g3Oos,
          },
        },
      });

      logger.info("bandcamp-scrape-sweep complete", {
        workspaceId,
        triggered,
        g1: { total: g1All?.length ?? 0, triggered: g1Triggered, inStock: g1InStock, oos: g1Oos },
        g3: { total: g3All?.length ?? 0, triggered: g3Triggered, inStock: g3InStock, oos: g3Oos },
      });

      totalTriggered += triggered;
    }

    return { totalTriggered };
  },
});

interface MappingRow {
  id: string;
  bandcamp_url: string | null;
  variant_id: string;
  raw_api_data: Record<string, unknown> | null;
  product_category: string | null;
  bandcamp_type_name: string | null;
}

async function prioritizeByStock(
  supabase: ReturnType<typeof createServiceRoleClient>,
  mappings: MappingRow[],
  inStockLimit: number,
  oosLimit: number,
): Promise<{ items: MappingRow[]; inStockCount: number; oosCount: number }> {
  if (mappings.length === 0) return { items: [], inStockCount: 0, oosCount: 0 };

  const variantIds = mappings.map((m) => m.variant_id).filter(Boolean);
  const { data: levels } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id, available")
    .in("variant_id", variantIds);

  const invMap = new Map((levels ?? []).map((l) => [l.variant_id, l.available as number]));

  const inStock: MappingRow[] = [];
  const oos: MappingRow[] = [];

  for (const m of mappings) {
    const bcQty = (m.raw_api_data?.quantity_available as number | null | undefined) ?? null;
    const whQty = invMap.get(m.variant_id);

    if ((bcQty !== null && bcQty > 0) || (whQty !== undefined && whQty > 0)) {
      inStock.push(m);
    } else if (whQty === undefined && bcQty === null) {
      // Unknown stock (no inventory row, no BC data) — treat as in-stock to avoid skipping new items
      inStock.push(m);
    } else {
      oos.push(m);
    }
  }

  const selected = [...inStock.slice(0, inStockLimit), ...oos.slice(0, oosLimit)];

  return {
    items: selected,
    inStockCount: Math.min(inStock.length, inStockLimit),
    oosCount: Math.min(oos.length, oosLimit),
  };
}
