/**
 * shopify-image-backfill — manual trigger only, no cron.
 *
 * Fixes two data gaps created by historical bugs:
 *
 * Gap 1 — warehouse_product_images rows missing from JSONB-only products.
 *   Many products were synced from Shopify before the warehouse_product_images
 *   table was properly hydrated by upsertImagesBulk. Their shopify CDN URLs
 *   exist in warehouse_products.images (JSONB) but have no corresponding rows
 *   in warehouse_product_images. This prevents the catalog page from showing
 *   thumbnails and breaks future "push to Shopify" flows.
 *
 * Gap 2 — products with no images anywhere (images = '[]').
 *   Products created via bandcamp-sync used `media` instead of `files` in the
 *   productSet call (wrong field name for Shopify 2024-10+ ProductSetInput).
 *   Shopify silently ignored it, so products were created without images.
 *   For these we pull bandcamp_art_url from the mapping and push via
 *   productCreateMedia.
 *
 * Idempotent: safe to re-run. warehouse_product_images rows are deduplicated
 * by the (product_id, src) unique constraint. Shopify productCreateMedia is
 * best-effort but won't create duplicates when given the same original URL
 * (Shopify's file deduplication applies to the same CDN file).
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #48: Triggered via admin action only — never from Server Actions directly.
 */

import { logger, task } from "@trigger.dev/sdk";
import { productCreateMedia } from "@/lib/clients/shopify-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const BATCH_SIZE = 50;

export const shopifyImageBackfillTask = task({
  id: "shopify-image-backfill",
  maxDuration: 3600,
  run: async (payload: { workspace_id?: string }, { ctx }) => {
    const supabase = createServiceRoleClient();

    const workspaceIds = payload.workspace_id
      ? [payload.workspace_id]
      : await getAllWorkspaceIds(supabase);

    const summary = {
      rowsBackfilled: 0,
      imagePushAttempts: 0,
      imagePushSuccesses: 0,
      imagePushFailures: 0,
      workspaces: workspaceIds.length,
    };

    for (const workspaceId of workspaceIds) {
      logger.info("shopify-image-backfill: processing workspace", { workspaceId });

      // ── Gap 1: Backfill warehouse_product_images from images JSONB ──────────
      // Find products where images JSONB is a non-empty array but no rows exist
      // in warehouse_product_images. These were synced from Shopify before the
      // per-row image table was properly hydrated.

      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data: products, error } = await supabase
          .from("warehouse_products")
          .select("id, images, shopify_product_id")
          .eq("workspace_id", workspaceId)
          .not("images", "is", null)
          .not("shopify_product_id", "is", null)
          .range(offset, offset + BATCH_SIZE - 1);

        if (error) {
          logger.error("shopify-image-backfill: failed to fetch products", { workspaceId, error });
          break;
        }
        if (!products || products.length === 0) {
          hasMore = false;
          break;
        }

        for (const product of products) {
          const imagesJsonb = product.images as Array<{
            src: string;
            alt?: string;
            position?: number;
          }> | null;

          if (!imagesJsonb || imagesJsonb.length === 0) continue;

          // Check if this product already has warehouse_product_images rows
          const { count } = await supabase
            .from("warehouse_product_images")
            .select("id", { count: "exact", head: true })
            .eq("product_id", product.id);

          if ((count ?? 0) > 0) continue; // already populated, skip

          // Insert rows from JSONB (deduplicated by the unique constraint)
          const rows = imagesJsonb.map((img, i) => ({
            product_id: product.id,
            workspace_id: workspaceId,
            src: img.src,
            alt: img.alt ?? null,
            position: img.position ?? i,
            // No shopify_image_id available from JSONB — leave null
            // The next shopify-sync delta will fill it in when the product is touched
          }));

          const { error: insertErr } = await supabase
            .from("warehouse_product_images")
            .insert(rows)
            .select();

          if (insertErr) {
            // Unique constraint violations are expected (race or partial run) — skip
            if (!insertErr.message.includes("duplicate") && !insertErr.message.includes("unique")) {
              logger.warn("shopify-image-backfill: insert error (gap 1)", {
                productId: product.id,
                error: insertErr.message,
              });
            }
          } else {
            summary.rowsBackfilled += rows.length;
            logger.info("shopify-image-backfill: backfilled image rows", {
              productId: product.id,
              count: rows.length,
            });
          }
        }

        offset += BATCH_SIZE;
        hasMore = products.length === BATCH_SIZE;
      }

      // ── Gap 2: Push images to Shopify for products with no images anywhere ──
      // Find products where images = '[]' (empty array) AND no warehouse_product_images rows.
      // These are Bandcamp-synced products created with the wrong `media` field.
      // We pull bandcamp_art_url from bandcamp_product_mappings and push via productCreateMedia.

      const { data: noImageProducts } = await supabase
        .from("warehouse_products")
        .select("id, title, shopify_product_id")
        .eq("workspace_id", workspaceId)
        .not("shopify_product_id", "is", null)
        // Supabase: filter on JSONB equality
        .filter("images", "eq", "[]");

      for (const product of noImageProducts ?? []) {
        if (!product.shopify_product_id) continue;

        // Confirm no warehouse_product_images rows
        const { count: imgCount } = await supabase
          .from("warehouse_product_images")
          .select("id", { count: "exact", head: true })
          .eq("product_id", product.id);

        if ((imgCount ?? 0) > 0) continue;

        // Look up bandcamp_art_url via variant → mapping
        const { data: variants } = await supabase
          .from("warehouse_product_variants")
          .select("id")
          .eq("product_id", product.id)
          .limit(10);

        if (!variants?.length) continue;

        const variantIds = variants.map((v) => v.id);

        const { data: mappings } = await supabase
          .from("bandcamp_product_mappings")
          .select("bandcamp_art_url, variant_id")
          .in("variant_id", variantIds)
          .not("bandcamp_art_url", "is", null)
          .limit(1);

        const artUrl = mappings?.[0]?.bandcamp_art_url;
        if (!artUrl) continue;

        // Push to Shopify
        summary.imagePushAttempts++;
        try {
          await productCreateMedia(product.shopify_product_id, [
            {
              originalSource: artUrl,
              alt: product.title ?? "Album Art",
              mediaContentType: "IMAGE",
            },
          ]);

          // Insert DB row so catalog shows the image
          await supabase
            .from("warehouse_product_images")
            .insert({
              product_id: product.id,
              workspace_id: workspaceId,
              src: artUrl,
              alt: product.title ?? "Album Art",
              position: 0,
            })
            .select();

          // Update images JSONB
          await supabase
            .from("warehouse_products")
            .update({ images: [{ src: artUrl }] })
            .eq("id", product.id);

          summary.imagePushSuccesses++;
          logger.info("shopify-image-backfill: pushed bandcamp art to Shopify", {
            productId: product.id,
            shopifyProductId: product.shopify_product_id,
            artUrl,
          });
        } catch (err) {
          summary.imagePushFailures++;
          logger.warn("shopify-image-backfill: failed to push to Shopify (non-fatal)", {
            productId: product.id,
            shopifyProductId: product.shopify_product_id,
            error: String(err),
          });
        }
      }
    }

    logger.info("shopify-image-backfill: complete", { runId: ctx.run.id, ...summary });
    return summary;
  },
});
