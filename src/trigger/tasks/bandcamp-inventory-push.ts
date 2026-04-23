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
import { getMerchDetails, refreshBandcampToken, updateQuantities } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { computeEffectiveBundleAvailable } from "@/lib/server/bundles";
import { evaluateEffectiveSellable } from "@/lib/server/effective-sellable";
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
          // Phase 1 — `push_mode` filter (TRUTH_LAYER: Bandcamp push_mode contract).
          // `normal` and `manual_override` are pushed; `blocked_baseline` and
          // `blocked_multi_origin` are skipped at the source. We pull `push_mode`
          // here (not in a WHERE clause) so we can also count blocked rows in the
          // sync log metadata for operational visibility.
          //
          // Phase 0.7 — Distro skip (defensive). Distro variants (variant whose
          // owning warehouse_products row has org_id IS NULL) are not Bandcamp
          // products by definition, but if a stray bandcamp_product_mappings row
          // ever gets attached to one (e.g. data drift, manual SQL), we MUST NOT
          // push to Bandcamp on its behalf. We pull the variant→product join so
          // we can drop those rows before building update payloads.
          const { data: allMappings } = await supabase
            .from("bandcamp_product_mappings")
            .select(
              "id, variant_id, bandcamp_item_id, bandcamp_item_type, last_quantity_sold, push_mode, warehouse_product_variants!inner(warehouse_products!inner(org_id))",
            )
            .eq("workspace_id", workspaceId)
            .not("bandcamp_item_id", "is", null);

          if (!allMappings || allMappings.length === 0) continue;

          // Strip the join shape so downstream code keeps the simple row type.
          type RawMapping = (typeof allMappings)[number];
          const mappingsAfterDistroFilter = allMappings.filter((m: RawMapping) => {
            const variant = m.warehouse_product_variants as unknown as {
              warehouse_products: { org_id: string | null } | null;
            } | null;
            return variant?.warehouse_products?.org_id != null;
          });
          const distroSkipped = allMappings.length - mappingsAfterDistroFilter.length;
          if (distroSkipped > 0) {
            console.warn(
              `[bandcamp-inventory-push] band ${connection.band_id}: ${distroSkipped} distro-attached mapping(s) skipped (org_id IS NULL on owning product)`,
            );
          }

          const mappings = mappingsAfterDistroFilter.filter(
            (m: RawMapping) => m.push_mode === "normal" || m.push_mode === "manual_override",
          );
          const blockedCount = mappingsAfterDistroFilter.length - mappings.length;
          if (blockedCount > 0) {
            console.log(
              `[bandcamp-inventory-push] band ${connection.band_id}: ${blockedCount}/${mappingsAfterDistroFilter.length} mappings skipped (push_mode != normal/manual_override)`,
            );
          }
          if (mappings.length === 0) continue;

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

          // Fetch merch details to identify option-level items
          const merchDetails = await getMerchDetails(connection.band_id, accessToken);
          const optionsByPackageId = new Map<
            number,
            Array<{ option_id: number; quantity_sold: number }>
          >();
          for (const item of merchDetails) {
            if (item.options && item.options.length > 0) {
              optionsByPackageId.set(
                item.package_id,
                item.options.map((o) => ({
                  option_id: o.option_id,
                  quantity_sold: o.quantity_sold ?? 0,
                })),
              );
            }
          }

          // Build update payloads — apply safety buffer at push time
          const packageItems: Array<{
            item_id: number;
            item_type: string;
            quantity_available: number;
            quantity_sold: number;
          }> = [];
          const optionItems: Array<{
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

            let effectiveAvailable = rawAvailable;
            if (bundlesEnabled) {
              const components = bundleMap.get(mapping.variant_id);
              if (components?.length) {
                // Phase 2.5(b): shared bundle availability helper.
                effectiveAvailable = computeEffectiveBundleAvailable(
                  rawAvailable,
                  components,
                  inventoryByVariant,
                );
              }
            }

            // Phase 1 §9.2 D8 / N-13 — push formula via shared helper. The
            // cron has bulk-loaded levels above; we still own the bundle
            // math (it's an `available` derivation, not a push-formula
            // concern) but the safety-stock resolution + clamp belong to
            // the helper for X-7 dual-edit safety.
            const sellable = evaluateEffectiveSellable("bandcamp", {
              variant: { id: mapping.variant_id },
              level: {
                available: effectiveAvailable,
                safety_stock: inv?.safetyStock ?? null,
              },
              connectionMappingSafety: null,
              perChannelSafety: null,
              workspaceDefaultSafety: workspaceSafetyStock,
            });
            const pushedQuantity = sellable.effectiveSellable;
            const options = optionsByPackageId.get(mapping.bandcamp_item_id);

            if (options) {
              // Option-level: push each option with the same quantity
              for (const opt of options) {
                optionItems.push({
                  item_id: opt.option_id,
                  item_type: "o",
                  quantity_available: pushedQuantity,
                  quantity_sold: opt.quantity_sold,
                });
              }
            } else {
              packageItems.push({
                item_id: mapping.bandcamp_item_id,
                item_type: mapping.bandcamp_item_type,
                quantity_available: pushedQuantity,
                quantity_sold: mapping.last_quantity_sold ?? 0,
              });
            }
          }

          if (packageItems.length > 0) {
            await updateQuantities(packageItems, accessToken);
            itemsPushed += packageItems.length;
          }
          if (optionItems.length > 0) {
            await updateQuantities(optionItems, accessToken);
            itemsPushed += optionItems.length;
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
