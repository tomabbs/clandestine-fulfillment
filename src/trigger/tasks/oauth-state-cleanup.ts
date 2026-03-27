/**
 * OAuth state cleanup task.
 *
 * Deletes expired oauth_states rows to prevent table bloat.
 * States expire after 15 minutes — this runs every 15 minutes to keep the table clean.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is minimal.
 */

import { schedules, task } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function runCleanup(): Promise<{ success: boolean; deleted: number; error?: string }> {
  const supabase = createServiceRoleClient();

  // Use count: "exact" on the delete to get affected row count
  const { count, error } = await supabase
    .from("oauth_states")
    .delete({ count: "exact" })
    .lt("expires_at", new Date().toISOString());

  if (error) {
    console.error("[oauth-state-cleanup] Error:", error.message);
    return { success: false, deleted: 0, error: error.message };
  }

  const deleted = count ?? 0;
  if (deleted > 0) {
    console.log(`[oauth-state-cleanup] Deleted ${deleted} expired OAuth states`);
  }
  return { success: true, deleted };
}

export const oauthStateCleanupSchedule = schedules.task({
  id: "oauth-state-cleanup-schedule",
  cron: "*/15 * * * *",
  maxDuration: 30,
  run: async () => runCleanup(),
});

export const oauthStateCleanupTask = task({
  id: "oauth-state-cleanup",
  maxDuration: 60,
  run: async () => runCleanup(),
});
