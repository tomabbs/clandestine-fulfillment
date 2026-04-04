/**
 * Catalog stats refresh — nightly (default) + on-demand.
 *
 * Precomputes workspace_catalog_stats for Bandcamp-mapped catalog completeness.
 * Staff UI reads the snapshot instead of running heavy live joins.
 * §1b.E, §8 Phase A item 3.
 */

import { schedules, task } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function refreshStatsForWorkspace(workspaceId: string) {
  const supabase = createServiceRoleClient();

  const { data: mappings } = await supabase
    .from("bandcamp_product_mappings")
    .select(
      "id, bandcamp_art_url, bandcamp_about, bandcamp_credits, bandcamp_tracks, bandcamp_url, variant_id",
    )
    .eq("workspace_id", workspaceId);

  const total = mappings?.length ?? 0;

  const stats = {
    total,
    hasAlbumCover: mappings?.filter((m) => m.bandcamp_art_url != null).length ?? 0,
    hasAbout:
      mappings?.filter((m) => m.bandcamp_about != null && m.bandcamp_about !== "").length ?? 0,
    hasCredits:
      mappings?.filter((m) => m.bandcamp_credits != null && m.bandcamp_credits !== "").length ?? 0,
    hasTracks: mappings?.filter((m) => m.bandcamp_tracks != null).length ?? 0,
    hasUrl: mappings?.filter((m) => m.bandcamp_url != null).length ?? 0,
  };

  await supabase.from("workspace_catalog_stats").upsert(
    {
      workspace_id: workspaceId,
      stats,
      computed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );

  return stats;
}

export const catalogStatsRefreshSchedule = schedules.task({
  id: "catalog-stats-refresh",
  cron: "0 4 * * *",
  maxDuration: 120,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const results: Array<{ workspaceId: string; total: number }> = [];

    for (const workspaceId of workspaceIds) {
      const stats = await refreshStatsForWorkspace(workspaceId);
      results.push({ workspaceId, total: stats.total });
    }

    return results;
  },
});

export const catalogStatsRefreshTask = task({
  id: "catalog-stats-refresh-demand",
  maxDuration: 60,
  run: async (payload: { workspaceId: string }) => {
    return refreshStatsForWorkspace(payload.workspaceId);
  },
});
