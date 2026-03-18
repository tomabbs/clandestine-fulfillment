/**
 * Shopify full backfill — manual trigger only, no cron.
 *
 * Fetches the entire Shopify catalog with pagination and upserts everything.
 * Uses the same bulk pattern as shopify-sync (Rule #59 exception).
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #48: Only triggered via Trigger.dev task — never called directly from Server Actions.
 */

import { task } from "@trigger.dev/sdk";
import { Redis } from "@upstash/redis";
import type { ShopifyProduct } from "@/lib/clients/shopify-client";
import { fetchInventoryLevels, fetchProducts } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const PAGE_SIZE = 50;

export const shopifyFullBackfillTask = task({
  id: "shopify-full-backfill",
  maxDuration: 600,
  run: async (payload: { workspace_id: string }, { ctx }) => {
    const workspaceId = payload.workspace_id;
    const supabase = createServiceRoleClient();
    const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = env();
    const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

    const syncStartedAt = new Date().toISOString();
    let totalProducts = 0;
    let totalVariants = 0;
    let cursor: string | null = null;
    let hasNextPage = true;

    await supabase.from("channel_sync_log").insert({
      workspace_id: workspaceId,
      channel: "shopify",
      sync_type: "full_backfill",
      status: "started",
      started_at: syncStartedAt,
    });

    try {
      while (hasNextPage) {
        const { products, pageInfo } = await fetchProducts({
          first: PAGE_SIZE,
          after: cursor,
          updatedAtMin: null,
        });

        if (products.length === 0) break;

        const result = await upsertProductsBackfill(supabase, redis, products, workspaceId);
        totalProducts += result.productCount;
        totalVariants += result.variantCount;

        cursor = pageInfo.endCursor;
        hasNextPage = pageInfo.hasNextPage;
      }

      // Update sync state with backfill timestamp
      await supabase.from("warehouse_sync_state").upsert(
        {
          workspace_id: workspaceId,
          sync_type: "shopify_delta",
          last_full_sync_at: syncStartedAt,
          last_sync_wall_clock: syncStartedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,sync_type" },
      );

      // Log reconciliation event
      if (totalVariants > 0) {
        await supabase.from("warehouse_inventory_activity").insert({
          workspace_id: workspaceId,
          sku: "__sync_reconciliation__",
          delta: 0,
          source: "shopify",
          correlation_id: `shopify-backfill:${ctx.run.id}`,
          metadata: {
            type: "sync_reconciliation",
            products_synced: totalProducts,
            variants_synced: totalVariants,
            sync_run_id: ctx.run.id,
            backfill: true,
          },
        });
      }

      await supabase
        .from("channel_sync_log")
        .update({
          status: "completed",
          items_processed: totalProducts,
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("channel", "shopify")
        .eq("started_at", syncStartedAt);

      return { products: totalProducts, variants: totalVariants };
    } catch (error) {
      await supabase
        .from("channel_sync_log")
        .update({
          status: "failed",
          items_processed: totalProducts,
          error_message: error instanceof Error ? error.message : String(error),
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("channel", "shopify")
        .eq("started_at", syncStartedAt);

      throw error;
    }
  },
});

async function upsertProductsBackfill(
  supabase: ReturnType<typeof createServiceRoleClient>,
  redis: Redis,
  products: ShopifyProduct[],
  workspaceId: string,
) {
  let productCount = 0;
  let variantCount = 0;

  for (const product of products) {
    const { data: existingProduct } = await supabase
      .from("warehouse_products")
      .select("org_id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_product_id", product.id)
      .single();

    const orgId = existingProduct?.org_id;
    if (!orgId) continue;

    await supabase.from("warehouse_products").upsert(
      {
        workspace_id: workspaceId,
        org_id: orgId,
        shopify_product_id: product.id,
        title: product.title,
        vendor: product.vendor,
        product_type: product.productType,
        status: product.status.toLowerCase() as "active" | "draft" | "archived",
        tags: product.tags,
        shopify_handle: product.handle,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,shopify_product_id", ignoreDuplicates: false },
    );

    const { data: dbProduct } = await supabase
      .from("warehouse_products")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_product_id", product.id)
      .single();

    if (!dbProduct) continue;
    productCount++;

    const inventoryItemIds: string[] = [];

    for (const edge of product.variants.edges) {
      const variant = edge.node;
      if (!variant.sku) continue;

      await supabase.from("warehouse_product_variants").upsert(
        {
          product_id: dbProduct.id,
          workspace_id: workspaceId,
          sku: variant.sku,
          shopify_variant_id: variant.id,
          title: variant.title,
          price: variant.price ? Number.parseFloat(variant.price) : null,
          compare_at_price: variant.compareAtPrice
            ? Number.parseFloat(variant.compareAtPrice)
            : null,
          barcode: variant.barcode,
          weight: variant.inventoryItem?.measurement?.weight?.value ?? null,
          weight_unit: variant.inventoryItem?.measurement?.weight?.unit?.toLowerCase() ?? "lb",
          option1_name: variant.selectedOptions[0]?.name ?? null,
          option1_value: variant.selectedOptions[0]?.value ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,sku", ignoreDuplicates: false },
      );

      if (variant.inventoryItem?.id) {
        inventoryItemIds.push(variant.inventoryItem.id);
      }
      variantCount++;
    }

    // Upsert images — uses unique index on shopify_image_id
    const firstImageUrl = await upsertImagesBackfill(
      supabase,
      product.images.edges,
      dbProduct.id,
      workspaceId,
    );

    if (firstImageUrl) {
      await supabase
        .from("warehouse_products")
        .update({ images: [{ src: firstImageUrl }] })
        .eq("id", dbProduct.id);
    }

    // Fetch and upsert inventory levels
    if (inventoryItemIds.length > 0) {
      const levels = await fetchInventoryLevels(inventoryItemIds);
      for (const level of levels) {
        const { data: dbVariant } = await supabase
          .from("warehouse_product_variants")
          .select("id, sku")
          .eq("workspace_id", workspaceId)
          .eq(
            "shopify_variant_id",
            level.inventoryItemId.replace(
              "gid://shopify/InventoryItem/",
              "gid://shopify/ProductVariant/",
            ),
          )
          .single();

        if (!dbVariant) continue;

        await supabase.from("warehouse_inventory_levels").upsert(
          {
            variant_id: dbVariant.id,
            workspace_id: workspaceId,
            sku: dbVariant.sku,
            available: level.available,
            committed: level.committed,
            incoming: level.incoming,
            last_redis_write_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "variant_id", ignoreDuplicates: false },
        );

        await redis.hset(`inv:${dbVariant.sku}`, {
          available: level.available,
          committed: level.committed,
          incoming: level.incoming,
        });
      }
    }
  }

  return { productCount, variantCount };
}

/**
 * Upsert product images into warehouse_product_images.
 * Uses the unique index on shopify_image_id for ON CONFLICT.
 * Returns the URL of the first (primary) image, or null.
 */
async function upsertImagesBackfill(
  supabase: ReturnType<typeof createServiceRoleClient>,
  imageEdges: ShopifyProduct["images"]["edges"],
  productId: string,
  workspaceId: string,
): Promise<string | null> {
  if (imageEdges.length === 0) return null;

  for (let i = 0; i < imageEdges.length; i++) {
    const img = imageEdges[i].node;
    const shopifyImageId = img.id.replace(/gid:\/\/shopify\/(ImageSource|ProductImage)\//, "");

    await supabase.from("warehouse_product_images").upsert(
      {
        product_id: productId,
        workspace_id: workspaceId,
        shopify_image_id: shopifyImageId,
        src: img.url,
        alt: img.altText,
        position: i,
      },
      { onConflict: "shopify_image_id", ignoreDuplicates: false },
    );
  }

  return imageEdges[0].node.url;
}
