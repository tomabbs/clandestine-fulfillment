/**
 * Redis backfill — weekly Tuesday 3 AM EST (Rule #27).
 *
 * Rebuilds Redis from Postgres truth. Race condition protection:
 * if last_redis_write_at > backfill_started_at, skip that SKU
 * (a live write happened after the backfill began).
 *
 * Rule #7: Uses createServiceRoleClient().
 */

import { schedules } from "@trigger.dev/sdk";
import { setInventory } from "@/lib/clients/redis-inventory";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"; // TODO: multi-workspace

export interface BackfillResult {
  totalSkus: number;
  updated: number;
  skippedLiveWrites: number;
  mismatches: number;
}

export function shouldSkipSku(lastRedisWriteAt: string | null, backfillStartedAt: string): boolean {
  if (!lastRedisWriteAt) return false;
  return lastRedisWriteAt > backfillStartedAt;
}

export const redisBackfillTask = schedules.task({
  id: "redis-backfill",
  cron: {
    pattern: "0 3 * * 2",
    timezone: "America/New_York",
  },
  maxDuration: 600,
  run: async (_payload, { ctx: _ctx }) => {
    const supabase = createServiceRoleClient();
    const backfillStartedAt = new Date().toISOString();

    // Fetch ALL inventory levels from Postgres
    const { data: levels } = await supabase
      .from("warehouse_inventory_levels")
      .select("sku, available, committed, incoming, last_redis_write_at")
      .eq("workspace_id", WORKSPACE_ID);

    if (!levels || levels.length === 0) {
      return { totalSkus: 0, updated: 0, skippedLiveWrites: 0, mismatches: 0 };
    }

    let updated = 0;
    let skippedLiveWrites = 0;

    for (const level of levels) {
      // Race condition protection (Rule #27):
      // If a live write happened after our backfill started, skip it
      if (shouldSkipSku(level.last_redis_write_at, backfillStartedAt)) {
        skippedLiveWrites++;
        continue;
      }

      await setInventory(level.sku, {
        available: level.available,
        committed: level.committed,
        incoming: level.incoming,
      });

      updated++;
    }

    // Log reconciliation stats
    const result: BackfillResult = {
      totalSkus: levels.length,
      updated,
      skippedLiveWrites,
      mismatches: 0, // Future: compare Redis values before overwrite
    };

    await supabase.from("channel_sync_log").insert({
      workspace_id: WORKSPACE_ID,
      channel: "redis",
      sync_type: "backfill",
      status: "completed",
      items_processed: updated,
      items_failed: 0,
      started_at: backfillStartedAt,
      completed_at: new Date().toISOString(),
    });

    // Create review queue item if drift detected
    if (result.mismatches > 0) {
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: WORKSPACE_ID,
        category: "inventory_drift",
        severity: "medium",
        title: `Redis/Postgres drift: ${result.mismatches} mismatches`,
        description: `Weekly backfill found ${result.mismatches} SKUs where Redis and Postgres values diverged. ${result.updated} SKUs updated, ${result.skippedLiveWrites} skipped due to live writes.`,
        metadata: result,
        group_key: `redis_drift:${backfillStartedAt.split("T")[0]}`,
        status: "open",
      });
    }

    return result;
  },
});
