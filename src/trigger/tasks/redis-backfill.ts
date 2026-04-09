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
import { getInventory, setInventory } from "@/lib/clients/redis-inventory";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

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
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const backfillStartedAt = new Date().toISOString();

    const allResults: Array<{ workspaceId: string } & BackfillResult> = [];

    for (const workspaceId of workspaceIds) {
      // Fetch ALL inventory levels from Postgres
      const { data: levels } = await supabase
        .from("warehouse_inventory_levels")
        .select("sku, available, committed, incoming, last_redis_write_at")
        .eq("workspace_id", workspaceId);

      if (!levels || levels.length === 0) {
        allResults.push({
          workspaceId,
          totalSkus: 0,
          updated: 0,
          skippedLiveWrites: 0,
          mismatches: 0,
        });
        continue;
      }

      let updated = 0;
      let skippedLiveWrites = 0;
      let mismatches = 0;

      for (const level of levels) {
        if (shouldSkipSku(level.last_redis_write_at, backfillStartedAt)) {
          skippedLiveWrites++;
          continue;
        }

        const redis = await getInventory(level.sku);
        const hasDrift =
          redis.available !== level.available ||
          redis.committed !== (level.committed ?? 0) ||
          redis.incoming !== (level.incoming ?? 0);
        if (hasDrift) mismatches++;

        await setInventory(level.sku, {
          available: level.available,
          committed: level.committed,
          incoming: level.incoming,
        });

        updated++;
      }

      const result: BackfillResult = {
        totalSkus: levels.length,
        updated,
        skippedLiveWrites,
        mismatches,
      };

      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
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
          workspace_id: workspaceId,
          category: "inventory_drift",
          severity: "medium",
          title: `Redis/Postgres drift: ${result.mismatches} mismatches`,
          description: `Weekly backfill found ${result.mismatches} SKUs where Redis and Postgres values diverged. ${result.updated} SKUs updated, ${result.skippedLiveWrites} skipped due to live writes.`,
          metadata: result,
          group_key: `redis_drift:${backfillStartedAt.split("T")[0]}`,
          status: "open",
        });
      }

      allResults.push({ workspaceId, ...result });
    }

    return allResults;
  },
});
