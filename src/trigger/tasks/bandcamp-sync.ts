import { logger, schedules, task } from "@trigger.dev/sdk";
import type { BandcampBand, BandcampMerchItem } from "@/lib/clients/bandcamp";
import {
  assembleBandcampTitle,
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

        // Process matched items — update mappings
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
              bandcamp_image_url: merchItem.image_url ?? null,
              last_quantity_sold: merchItem.quantity_sold,
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "variant_id" },
          );
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
              ...(merchItem.image_url
                ? { media: [{ originalSource: merchItem.image_url, mediaContentType: "IMAGE" }] }
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
              image_url: merchItem.image_url ?? null,
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
          if (merchItem.image_url) {
            await supabase.from("warehouse_product_images").insert({
              product_id: product.id,
              src: merchItem.image_url,
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
              bandcamp_image_url: merchItem.image_url ?? null,
              bandcamp_type_name: merchItem.item_type,
              bandcamp_new_date: merchItem.new_date,
              last_quantity_sold: merchItem.quantity_sold,
              last_synced_at: new Date().toISOString(),
            });

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
