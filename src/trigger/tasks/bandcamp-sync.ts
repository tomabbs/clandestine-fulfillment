import { logger, schedules, task } from "@trigger.dev/sdk";
import type { BandcampBand, BandcampMerchItem } from "@/lib/clients/bandcamp";
import {
  assembleBandcampTitle,
  bandcampImageUrl,
  getMerchDetails,
  getMyBands,
  matchSkuToVariants,
  refreshBandcampToken,
} from "@/lib/clients/bandcamp";
import { fetchAlbumPage, parseTralbumData } from "@/lib/clients/bandcamp-scraper";
import { productSetCreate } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { bandcampScrapeQueue } from "@/trigger/lib/bandcamp-scrape-queue";
import { preorderSetupTask } from "@/trigger/tasks/preorder-setup";

// === Scrape task (Rule #60 — separate queue, concurrency 3) ===

export const bandcampScrapePageTask = task({
  id: "bandcamp-scrape-page",
  queue: bandcampScrapeQueue,
  run: async (payload: { url: string; mappingId: string; workspaceId: string }) => {
    const supabase = createServiceRoleClient();
    try {
      const html = await fetchAlbumPage(payload.url);
      const scraped = parseTralbumData(html);

      await supabase
        .from("bandcamp_product_mappings")
        .update({
          bandcamp_type_name: scraped.typeName,
          bandcamp_new_date: scraped.releaseDate,
          bandcamp_url: payload.url,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", payload.mappingId);

      // Propagate scraped release date to the linked variant
      const { data: mapping } = await supabase
        .from("bandcamp_product_mappings")
        .select("variant_id")
        .eq("id", payload.mappingId)
        .single();

      if (mapping?.variant_id) {
        const { data: variant } = await supabase
          .from("warehouse_product_variants")
          .select("id, street_date, is_preorder, product_id")
          .eq("id", mapping.variant_id)
          .single();

        if (variant) {
          // Backfill street_date if missing
          if (scraped.releaseDate && !variant.street_date) {
            const updates: Record<string, unknown> = {
              street_date: scraped.releaseDate,
              updated_at: new Date().toISOString(),
            };

            const streetDate = new Date(scraped.releaseDate);
            if (streetDate > new Date() && !variant.is_preorder) {
              updates.is_preorder = true;
            }

            await supabase.from("warehouse_product_variants").update(updates).eq("id", variant.id);

            if (updates.is_preorder === true) {
              await preorderSetupTask.trigger({
                variant_id: variant.id,
                workspace_id: payload.workspaceId,
              });
              logger.info("Triggered preorder-setup from scraper", {
                variantId: variant.id,
                releaseDate: scraped.releaseDate,
              });
            }
          }

          // Store album art + merch images in warehouse_product_images
          if (variant.product_id) {
            await storeScrapedImages(
              supabase,
              variant.product_id,
              payload.workspaceId,
              scraped,
              variant.id,
            );
          }
        }
      }

      if (scraped.metadataIncomplete) {
        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: payload.workspaceId,
            org_id: null,
            category: "bandcamp_scraper",
            severity: "low" as const,
            title: "Incomplete Bandcamp metadata",
            description: `Scraper could not extract full metadata from ${payload.url}. Type defaulted to "Merch".`,
            metadata: { url: payload.url, parser_version: scraped.parserVersion },
            status: "open" as const,
            group_key: `bandcamp_metadata_incomplete_${payload.mappingId}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
      }

      return { success: true, metadataIncomplete: scraped.metadataIncomplete };
    } catch (error) {
      logger.error("Scrape failed", { url: payload.url, error: String(error) });
      return { success: false, error: String(error) };
    }
  },
});

// === Image storage helper ===

import type { ScrapedAlbumData } from "@/lib/clients/bandcamp-scraper";

/**
 * Store album art as position=0 and merch product photos as position=1,2,3...
 * in warehouse_product_images. Matches the correct package by variant_id → SKU.
 * Merges with existing images — only adds scraped images whose src is not already present.
 */
async function storeScrapedImages(
  supabase: ReturnType<typeof createServiceRoleClient>,
  productId: string,
  workspaceId: string,
  scraped: ScrapedAlbumData,
  variantId: string,
) {
  // Fetch existing image srcs so we don't duplicate
  const { data: existingImages } = await supabase
    .from("warehouse_product_images")
    .select("src, position")
    .eq("product_id", productId)
    .order("position", { ascending: true });

  const existingSrcs = new Set((existingImages ?? []).map((i) => i.src));
  const nextPosition =
    (existingImages?.length ?? 0) > 0
      ? Math.max(...(existingImages ?? []).map((i) => i.position), -1) + 1
      : 0;

  const imagesToInsert: Array<{
    product_id: string;
    workspace_id: string;
    src: string;
    alt: string | null;
    position: number;
  }> = [];

  let position = nextPosition;

  // Album art (cover image shared across all packages) — only if not already present
  if (scraped.albumArtUrl && !existingSrcs.has(scraped.albumArtUrl)) {
    imagesToInsert.push({
      product_id: productId,
      workspace_id: workspaceId,
      src: scraped.albumArtUrl,
      alt: scraped.title ? `${scraped.title} - Album Art` : "Album Art",
      position: position++,
    });
  }

  // Find the matching package for this variant by looking up the variant's SKU
  const { data: variantData } = await supabase
    .from("warehouse_product_variants")
    .select("sku")
    .eq("id", variantId)
    .single();

  const variantSku = variantData?.sku;
  const matchedPkg = variantSku ? scraped.packages.find((p) => p.sku === variantSku) : null;

  if (matchedPkg) {
    // Primary merch image (the main package photo) — only if not already present
    if (matchedPkg.imageUrl && !existingSrcs.has(matchedPkg.imageUrl)) {
      imagesToInsert.push({
        product_id: productId,
        workspace_id: workspaceId,
        src: matchedPkg.imageUrl,
        alt: matchedPkg.title ? `${matchedPkg.title} - Product Photo` : "Product Photo",
        position: position++,
      });
    }

    // Additional merch arts (extra product photos)
    for (const art of matchedPkg.arts) {
      if (art.imageId === matchedPkg.imageId) continue;
      if (existingSrcs.has(art.url)) continue;

      imagesToInsert.push({
        product_id: productId,
        workspace_id: workspaceId,
        src: art.url,
        alt: matchedPkg.title ? `${matchedPkg.title} - Photo` : "Product Photo",
        position: position++,
      });
    }
  }

  if (imagesToInsert.length === 0) return;

  const { error } = await supabase.from("warehouse_product_images").insert(imagesToInsert);

  if (error) {
    logger.warn("Failed to insert scraped images", {
      productId,
      imageCount: imagesToInsert.length,
      error: error.message,
    });
    return;
  }

  // Update product.images JSONB for legacy compatibility — merge with existing
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("images")
    .eq("id", productId)
    .single();

  const existingImagesJson =
    (product?.images as Array<{ src: string; alt?: string; position?: number }> | null) ?? [];
  const newImagesJson = imagesToInsert.map((img) => ({
    src: img.src,
    alt: img.alt,
    position: img.position,
  }));
  const mergedImages = [...existingImagesJson, ...newImagesJson].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );

  await supabase
    .from("warehouse_products")
    .update({ images: mergedImages, updated_at: new Date().toISOString() })
    .eq("id", productId);

  logger.info("Stored scraped images", {
    productId,
    imageCount: imagesToInsert.length,
    hasAlbumArt: !!scraped.albumArtUrl,
    hasMerchImages: (matchedPkg?.arts.length ?? 0) > 0,
  });
}

// === Main sync task (Rule #9 — serialized API access via bandcampQueue) ===

export const bandcampSyncTask = task({
  id: "bandcamp-sync",
  queue: bandcampQueue,
  maxDuration: 600,
  run: async (payload: { workspaceId: string }) => {
    const supabase = createServiceRoleClient();
    const { workspaceId } = payload;

    // Log sync start
    const { data: syncLog } = await supabase
      .from("channel_sync_log")
      .insert({
        workspace_id: workspaceId,
        channel: "bandcamp",
        sync_type: "merch_sync",
        status: "started",
        items_processed: 0,
        items_failed: 0,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    const syncLogId = syncLog?.id;
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      // Step 1: Refresh token
      const accessToken = await refreshBandcampToken(workspaceId);
      logger.info("Token refreshed", { workspaceId });

      // Step 2: Get bands and cache
      const bands = await getMyBands(accessToken);
      logger.info("Got bands", { count: bands.length });

      // Build band lookup from member_bands
      const bandLookup = new Map<number, BandcampBand>();
      for (const band of bands) {
        bandLookup.set(band.band_id, band);
        if (band.member_bands) {
          for (const mb of band.member_bands) {
            bandLookup.set(mb.band_id, { ...mb, member_bands: [] });
          }
        }
      }

      // Step 3: Get all connections for this workspace
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections?.length) {
        logger.info("No active Bandcamp connections");
        return;
      }

      for (const connection of connections) {
        // Update member_bands_cache
        const band = bandLookup.get(connection.band_id);
        if (band) {
          await supabase
            .from("bandcamp_connections")
            .update({
              member_bands_cache: band as unknown as Record<string, unknown>,
              band_name: band.name,
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id);
        }

        // Get merch details for this band
        let merchItems: BandcampMerchItem[];
        try {
          merchItems = await getMerchDetails(connection.band_id, accessToken);
        } catch (error) {
          logger.error("Failed to get merch details", {
            bandId: connection.band_id,
            error: String(error),
          });
          itemsFailed++;
          continue;
        }

        // Get existing variants for SKU matching
        const { data: variants } = await supabase
          .from("warehouse_product_variants")
          .select("id, sku")
          .eq("workspace_id", workspaceId);

        const { matched, unmatched } = matchSkuToVariants(merchItems, variants ?? []);

        // Process matched items — update mappings + backfill price/images
        for (const { merchItem, variantId } of matched) {
          await supabase.from("bandcamp_product_mappings").upsert(
            {
              workspace_id: workspaceId,
              variant_id: variantId,
              bandcamp_item_id: merchItem.package_id,
              bandcamp_item_type: merchItem.item_type?.toLowerCase().includes("album")
                ? "album"
                : "package",
              bandcamp_member_band_id: merchItem.member_band_id,
              bandcamp_url: merchItem.url,
              bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
              last_quantity_sold: merchItem.quantity_sold,
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "variant_id" },
          );

          // Backfill price/cost/street_date on variant if missing
          {
            const { data: existingVar } = await supabase
              .from("warehouse_product_variants")
              .select("id, price, cost, product_id, street_date, is_preorder")
              .eq("id", variantId)
              .single();

            if (existingVar) {
              const updates: Record<string, unknown> = {};

              // Update price if null or 0
              if (
                (existingVar.price == null || existingVar.price === 0) &&
                merchItem.price != null
              ) {
                updates.price = merchItem.price;
              }
              if ((existingVar.cost == null || existingVar.cost === 0) && merchItem.price != null) {
                const p = (updates.price as number | undefined) ?? merchItem.price;
                updates.cost = Math.round(p * 0.5 * 100) / 100;
              }

              // Backfill street_date from Bandcamp new_date
              if (!existingVar.street_date && merchItem.new_date) {
                updates.street_date = merchItem.new_date;
              }

              // Detect preorder: if street_date is in the future and not already a preorder
              const effectiveStreetDate =
                (updates.street_date as string | undefined) ?? existingVar.street_date;
              if (effectiveStreetDate && !existingVar.is_preorder) {
                const streetDate = new Date(effectiveStreetDate);
                if (streetDate > new Date()) {
                  updates.is_preorder = true;
                }
              }

              if (Object.keys(updates).length > 0) {
                updates.updated_at = new Date().toISOString();
                await supabase
                  .from("warehouse_product_variants")
                  .update(updates)
                  .eq("id", variantId);

                // Trigger preorder setup if variant just became a preorder
                if (updates.is_preorder === true) {
                  await preorderSetupTask.trigger({
                    variant_id: variantId,
                    workspace_id: workspaceId,
                  });
                  logger.info("Triggered preorder-setup for matched variant", {
                    variantId,
                    streetDate: effectiveStreetDate,
                  });
                }
              }

              // Backfill image on product if Bandcamp has one and product doesn't
              if (bandcampImageUrl(merchItem.image_url) && existingVar.product_id) {
                const { count: imgCount } = await supabase
                  .from("warehouse_product_images")
                  .select("id", { count: "exact", head: true })
                  .eq("product_id", existingVar.product_id);

                if ((imgCount ?? 0) === 0) {
                  const { error: imgErr } = await supabase.from("warehouse_product_images").insert({
                    product_id: existingVar.product_id,
                    workspace_id: workspaceId,
                    src: bandcampImageUrl(merchItem.image_url),
                    alt: merchItem.title,
                    position: 0,
                  });
                  if (imgErr) {
                    logger.warn("Failed to insert Bandcamp image", {
                      productId: existingVar.product_id,
                      error: imgErr.message,
                    });
                  }
                  await supabase
                    .from("warehouse_products")
                    .update({ images: [{ src: bandcampImageUrl(merchItem.image_url) }] })
                    .eq("id", existingVar.product_id);
                }
              }
            }
          }

          itemsProcessed++;

          // Scrape album page if URL available (Rule #60)
          if (merchItem.url) {
            const { data: mapping } = await supabase
              .from("bandcamp_product_mappings")
              .select("id")
              .eq("variant_id", variantId)
              .single();

            if (mapping) {
              await bandcampScrapePageTask.trigger({
                url: merchItem.url,
                mappingId: mapping.id,
                workspaceId,
              });
            }
          }
        }

        // Process unmatched items with SKU — auto-create DRAFT Shopify products (Rule #8)
        for (const merchItem of unmatched) {
          if (!merchItem.sku) continue;

          const artistName = band?.name ?? connection.band_name ?? "Unknown Artist";
          const title = assembleBandcampTitle(artistName, merchItem.album_title, merchItem.title);

          // Determine tags
          const tags: string[] = [];
          if (merchItem.new_date) {
            const streetDate = new Date(merchItem.new_date);
            if (streetDate > new Date()) {
              tags.push("Pre-Orders", "New Releases");
            }
          }

          // Check for existing product with this SKU to prevent duplicates
          const { data: existingVariant } = await supabase
            .from("warehouse_product_variants")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("sku", merchItem.sku)
            .maybeSingle();

          if (existingVariant) {
            logger.info("SKU already exists, skipping creation", { sku: merchItem.sku });
            continue;
          }

          // Rule #1: productSet for CREATE only — create DRAFT Shopify product
          let shopifyProductId: string | null = null;
          try {
            shopifyProductId = await productSetCreate({
              title,
              status: "DRAFT",
              vendor: band?.name ?? connection.band_name,
              productType: merchItem.item_type ?? "Merch",
              tags,
              productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
              variants: [
                {
                  optionValues: [{ optionName: "Title", name: "Default Title" }],
                  sku: merchItem.sku,
                  inventoryPolicy: "DENY",
                },
              ],
              ...(bandcampImageUrl(merchItem.image_url)
                ? {
                    media: [
                      {
                        originalSource: bandcampImageUrl(merchItem.image_url),
                        mediaContentType: "IMAGE",
                      },
                    ],
                  }
                : {}),
            });
            logger.info("Created Shopify DRAFT product", { sku: merchItem.sku, shopifyProductId });
          } catch (shopifyError) {
            logger.error("Failed to create Shopify product, continuing with warehouse-only", {
              sku: merchItem.sku,
              error: String(shopifyError),
            });
          }

          // Create warehouse product as DRAFT
          const { data: product, error: productError } = await supabase
            .from("warehouse_products")
            .insert({
              workspace_id: workspaceId,
              org_id: connection.org_id,
              shopify_product_id: shopifyProductId,
              title,
              vendor: band?.name ?? connection.band_name,
              product_type: merchItem.item_type ?? "Merch",
              status: "draft",
              tags,
              image_url: bandcampImageUrl(merchItem.image_url) ?? null,
            })
            .select("id")
            .single();

          if (productError || !product) {
            logger.error("Failed to create product", {
              sku: merchItem.sku,
              error: productError?.message,
            });
            itemsFailed++;
            continue;
          }

          // Store Bandcamp image as warehouse_product_images row
          if (bandcampImageUrl(merchItem.image_url)) {
            await supabase.from("warehouse_product_images").insert({
              product_id: product.id,
              src: bandcampImageUrl(merchItem.image_url),
              alt: title,
              position: 0,
            });
          }

          // Create variant — save Bandcamp price, default cost to 50% of price
          const bcPrice = merchItem.price ?? null;
          const bcCost = bcPrice != null ? Math.round(bcPrice * 0.5 * 100) / 100 : null;
          const { data: newVariant } = await supabase
            .from("warehouse_product_variants")
            .insert({
              product_id: product.id,
              workspace_id: workspaceId,
              sku: merchItem.sku,
              title: merchItem.title,
              price: bcPrice,
              cost: bcCost,
              bandcamp_url: merchItem.url,
              street_date: merchItem.new_date,
              is_preorder: tags.includes("Pre-Orders"),
            })
            .select("id")
            .single();

          if (newVariant) {
            // Seed initial inventory from Bandcamp quantity_available
            const initialAvailable = merchItem.quantity_available ?? 0;
            await supabase.from("warehouse_inventory_levels").upsert(
              {
                variant_id: newVariant.id,
                workspace_id: workspaceId,
                sku: merchItem.sku,
                available: initialAvailable,
                committed: 0,
                incoming: 0,
                last_redis_write_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "variant_id", ignoreDuplicates: true },
            );
            logger.info("Seeded initial inventory", {
              sku: merchItem.sku,
              available: initialAvailable,
            });

            // Create mapping
            await supabase.from("bandcamp_product_mappings").insert({
              workspace_id: workspaceId,
              variant_id: newVariant.id,
              bandcamp_item_id: merchItem.package_id,
              bandcamp_item_type: merchItem.item_type?.toLowerCase().includes("album")
                ? "album"
                : "package",
              bandcamp_member_band_id: merchItem.member_band_id,
              bandcamp_url: merchItem.url,
              bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
              bandcamp_type_name: merchItem.item_type,
              bandcamp_new_date: merchItem.new_date,
              last_quantity_sold: merchItem.quantity_sold,
              last_synced_at: new Date().toISOString(),
            });

            // Trigger preorder setup on Shopify if this is a preorder
            if (tags.includes("Pre-Orders")) {
              await preorderSetupTask.trigger({
                variant_id: newVariant.id,
                workspace_id: workspaceId,
              });
              logger.info("Triggered preorder-setup", { sku: merchItem.sku });
            }

            // Scrape if URL available
            if (merchItem.url) {
              const { data: mapping } = await supabase
                .from("bandcamp_product_mappings")
                .select("id")
                .eq("variant_id", newVariant.id)
                .single();

              if (mapping) {
                await bandcampScrapePageTask.trigger({
                  url: merchItem.url,
                  mappingId: mapping.id,
                  workspaceId,
                });
              }
            }
          }

          itemsProcessed++;
        }

        // Update connection last_synced_at
        await supabase
          .from("bandcamp_connections")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", connection.id);
      }

      // Rule #35: Check scraper success rate per account
      // (scrape results come back async, but we track failures inline)
      if (itemsFailed > 0 && itemsProcessed > 0) {
        const failureRate = itemsFailed / (itemsProcessed + itemsFailed);
        if (failureRate > 0.2) {
          await supabase.from("warehouse_review_queue").upsert(
            {
              workspace_id: workspaceId,
              org_id: null,
              category: "bandcamp_scraper",
              severity: "high" as const,
              title: "Bandcamp scraper failure rate >20%",
              description: `${itemsFailed}/${itemsProcessed + itemsFailed} items failed during sync.`,
              metadata: { items_processed: itemsProcessed, items_failed: itemsFailed },
              status: "open" as const,
              group_key: `bandcamp_scraper_health_${workspaceId}`,
              occurrence_count: 1,
            },
            { onConflict: "group_key", ignoreDuplicates: false },
          );
        }
      }

      // Update sync log
      if (syncLogId) {
        await supabase
          .from("channel_sync_log")
          .update({
            status: itemsFailed > 0 ? "partial" : "completed",
            items_processed: itemsProcessed,
            items_failed: itemsFailed,
            completed_at: new Date().toISOString(),
          })
          .eq("id", syncLogId);
      }

      logger.info("Bandcamp sync complete", { itemsProcessed, itemsFailed });
    } catch (error) {
      // Update sync log on failure
      if (syncLogId) {
        await supabase
          .from("channel_sync_log")
          .update({
            status: "failed",
            items_processed: itemsProcessed,
            items_failed: itemsFailed,
            error_message: String(error),
            completed_at: new Date().toISOString(),
          })
          .eq("id", syncLogId);
      }

      // Rule #24: create review queue item instead of just crashing
      await supabase.from("warehouse_review_queue").upsert(
        {
          workspace_id: workspaceId,
          org_id: null,
          category: "bandcamp_sync",
          severity: "high" as const,
          title: "Bandcamp sync failed",
          description: String(error),
          metadata: { items_processed: itemsProcessed, items_failed: itemsFailed },
          status: "open" as const,
          group_key: `bandcamp_sync_failure_${workspaceId}`,
          occurrence_count: 1,
        },
        { onConflict: "group_key", ignoreDuplicates: false },
      );

      throw error;
    }
  },
});

// === Cron schedule: every 30 minutes ===

export const bandcampSyncSchedule = schedules.task({
  id: "bandcamp-sync-cron",
  cron: "*/30 * * * *",
  queue: bandcampQueue,
  run: async () => {
    const supabase = createServiceRoleClient();

    // Get all workspaces with Bandcamp credentials
    const { data: credentials } = await supabase
      .from("bandcamp_credentials")
      .select("workspace_id")
      .not("refresh_token", "is", null);

    if (!credentials?.length) {
      logger.info("No Bandcamp credentials configured");
      return;
    }

    for (const cred of credentials) {
      await bandcampSyncTask.trigger({ workspaceId: cred.workspace_id });
    }
  },
});
