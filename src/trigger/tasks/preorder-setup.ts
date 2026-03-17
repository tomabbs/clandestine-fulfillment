/**
 * Pre-order setup — event trigger.
 *
 * Called when bandcamp-sync or inbound-product-create detects a future street_date.
 * Creates selling plan on Shopify, adds tags, sets is_preorder = true.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { task } from "@trigger.dev/sdk";
import { sellingPlanGroupCreate, tagsAdd } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const preorderSetupTask = task({
  id: "preorder-setup",
  maxDuration: 60,
  run: async (payload: { variant_id: string; workspace_id: string }) => {
    const supabase = createServiceRoleClient();

    // Fetch variant + product
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, product_id, street_date, is_preorder")
      .eq("id", payload.variant_id)
      .single();

    if (!variant) throw new Error(`Variant ${payload.variant_id} not found`);
    if (variant.is_preorder) return { alreadySetUp: true };

    const { data: product } = await supabase
      .from("warehouse_products")
      .select("shopify_product_id")
      .eq("id", variant.product_id)
      .single();

    // Create selling plan group on Shopify
    if (product?.shopify_product_id) {
      try {
        await sellingPlanGroupCreate({
          name: `Pre-Order: ${variant.sku}`,
          merchantCode: "pre-order",
          options: ["Pre-Order"],
          sellingPlansToCreate: [
            {
              name: "Pre-Order",
              options: ["Pre-Order"],
              category: "PRE_ORDER",
              billingPolicy: {
                fixed: {
                  remainingBalanceChargeTrigger: "NO_REMAINING_BALANCE",
                },
              },
              deliveryPolicy: {
                fixed: {
                  fulfillmentTrigger: "UNKNOWN",
                },
              },
            },
          ],
          resourcesIds: {
            productIds: [product.shopify_product_id],
          },
        });

        // Add tags
        await tagsAdd(product.shopify_product_id, ["Pre-Orders", "New Releases"]);
      } catch {
        // Log but don't fail — Shopify may not have this product yet
      }
    }

    // Set is_preorder = true
    await supabase
      .from("warehouse_product_variants")
      .update({ is_preorder: true, updated_at: new Date().toISOString() })
      .eq("id", variant.id);

    return { variantId: variant.id, sku: variant.sku };
  },
});
