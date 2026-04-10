/**
 * Tag cleanup backfill — manual trigger only.
 *
 * Scans the entire catalog and fixes Pre-Order / New Releases tags
 * based on current dates and street_date.
 *
 * Tag rules:
 *   street_date > today             → Pre-Order YES, New Releases YES
 *   street_date <= today             → Pre-Order NO
 *   street_date + 45 days <= today   → New Releases NO
 *   street_date + 45 days > today    → New Releases leave as-is
 */

import { logger, task } from "@trigger.dev/sdk";
import { tagsAdd, tagsRemove } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const tagCleanupBackfillTask = task({
  id: "tag-cleanup-backfill",
  maxDuration: 600,
  run: async (payload: { workspace_id: string }) => {
    const supabase = createServiceRoleClient();
    const { workspace_id: workspaceId } = payload;
    const today = new Date().toISOString().split("T")[0];
    const cutoff45 = new Date();
    cutoff45.setDate(cutoff45.getDate() - 45);
    const cutoff45Str = cutoff45.toISOString().split("T")[0];

    let preorderAdded = 0;
    let preorderRemoved = 0;
    let newReleaseRemoved = 0;

    // Get all variants with street_date
    const allVariants: Array<{ product_id: string; street_date: string }> = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("warehouse_product_variants")
        .select("product_id, street_date")
        .eq("workspace_id", workspaceId)
        .not("street_date", "is", null)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      allVariants.push(...(data as Array<{ product_id: string; street_date: string }>));
      offset += data.length;
      if (data.length < 1000) break;
    }

    // Group by product, pick earliest street_date per product
    const productStreetDates = new Map<string, string>();
    for (const v of allVariants) {
      const existing = productStreetDates.get(v.product_id);
      if (!existing || v.street_date < existing) {
        productStreetDates.set(v.product_id, v.street_date);
      }
    }

    const productIds = Array.from(productStreetDates.keys());
    if (productIds.length === 0) {
      return { preorderAdded, preorderRemoved, newReleaseRemoved, totalScanned: 0 };
    }

    // Fetch products in batches
    for (let i = 0; i < productIds.length; i += 100) {
      const batch = productIds.slice(i, i + 100);
      const { data: products } = await supabase
        .from("warehouse_products")
        .select("id, shopify_product_id, tags")
        .in("id", batch);

      for (const product of products ?? []) {
        const streetDate = productStreetDates.get(product.id);
        if (!streetDate) continue;

        const tags = (product.tags as string[]) ?? [];
        const hasPO = tags.includes("Pre-Order");
        const hasNR = tags.includes("New Releases");
        const isFuture = streetDate > today;
        const isPast45 = streetDate <= cutoff45Str;

        const tagsToAdd: string[] = [];
        const tagsToRemoveList: string[] = [];

        // Pre-Order: should have if future, should NOT have if past
        if (isFuture && !hasPO) tagsToAdd.push("Pre-Order");
        if (!isFuture && hasPO) tagsToRemoveList.push("Pre-Order");

        // New Releases: should NOT have if 45+ days past street_date
        if (isPast45 && hasNR) tagsToRemoveList.push("New Releases");

        // Future products should have New Releases
        if (isFuture && !hasNR) tagsToAdd.push("New Releases");

        if (tagsToAdd.length === 0 && tagsToRemoveList.length === 0) continue;

        // Update Shopify
        if (product.shopify_product_id) {
          try {
            if (tagsToAdd.length > 0) await tagsAdd(product.shopify_product_id, tagsToAdd);
            if (tagsToRemoveList.length > 0)
              await tagsRemove(product.shopify_product_id, tagsToRemoveList);
          } catch (e) {
            logger.warn("Shopify tag update failed", {
              productId: product.id,
              error: String(e),
            });
          }
        }

        // Update local DB
        let updatedTags = [...tags];
        for (const t of tagsToAdd) {
          if (!updatedTags.includes(t)) updatedTags.push(t);
        }
        updatedTags = updatedTags.filter((t) => !tagsToRemoveList.includes(t));

        await supabase
          .from("warehouse_products")
          .update({ tags: updatedTags, updated_at: new Date().toISOString() })
          .eq("id", product.id);

        if (tagsToAdd.includes("Pre-Order")) preorderAdded++;
        if (tagsToRemoveList.includes("Pre-Order")) preorderRemoved++;
        if (tagsToRemoveList.includes("New Releases")) newReleaseRemoved++;
      }
    }

    logger.info("Tag cleanup complete", {
      preorderAdded,
      preorderRemoved,
      newReleaseRemoved,
      totalScanned: productIds.length,
    });

    return {
      preorderAdded,
      preorderRemoved,
      newReleaseRemoved,
      totalScanned: productIds.length,
    };
  },
});
