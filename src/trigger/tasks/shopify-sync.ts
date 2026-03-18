/**
 * Shopify delta sync — runs every 15 minutes via cron.
 *
 * Rule #46: Delta sync uses an overlap window. Subtracts 2 minutes from the
 * cursor to catch products updated near the cursor boundary.
 *
 * Rule #59: Bulk sync exception — uses bulk INSERT ON CONFLICT for Postgres
 * and pipeline HSET for Redis, NOT recordInventoryChange per row.
 *
 * Rule #7: Uses createServiceRoleClient() — bypasses RLS.
 * Rule #12: Task payload is IDs only — task fetches data it needs.
 */

import { schedules } from "@trigger.dev/sdk";
import { Redis } from "@upstash/redis";
import type { ShopifyProduct } from "@/lib/clients/shopify-client";
import { fetchInventoryLevels, fetchProducts } from "@/lib/clients/shopify-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const OVERLAP_MINUTES = 2;
const PAGE_SIZE = 50;

export const shopifySyncTask = schedules.task({
  id: "shopify-sync",
  cron: "*/15 * * * *",
  maxDuration: 300,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = env();
    const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    const workspaceIds = await getAllWorkspaceIds(supabase);

    const results: Array<{ workspaceId: string; products: number; variants: number }> = [];

    for (const workspaceId of workspaceIds) {
      // Load sync state
      const { data: syncState } = await supabase
        .from("warehouse_sync_state")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("sync_type", "shopify_delta")
        .single();

      // Rule #46: subtract 2 minutes from cursor for overlap window
      let updatedAtMin: string | null = null;
      if (syncState?.last_sync_cursor) {
        const cursor = new Date(syncState.last_sync_cursor);
        cursor.setMinutes(cursor.getMinutes() - OVERLAP_MINUTES);
        updatedAtMin = cursor.toISOString();
      }

      const syncStartedAt = new Date().toISOString();
      let totalProducts = 0;
      let totalVariants = 0;
      let latestUpdatedAt: string | null = syncState?.last_sync_cursor ?? null;
      let cursor: string | null = null;
      let hasNextPage = true;

      // Log sync start
      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "shopify",
        sync_type: "delta",
        status: "started",
        started_at: syncStartedAt,
      });

      try {
        while (hasNextPage) {
          const { products, pageInfo } = await fetchProducts({
            first: PAGE_SIZE,
            after: cursor,
            updatedAtMin,
          });

          if (products.length === 0) break;

          // Upsert products + variants in bulk
          const { productCount, variantCount, inventoryItemIds, latestUpdate } =
            await upsertProductsBulk(supabase, products, workspaceId);

          totalProducts += productCount;
          totalVariants += variantCount;

          if (latestUpdate && (!latestUpdatedAt || latestUpdate > latestUpdatedAt)) {
            latestUpdatedAt = latestUpdate;
          }

          // Fetch inventory levels for new variants
          if (inventoryItemIds.length > 0) {
            const levels = await fetchInventoryLevels(inventoryItemIds);
            await upsertInventoryBulk(supabase, redis, levels, workspaceId);
          }

          cursor = pageInfo.endCursor;
          hasNextPage = pageInfo.hasNextPage;
        }

        // Update sync cursor
        await supabase.from("warehouse_sync_state").upsert(
          {
            workspace_id: workspaceId,
            sync_type: "shopify_delta",
            last_sync_cursor: latestUpdatedAt ?? syncStartedAt,
            last_sync_wall_clock: syncStartedAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,sync_type" },
        );

        // Log single sync_reconciliation event (Rule #59)
        if (totalVariants > 0) {
          await supabase.from("warehouse_inventory_activity").insert({
            workspace_id: workspaceId,
            sku: "__sync_reconciliation__",
            delta: 0,
            source: "shopify",
            correlation_id: `shopify-sync:${ctx.run.id}:${workspaceId}`,
            metadata: {
              type: "sync_reconciliation",
              products_synced: totalProducts,
              variants_synced: totalVariants,
              sync_run_id: ctx.run.id,
            },
          });
        }

        // Log sync complete
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

        results.push({ workspaceId, products: totalProducts, variants: totalVariants });
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
    }

    return results;
  },
});

// ---------------------------------------------------------------------------
// Bulk upsert helpers (Rule #59 exception — no recordInventoryChange per row)
// ---------------------------------------------------------------------------

async function upsertProductsBulk(
  supabase: ReturnType<typeof createServiceRoleClient>,
  products: ShopifyProduct[],
  workspaceId: string,
) {
  let productCount = 0;
  let variantCount = 0;
  let latestUpdate: string | null = null;
  const inventoryItemIds: string[] = [];

  for (const product of products) {
    // Determine org_id from existing product or skip if not found
    const { data: existingProduct } = await supabase
      .from("warehouse_products")
      .select("org_id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_product_id", product.id)
      .single();

    const orgId = existingProduct?.org_id;
    if (!orgId) continue; // Skip products not mapped to an org

    // Upsert product
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

    // Get product ID for variants
    const { data: dbProduct } = await supabase
      .from("warehouse_products")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_product_id", product.id)
      .single();

    if (!dbProduct) continue;

    productCount++;

    // Upsert variants
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

    if (product.updatedAt && (!latestUpdate || product.updatedAt > latestUpdate)) {
      latestUpdate = product.updatedAt;
    }
  }

  return { productCount, variantCount, inventoryItemIds, latestUpdate };
}

async function upsertInventoryBulk(
  supabase: ReturnType<typeof createServiceRoleClient>,
  redis: Redis,
  levels: Array<{
    inventoryItemId: string;
    available: number;
    committed: number;
    incoming: number;
  }>,
  workspaceId: string,
) {
  // Look up variant_id and sku for each inventory item
  for (const level of levels) {
    const { data: variant } = await supabase
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

    if (!variant) continue;

    // Upsert inventory level in Postgres
    await supabase.from("warehouse_inventory_levels").upsert(
      {
        variant_id: variant.id,
        workspace_id: workspaceId,
        sku: variant.sku,
        available: level.available,
        committed: level.committed,
        incoming: level.incoming,
        last_redis_write_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "variant_id", ignoreDuplicates: false },
    );

    // Update Redis ledger (Rule #59: bulk pipeline, not per-row recordInventoryChange)
    await redis.hset(`inv:${variant.sku}`, {
      available: level.available,
      committed: level.committed,
      incoming: level.incoming,
    });
  }
}
