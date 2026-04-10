/**
 * Pre-order setup — event trigger.
 *
 * Called when bandcamp-sync or inbound-product-create detects a future street_date.
 * Adds "Pre-Orders" and "New Releases" tags to the Shopify product, sets is_preorder = true,
 * and syncs warehouse_products.tags so the warehouse dashboard stays accurate.
 *
 * §21 decision: We do NOT use Shopify selling plans for pre-orders. Tags only.
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { logger, task } from "@trigger.dev/sdk";
import { tagsAdd } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const preorderSetupTask = task({
  id: "preorder-setup",
  maxDuration: 60,
  run: async (payload: { variant_id: string; workspace_id: string }) => {
    const supabase = createServiceRoleClient();

    // Fetch variant
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, product_id, street_date, is_preorder")
      .eq("id", payload.variant_id)
      .single();

    if (!variant) throw new Error(`Variant ${payload.variant_id} not found`);
    if (variant.is_preorder) return { alreadySetUp: true };

    // Fetch product (need tags for local sync)
    const { data: product } = await supabase
      .from("warehouse_products")
      .select("id, shopify_product_id, tags")
      .eq("id", variant.product_id)
      .single();

    if (product?.shopify_product_id) {
      try {
        await tagsAdd(product.shopify_product_id, ["Pre-Orders", "New Releases"]);

        // Sync tags to local DB immediately — avoids lag in warehouse dashboard (GAP-4)
        const currentTags = (product.tags as string[]) ?? [];
        const newTags = Array.from(new Set([...currentTags, "Pre-Orders", "New Releases"]));
        await supabase
          .from("warehouse_products")
          .update({ tags: newTags, updated_at: new Date().toISOString() })
          .eq("id", product.id);

        logger.info("preorder-setup: tags added to Shopify and DB synced", {
          variantId: variant.id,
          sku: variant.sku,
          shopifyProductId: product.shopify_product_id,
          tags: newTags,
        });
      } catch (err) {
        const errorMsg = String(err);

        logger.error("preorder-setup: Shopify tagsAdd failed", {
          variantId: variant.id,
          sku: variant.sku,
          shopifyProductId: product.shopify_product_id,
          error: errorMsg,
        });

        // Log to channel_sync_log for operational visibility
        await supabase
          .from("channel_sync_log")
          .insert({
            workspace_id: payload.workspace_id,
            channel: "preorder",
            sync_type: "preorder_setup",
            status: "failed",
            items_processed: 0,
            items_failed: 1,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            metadata: {
              variant_id: variant.id,
              sku: variant.sku,
              shopify_product_id: product.shopify_product_id,
              error: errorMsg,
            },
          })
          .then(
            () => {},
            (e) => logger.warn("channel_sync_log insert failed", { error: String(e) }),
          );

        // Create review queue item so staff can action the failure (HIGH-1)
        await supabase
          .from("warehouse_review_queue")
          .upsert(
            {
              workspace_id: payload.workspace_id,
              category: "preorder_setup",
              severity: "high",
              title: `Pre-order tag setup failed: ${variant.sku}`,
              description: `Failed to add Pre-Orders tag to Shopify product. Error: ${errorMsg}`,
              metadata: {
                variant_id: variant.id,
                sku: variant.sku,
                shopify_product_id: product.shopify_product_id,
                error: errorMsg,
              },
              status: "open",
              group_key: `preorder_setup_failed:${variant.id}`,
              occurrence_count: 1,
            },
            { onConflict: "group_key", ignoreDuplicates: false },
          )
          .then(
            () => {},
            (e) => logger.warn("review_queue upsert failed", { error: String(e) }),
          );

        // Still mark is_preorder = true in DB — business state is preorder regardless of Shopify
      }
    } else {
      // No Shopify product yet — expected for new Bandcamp-only items
      logger.info("preorder-setup: no Shopify product yet, skipping tag add", {
        variantId: variant.id,
        sku: variant.sku,
        productId: variant.product_id,
      });
    }

    // Mark variant as pre-order in DB
    await supabase
      .from("warehouse_product_variants")
      .update({ is_preorder: true, updated_at: new Date().toISOString() })
      .eq("id", variant.id);

    return { variantId: variant.id, sku: variant.sku };
  },
});
