/**
 * Bandcamp sale poll — cron every 5 minutes.
 *
 * Rule #9: Uses bandcampQueue (serialized with all other Bandcamp API tasks).
 * Rule #20: Inventory changes go through recordInventoryChange().
 * Rule #7: Uses createServiceRoleClient().
 */

import { schedules } from "@trigger.dev/sdk";
import { getMerchDetails, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"; // TODO: multi-workspace

export const bandcampSalePollTask = schedules.task({
  id: "bandcamp-sale-poll",
  cron: "*/5 * * * *",
  queue: bandcampQueue,
  maxDuration: 120,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const startedAt = new Date().toISOString();
    let salesDetected = 0;
    let errors = 0;

    const { data: connections } = await supabase
      .from("bandcamp_connections")
      .select("id, org_id, band_id")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("is_active", true);

    if (!connections || connections.length === 0) {
      return { salesDetected: 0, errors: 0 };
    }

    const accessToken = await refreshBandcampToken(WORKSPACE_ID);

    for (const connection of connections) {
      try {
        const merchItems = await getMerchDetails(connection.band_id, accessToken);

        for (const item of merchItems) {
          if (!item.sku || item.quantity_sold == null) continue;

          // Look up mapping
          const { data: mapping } = await supabase
            .from("bandcamp_product_mappings")
            .select("id, variant_id, last_quantity_sold")
            .eq("workspace_id", WORKSPACE_ID)
            .eq("bandcamp_item_id", item.id)
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
              const correlationId = `bandcamp-sale:${connection.band_id}:${item.id}:${newSold}`;

              await recordInventoryChange({
                workspaceId: WORKSPACE_ID,
                sku: variant.sku,
                delta,
                source: "bandcamp",
                correlationId,
                metadata: {
                  band_id: connection.band_id,
                  bandcamp_item_id: item.id,
                  previous_quantity_sold: lastSold,
                  new_quantity_sold: newSold,
                  run_id: ctx.run.id,
                },
              });

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
      workspace_id: WORKSPACE_ID,
      channel: "bandcamp",
      sync_type: "sale_poll",
      status: errors > 0 ? "partial" : "completed",
      items_processed: salesDetected,
      items_failed: errors,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });

    return { salesDetected, errors };
  },
});
