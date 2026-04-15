/**
 * Bandcamp inventory push — cron every 5 minutes (was 15).
 *
 * Applies safety buffer at push time: pushed_qty = MAX(0, available - effective_safety_stock)
 * effective_safety_stock = COALESCE(per_sku.safety_stock, workspace.default_safety_stock, 3)
 *
 * Rule #9: Uses bandcampQueue (serialized with all other Bandcamp API tasks).
 * Rule #7: Uses createServiceRoleClient().
 *
 * When workspaces.inventory_sync_paused is true, the workspace is skipped.
 * Only the state-change (active → paused transition) is logged to channel_sync_log
 * to avoid flooding the log with 288 identical entries per day.
 */

import { schedules } from "@trigger.dev/sdk";
import { refreshBandcampToken, updateQuantities } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export const bandcampInventoryPushTask = schedules.task({
  id: "bandcamp-inventory-push",
  cron: "*/5 * * * *",
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

      // Load workspace settings including pause flag
      const { data: ws } = await supabase
        .from("workspaces")
        .select("default_safety_stock, bundles_enabled, inventory_sync_paused")
        .eq("id", workspaceId)
        .single();

      // Pause guard — state-change-only logging to avoid flooding channel_sync_log
      if (ws?.inventory_sync_paused) {
        const { data: lastLog } = await supabase
          .from("channel_sync_log")
          .select("status")
          .eq("workspace_id", workspaceId)
          .eq("channel", "bandcamp")
          .eq("sync_type", "inventory_push")
          .order("completed_at", { ascending: false })
          .limit(1)
          .single();

        if (lastLog?.status !== "paused") {
          const now = new Date().toISOString();
          await supabase.from("channel_sync_log").insert({
            workspace_id: workspaceId,
            channel: "bandcamp",
            sync_type: "inventory_push",
            status: "paused",
            items_processed: 0,
            items_failed: 0,
            started_at: now,
            completed_at: now,
            metadata: { reason: "inventory_sync_paused", run_id: ctx.run.id },
          });
        }
        allResults.push({ workspaceId, itemsPushed: 0, itemsFailed: 0 });
        continue;
      }

      const workspaceSafetyStock = ws?.default_safety_stock ?? 3;
      const bundlesEnabled = ws?.bundles_enabled ?? false;

      // Load bundle components for this workspace (only if bundles are enabled)
      type BundleComponent = {
        bundle_variant_id: string;
        component_variant_id: string;
        quantity: number;
      };
      const bundleMap = new Map<string, BundleComponent[]>();
      if (bundlesEnabled) {
        const { data: allComponents } = await supabase
          .from("bundle_components")
          .select("bundle_variant_id, component_variant_id, quantity")
          .eq("workspace_id", workspaceId);

        for (const bc of allComponents ?? []) {
          const arr = bundleMap.get(bc.bundle_variant_id) ?? [];
          arr.push(bc);
          bundleMap.set(bc.bundle_variant_id, arr);
        }
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

          // Get variant IDs to look up inventory (include component variant IDs for bundle MIN)
          const variantIds = mappings.map((m) => m.variant_id);
          const componentVariantIds = bundlesEnabled
            ? Array.from(
                new Set(
                  Array.from(bundleMap.values())
                    .flat()
                    .map((c) => c.component_variant_id),
                ),
              )
            : [];
          const allVariantIds = Array.from(new Set([...variantIds, ...componentVariantIds]));

          const { data: inventoryLevels } = await supabase
            .from("warehouse_inventory_levels")
            .select("variant_id, available, safety_stock")
            .in("variant_id", allVariantIds);

          const inventoryByVariant = new Map(
            (inventoryLevels ?? []).map((l) => [
              l.variant_id,
              { available: l.available, safetyStock: l.safety_stock as number | null },
            ]),
          );

          // Build update payload — apply safety buffer at push time
          const pushItems: Array<{
            item_id: number;
            item_type: string;
            quantity_available: number;
            quantity_sold: number;
          }> = [];

          for (const mapping of mappings) {
            if (!mapping.bandcamp_item_id || !mapping.bandcamp_item_type) continue;

            const inv = inventoryByVariant.get(mapping.variant_id);
            const rawAvailable = inv?.available ?? 0;
            const effectiveSafety = inv?.safetyStock ?? workspaceSafetyStock;

            // Compute bundle minimum when this variant is a bundle and bundles are enabled
            let effectiveAvailable = rawAvailable;
            if (bundlesEnabled) {
              const components = bundleMap.get(mapping.variant_id);
              if (components?.length) {
                // DFS cycle safety is enforced at write time (setBundleComponents).
                // At push time we just compute MIN — no recursion risk.
                const componentMin = Math.min(
                  ...components.map((c) => {
                    const compInv = inventoryByVariant.get(c.component_variant_id);
                    return Math.floor((compInv?.available ?? 0) / c.quantity);
                  }),
                );
                effectiveAvailable = Math.min(rawAvailable, Math.max(0, componentMin));
              }
            }

            const pushedQuantity = Math.max(0, effectiveAvailable - effectiveSafety);

            pushItems.push({
              item_id: mapping.bandcamp_item_id,
              item_type: mapping.bandcamp_item_type,
              quantity_available: pushedQuantity,
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

      // Log results with enriched metadata for bandcamp-push-log.py
      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "bandcamp",
        sync_type: "inventory_push",
        status: itemsFailed > 0 ? "partial" : "completed",
        items_processed: itemsPushed,
        items_failed: itemsFailed,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        metadata: {
          run_id: ctx.run.id,
          band_count: connections.length,
        },
      });

      allResults.push({ workspaceId, itemsPushed, itemsFailed });
    }

    return { results: allResults, runId: ctx.run.id };
  },
});
