/**
 * Bandcamp sale poll — cron every 5 minutes.
 *
 * Rule #9: Uses bandcampQueue (serialized with all other Bandcamp API tasks).
 * Rule #20: Inventory changes go through recordInventoryChange().
 * Rule #7: Uses createServiceRoleClient().
 */

import { schedules, tasks } from "@trigger.dev/sdk";
import { getMerchDetails, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { bundleComponentFanoutTask } from "@/trigger/tasks/bundle-component-fanout";

export const bandcampSalePollTask = schedules.task({
  id: "bandcamp-sale-poll",
  cron: "*/5 * * * *",
  queue: bandcampQueue,
  maxDuration: 120,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const startedAt = new Date().toISOString();
    let salesDetected = 0;
    let errors = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, org_id, band_id")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections || connections.length === 0) continue;

      const accessToken = await refreshBandcampToken(workspaceId);

      for (const connection of connections) {
        try {
          const merchItems = await getMerchDetails(connection.band_id, accessToken);

          for (const item of merchItems) {
            if (!item.sku || item.quantity_sold == null) continue;

            // Look up mapping
            const { data: mapping } = await supabase
              .from("bandcamp_product_mappings")
              .select("id, variant_id, last_quantity_sold")
              .eq("workspace_id", workspaceId)
              .eq("bandcamp_item_id", item.package_id)
              .single();

            if (!mapping) continue;

            const lastSold = mapping.last_quantity_sold ?? 0;
            const newSold = item.quantity_sold;

            if (newSold > lastSold) {
              const delta = -(newSold - lastSold); // Negative — items were sold

              // Get variant SKU
              const { data: variant } = await supabase
                .from("warehouse_product_variants")
                .select("sku")
                .eq("id", mapping.variant_id)
                .single();

              if (variant) {
                // Stable correlation ID for idempotency
                const correlationId = `bandcamp-sale:${connection.band_id}:${item.package_id}:${newSold}`;

                const result = await recordInventoryChange({
                  workspaceId,
                  sku: variant.sku,
                  delta,
                  source: "bandcamp",
                  correlationId,
                  metadata: {
                    band_id: connection.band_id,
                    bandcamp_item_id: item.package_id,
                    previous_quantity_sold: lastSold,
                    new_quantity_sold: newSold,
                    run_id: ctx.run.id,
                  },
                });

                // Trigger immediate push to all channels after a sale —
                // don't wait for the next cron cycle (push tasks are idempotent)
                if (result.success && !result.alreadyProcessed) {
                  await Promise.allSettled([
                    tasks.trigger("bandcamp-inventory-push", {}),
                    tasks.trigger("multi-store-inventory-push", {}),
                  ]).catch(() => {
                    /* non-critical — cron covers it */
                  });

                  // If this variant is a bundle, decrement component inventory
                  const { data: bundleCheck } = await supabase
                    .from("bundle_components")
                    .select("id")
                    .eq("bundle_variant_id", mapping.variant_id)
                    .limit(1);

                  if (bundleCheck?.length) {
                    await bundleComponentFanoutTask
                      .trigger({
                        bundleVariantId: mapping.variant_id,
                        soldQuantity: Math.abs(delta),
                        workspaceId,
                        correlationBase: correlationId,
                      })
                      .catch(() => {
                        /* non-critical — review queue will surface failures */
                      });
                  }
                }

                salesDetected++;
              }

              // Update last_quantity_sold
              await supabase
                .from("bandcamp_product_mappings")
                .update({
                  last_quantity_sold: newSold,
                  last_synced_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq("id", mapping.id);
            }
          }

          // Update connection last_synced_at
          await supabase
            .from("bandcamp_connections")
            .update({
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id);
        } catch (error) {
          errors++;
          console.error(
            `[bandcamp-sale-poll] Failed for band ${connection.band_id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "bandcamp",
        sync_type: "sale_poll",
        status: errors > 0 ? "partial" : "completed",
        items_processed: salesDetected,
        items_failed: errors,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
    }

    return { salesDetected, errors };
  },
});
