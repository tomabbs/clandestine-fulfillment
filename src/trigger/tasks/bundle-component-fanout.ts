/**
 * Bundle component fanout — triggered by bandcamp-sale-poll when a bundle variant sells.
 *
 * Decrements each component's inventory via the canonical recordInventoryChange path.
 * Idempotency: correlationId includes bundle + sale event + component variant ID.
 *
 * Rule #20: Uses recordInventoryChange for all inventory writes.
 * Rule #9: Does NOT use bandcampQueue (not a Bandcamp API call — internal logic only).
 */

import { task } from "@trigger.dev/sdk";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface BundleComponentFanoutPayload {
  bundleVariantId: string;
  soldQuantity: number;
  workspaceId: string;
  correlationBase: string; // e.g. "bandcamp-sale:band_id:package_id:newSold"
}

export const bundleComponentFanoutTask = task({
  id: "bundle-component-fanout",
  maxDuration: 60,
  run: async (payload: BundleComponentFanoutPayload) => {
    const { bundleVariantId, soldQuantity, workspaceId, correlationBase } = payload;
    const supabase = createServiceRoleClient();

    const { data: components } = await supabase
      .from("bundle_components")
      .select(`
        id,
        component_variant_id,
        quantity,
        warehouse_product_variants!component_variant_id (sku)
      `)
      .eq("bundle_variant_id", bundleVariantId);

    if (!components?.length) {
      return { skipped: true, reason: "no_components" };
    }

    let decremented = 0;
    const results: { sku: string; delta: number; status: string }[] = [];

    for (const comp of components) {
      const variant = comp.warehouse_product_variants as unknown as { sku: string } | null;
      if (!variant?.sku) continue;

      const delta = -(soldQuantity * comp.quantity);
      const correlationId = `${correlationBase}:component:${comp.component_variant_id}`;

      const result = await recordInventoryChange({
        workspaceId,
        sku: variant.sku,
        delta,
        source: "bandcamp",
        correlationId,
        metadata: {
          bundle_variant_id: bundleVariantId,
          component_variant_id: comp.component_variant_id,
          quantity_per_bundle: comp.quantity,
          sold_quantity: soldQuantity,
        },
      });

      const status = result.alreadyProcessed
        ? "already_processed"
        : result.success
          ? "decremented"
          : ((result as { reason?: string }).reason ?? "failed");

      results.push({ sku: variant.sku, delta, status });
      if (result.success && !result.alreadyProcessed) decremented++;
    }

    return { componentsDecremented: decremented, totalComponents: components.length, results };
  },
});
