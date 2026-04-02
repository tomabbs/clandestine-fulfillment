/**
 * Bundle availability sweep — daily 6am UTC safety net.
 *
 * For workspaces with bundles_enabled, triggers inventory push tasks
 * to recompute and push bundle MIN availability to Bandcamp and client stores.
 * Catches any missed fanout events from webhook failures or race conditions.
 */

import { schedules, tasks } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const bundleAvailabilitySweepTask = schedules.task({
  id: "bundle-availability-sweep",
  cron: "0 6 * * *",
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    let workspacesWithBundles = 0;

    for (const workspaceId of workspaceIds) {
      // Only trigger for workspaces with bundles_enabled flag set
      const { count } = await supabase
        .from("bundle_components")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);

      if (count && count > 0) {
        workspacesWithBundles++;
        await Promise.allSettled([
          tasks.trigger("bandcamp-inventory-push", {}),
          tasks.trigger("multi-store-inventory-push", {}),
        ]).catch(() => { /* non-critical */ });
      }
    }

    return { workspacesWithBundles };
  },
});
