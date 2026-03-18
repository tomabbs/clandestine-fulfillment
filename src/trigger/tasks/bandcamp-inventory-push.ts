/**
 * Bandcamp inventory push — cron every 15 minutes.
 *
 * Rule #9: Uses bandcampQueue (serialized with all other Bandcamp API tasks).
 * Rule #7: Uses createServiceRoleClient().
 */

import { schedules } from "@trigger.dev/sdk";
import { refreshBandcampToken, updateQuantities } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export const bandcampInventoryPushTask = schedules.task({
  id: "bandcamp-inventory-push",
  cron: "*/15 * * * *",
  queue: bandcampQueue,
  maxDuration: 120,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);

    const allResults: Array<{
      workspaceId: string;
      itemsPushed: number;
      itemsFailed: number;
    }> = [];

    for (const workspaceId of workspaceIds) {
      const startedAt = new Date().toISOString();
      let itemsPushed = 0;
      let itemsFailed = 0;

      // Get active bandcamp connections
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, org_id, band_id, band_name")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections || connections.length === 0) {
        allResults.push({ workspaceId, itemsPushed: 0, itemsFailed: 0 });
        continue;
      }

      // Refresh token
      const accessToken = await refreshBandcampToken(workspaceId);

      for (const connection of connections) {
        try {
          // Get all mappings for this connection's band
          const { data: mappings } = await supabase
            .from("bandcamp_product_mappings")
            .select("id, variant_id, bandcamp_item_id, bandcamp_item_type, last_quantity_sold")
            .eq("workspace_id", workspaceId)
            .not("bandcamp_item_id", "is", null);

          if (!mappings || mappings.length === 0) continue;

          // Get variant IDs to look up inventory
          const variantIds = mappings.map((m) => m.variant_id);
          const { data: inventoryLevels } = await supabase
            .from("warehouse_inventory_levels")
            .select("variant_id, available")
            .in("variant_id", variantIds);

          const inventoryByVariant = new Map(
            (inventoryLevels ?? []).map((l) => [l.variant_id, l.available]),
          );

          // Build update payload — include quantity_sold for Bandcamp race condition handling
          const pushItems: Array<{
            item_id: number;
            item_type: string;
            quantity_available: number;
            quantity_sold: number;
          }> = [];

          for (const mapping of mappings) {
            if (!mapping.bandcamp_item_id || !mapping.bandcamp_item_type) continue;

            const available = inventoryByVariant.get(mapping.variant_id) ?? 0;
            pushItems.push({
              item_id: mapping.bandcamp_item_id,
              item_type: mapping.bandcamp_item_type,
              quantity_available: available,
              quantity_sold: mapping.last_quantity_sold ?? 0,
            });
          }

          if (pushItems.length > 0) {
            await updateQuantities(pushItems, accessToken);
            itemsPushed += pushItems.length;
          }
        } catch (error) {
          itemsFailed++;
          console.error(
            `[bandcamp-inventory-push] Failed for band ${connection.band_id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      // Log results
      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "bandcamp",
        sync_type: "inventory_push",
        status: itemsFailed > 0 ? "partial" : "completed",
        items_processed: itemsPushed,
        items_failed: itemsFailed,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });

      allResults.push({ workspaceId, itemsPushed, itemsFailed });
    }

    return { results: allResults, runId: ctx.run.id };
  },
});
