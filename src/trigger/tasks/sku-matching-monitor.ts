import { logger, schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import {
  type SkuMatchingPerfEventRow,
  summarizeSkuMatchingMonitoring,
} from "@/lib/server/sku-matching-monitor";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const skuMatchingMonitorTask = schedules.task({
  id: "sku-matching-monitor",
  cron: "0 14 * * 1",
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    for (const workspaceId of workspaceIds) {
      const { data, error } = await supabase
        .from("sku_matching_perf_events")
        .select("workspace_id, event_type, duration_ms, conflict_count, created_at")
        .eq("workspace_id", workspaceId)
        .gte("created_at", since)
        .order("created_at", { ascending: true });

      if (error) {
        logger.error("[sku-matching-monitor] perf event read failed", {
          workspaceId,
          error: error.message,
        });
        continue;
      }

      const summary = summarizeSkuMatchingMonitoring((data ?? []) as SkuMatchingPerfEventRow[]);

      await supabase.from("sensor_readings").insert({
        workspace_id: workspaceId,
        sensor_name: "sku_matching.monitoring",
        status: summary.status,
        value: {
          run_id: ctx.run.id,
          window_days: 7,
          workspace_load_p90_ms: summary.workspaceLoadP90Ms,
          preview_count: summary.previewCount,
          acceptance_count: summary.acceptanceCount,
          review_only_count: summary.reviewOnlyCount,
          acceptance_rate: summary.acceptanceRate,
          latest_conflict_count: summary.latestConflictCount,
          conflict_growth: summary.conflictGrowth,
          reasons: summary.reasons,
        },
        message:
          summary.status === "healthy"
            ? "SKU matching monitoring within budget"
            : `SKU matching monitoring warning: ${summary.reasons.join(", ")}`,
      });

      if (summary.reasons.includes("conflict_growth")) {
        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: workspaceId,
            category: "sku_matching_conflict_growth",
            severity: "medium",
            title: "SKU matching conflicts are growing",
            description: `Trailing 7-day conflict count grew from ${summary.earliestConflictCount} to ${summary.latestConflictCount}. Review /admin/settings/sku-matching before widening rollout.`,
            metadata: {
              run_id: ctx.run.id,
              earliest_conflict_count: summary.earliestConflictCount,
              latest_conflict_count: summary.latestConflictCount,
              conflict_growth: summary.conflictGrowth,
              workspace_load_p90_ms: summary.workspaceLoadP90Ms,
            },
            status: "open",
            group_key: `sku-matching-conflicts:${workspaceId}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
      }
    }
  },
});
