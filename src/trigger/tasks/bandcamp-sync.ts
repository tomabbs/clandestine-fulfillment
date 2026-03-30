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
import type { ScrapedAlbumData } from "@/lib/clients/bandcamp-scraper";
import {
  BandcampFetchError,
  bandcampAlbumArtUrl,
  bandcampMerchImageUrl,
  buildBandcampAlbumUrl,
  fetchBandcampPage,
  parseBandcampPage,
} from "@/lib/clients/bandcamp-scraper";
import { productSetCreate } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { bandcampScrapeQueue } from "@/trigger/lib/bandcamp-scrape-queue";
import { preorderSetupTask } from "@/trigger/tasks/preorder-setup";

// ─── Package matching ─────────────────────────────────────────────────────────
// Priority: exact SKU → format keyword on typeName → no match.
// Step 0 confirmed: SKUs in packages match warehouse SKUs (LP-NS-167, CD-NS-167).
// type_id is available (1=CD, 3=Cassette, 15=2xLP) but typeName string matching
// is more readable. Single-package fallback removed — risked wrong package match.

const FORMAT_KEYWORDS = [
  // Music formats
  "lp", "vinyl", "cd", "cassette", "tape", '7"', '10"', '12"',
  // Apparel and merch
  "shirt", "t-shirt", "tee", "hoodie", "hat", "beanie", "poster", "print",
];

function findMatchingPackage(
  packages: ScrapedAlbumData["packages"],
  variantSku: string | null,
  variantTitle: string | null,
): ScrapedAlbumData["packages"][number] | null {
  // 1. Exact SKU match — most reliable (confirmed working in Step 0)
  if (variantSku) {
    const bySku = packages.find((p) => p.sku === variantSku);
    if (bySku) return bySku;
  }

  // 2. Format keyword match on variant title vs package typeName
  if (variantTitle) {
    const vtLower = variantTitle.toLowerCase();
    const keyword = FORMAT_KEYWORDS.find((k) => vtLower.includes(k));
    if (keyword) {
      const byKeyword = packages.find((p) => p.typeName?.toLowerCase().includes(keyword));
      if (byKeyword) return byKeyword;
    }
  }

  return null;
}

// === Scraper task ===
// Rule #60 — separate queue with concurrency 3 + rate limit 1 req/sec

export const bandcampScrapePageTask = task({
  id: "bandcamp-scrape-page",
  queue: bandcampScrapeQueue,
  run: async (payload: {
    url: string;
    mappingId: string;
    workspaceId: string;
    urlIsConstructed?: boolean;
    albumTitle?: string;
    urlSource?: "orders_api" | "constructed" | "manual";
  }) => {
    const supabase = createServiceRoleClient();
    // #region agent log
    await supabase.from("channel_sync_log").insert({ workspace_id: payload.workspaceId, channel: "bandcamp", sync_type: "debug_scrape_entry", status: "started", items_processed: 0, items_failed: 0, started_at: new Date().toISOString(), metadata: { url: payload.url, mappingId: payload.mappingId, urlIsConstructed: payload.urlIsConstructed ?? false, urlSource: payload.urlSource ?? "unknown" } } as never);
    // #endregion
    try {
      const html = await fetchBandcampPage(payload.url);
      const scraped = parseBandcampPage(html);

      // #region agent log
      await supabase.from("channel_sync_log").insert({ workspace_id: payload.workspaceId, channel: "bandcamp", sync_type: "debug_scrape_parsed", status: scraped ? "completed" : "failed", items_processed: scraped?.packages?.length ?? 0, items_failed: 0, started_at: new Date().toISOString(), metadata: { url: payload.url, scrapedNull: scraped === null, albumArtUrl: scraped?.albumArtUrl ?? null, packagesCount: scraped?.packages?.length ?? 0, pkg0TypeName: scraped?.packages?.[0]?.typeName ?? null } } as never);
      // #endregion
      if (!scraped) {
        // data-tralbum attribute not found — may not be an album page
        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: payload.workspaceId,
            org_id: null,
            category: "bandcamp_scraper",
            severity: "medium" as const,
            title: "data-tralbum attribute not found",
            description: `Could not parse data-tralbum from ${payload.url}. Page may not be an album page.`,
            metadata: { url: payload.url, mappingId: payload.mappingId },
            status: "open" as const,
            group_key: `bc_no_tralbum_${payload.mappingId}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
        return { success: false, reason: "no_tralbum" };
      }

      // Write scraped metadata — update mapping with all data-tralbum fields
      const { error: updateErr } = await supabase
        .from("bandcamp_product_mappings")
        .update({
          bandcamp_url:          payload.url,
          bandcamp_url_source:   "scraper_verified",
          bandcamp_type_name:    scraped.packages[0]?.typeName ?? null,
          bandcamp_new_date:     scraped.releaseDate
            ? scraped.releaseDate.toISOString().slice(0, 10)
            : null,
          bandcamp_release_date: scraped.releaseDate?.toISOString() ?? null,
          bandcamp_is_preorder:  scraped.isPreorder,
          bandcamp_art_url:      scraped.albumArtUrl,
          last_synced_at:        new Date().toISOString(),
          updated_at:            new Date().toISOString(),
        })
        .eq("id", payload.mappingId);
      // #region agent log
      await supabase.from("channel_sync_log").insert({ workspace_id: payload.workspaceId, channel: "bandcamp", sync_type: "debug_scrape_updated", status: updateErr ? "failed" : "completed", items_processed: 1, items_failed: updateErr ? 1 : 0, started_at: new Date().toISOString(), error_message: updateErr?.message ?? null, metadata: { mappingId: payload.mappingId, updateError: updateErr?.message ?? null, typeName: scraped.packages[0]?.typeName ?? null, artUrl: scraped.albumArtUrl } } as never);
      // #endregion

      // Propagate to linked variant
      const { data: mapping } = await supabase
        .from("bandcamp_product_mappings")
        .select("variant_id")
        .eq("id", payload.mappingId)
        .single();

      if (mapping?.variant_id) {
        const { data: variant } = await supabase
          .from("warehouse_product_variants")
          .select("id, street_date, is_preorder, product_id, title")
          .eq("id", mapping.variant_id)
          .single();

        if (variant) {
          const updates: Record<string, unknown> = {};

          if (scraped.releaseDate && !variant.street_date) {
            updates.street_date = scraped.releaseDate.toISOString().slice(0, 10);
          }
          if (scraped.isPreorder && !variant.is_preorder) {
            updates.is_preorder = true;
          }

          if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString();
            await supabase
              .from("warehouse_product_variants")
              .update(updates)
              .eq("id", variant.id);

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

          // Store album art + primary merch image
          if (variant.product_id) {
            await storeScrapedImages(
              supabase,
              variant.product_id,
              payload.workspaceId,
              scraped,
              variant.id,
              variant.title,
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
            description: `Scraper could not extract release_date or packages from ${payload.url}.`,
            metadata: { url: payload.url, mappingId: payload.mappingId },
            status: "open" as const,
            group_key: `bandcamp_metadata_incomplete_${payload.mappingId}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
      }

      return { success: true, metadataIncomplete: scraped.metadataIncomplete };
    } catch (error) {
      // Typed check — no String(error).includes("404")
      const is404 = error instanceof BandcampFetchError && error.status === 404;

      logger.error("Scrape failed", {
        url: payload.url,
        urlIsConstructed: payload.urlIsConstructed,
        status: error instanceof BandcampFetchError ? error.status : undefined,
        error: String(error),
      });

      if (is404 && payload.urlIsConstructed) {
        // Constructed slug was wrong — log for manual correction, don't retry
        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: payload.workspaceId,
            org_id: null,
            category: "bandcamp_scraper",
            severity: "low" as const,
            title: "Constructed Bandcamp URL returned 404",
            description: `URL: ${payload.url}. Album slug may not match. Set bandcamp_url manually.`,
            metadata: {
              url: payload.url,
              mappingId: payload.mappingId,
              album_title: payload.albumTitle,
            },
            status: "open" as const,
            group_key: `bc_scrape_404_${payload.mappingId}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
        return { success: false, reason: "404_constructed_url" };
      }

      // Non-404 or API-sourced URL failures → throw so Trigger.dev retries
      // For all BandcampFetchError (any HTTP error from Bandcamp including 403/429 blocking
      // from cloud server IPs), log to review queue instead of silently retrying forever.
      // This provides visibility + stops the retry loop for known permanent failures.
      if (error instanceof BandcampFetchError) {
        const httpStatus = error.status;
        const isBlockedByCloudflare = httpStatus === 403 || httpStatus === 429 || httpStatus === 503;

        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: payload.workspaceId,
            org_id: null,
            category: "bandcamp_scraper",
            severity: isBlockedByCloudflare ? "medium" as const : "low" as const,
            title: `Bandcamp fetch error HTTP ${httpStatus}: ${payload.url.slice(0, 60)}`,
            description: `${isBlockedByCloudflare ? "Bandcamp may be blocking cloud IPs. " : ""}URL: ${payload.url}. Error: ${String(error).slice(0, 200)}`,
            metadata: {
              url: payload.url,
              mappingId: payload.mappingId,
              httpStatus,
              urlIsConstructed: payload.urlIsConstructed,
              urlSource: payload.urlSource,
            },
            status: "open" as const,
            group_key: `bc_scrape_http_${httpStatus}_${payload.mappingId}`,
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );

        // Don't retry cloud-blocking errors — they won't resolve on retry
        if (isBlockedByCloudflare) {
          return { success: false, reason: `blocked_http_${httpStatus}` };
        }
      }

      throw error;
    }
  },
});

// === Image storage helper ===
// Stores album art (1200px) and primary merch image.
// Step 0 confirmed: pkg.image_id is always NULL; primary image = arts[0].imageId.

async function storeScrapedImages(
  supabase: ReturnType<typeof createServiceRoleClient>,
  productId: string,
  workspaceId: string,
  scraped: ScrapedAlbumData,
  variantId: string,
  variantTitle: string | null,
) {
  const { data: existingImages } = await supabase
    .from("warehouse_product_images")
    .select("src, position")
    .eq("product_id", productId)
    .order("position", { ascending: true });

  const existingSrcs = new Set((existingImages ?? []).map((i) => i.src));
  let position =
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

  // Album art (1200px via "a" prefix URL)
  if (scraped.albumArtUrl && !existingSrcs.has(scraped.albumArtUrl)) {
    imagesToInsert.push({
      product_id: productId,
      workspace_id: workspaceId,
      src: scraped.albumArtUrl,
      alt: scraped.title ? `${scraped.title} - Album Art` : "Album Art",
      position: position++,
    });
  }

  // Primary merch image from matched package
  const { data: variantData } = await supabase
    .from("warehouse_product_variants")
    .select("sku")
    .eq("id", variantId)
    .single();

  const matchedPkg = findMatchingPackage(
    scraped.packages,
    variantData?.sku ?? null,
    variantTitle,
  );

  if (matchedPkg?.imageUrl && !existingSrcs.has(matchedPkg.imageUrl)) {
    imagesToInsert.push({
      product_id: productId,
      workspace_id: workspaceId,
      src: matchedPkg.imageUrl,
      alt: matchedPkg.typeName ? `${matchedPkg.typeName} - Product Photo` : "Product Photo",
      position: position++,
    });
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

  // Sync to product.images JSONB for legacy compatibility
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("images")
    .eq("id", productId)
    .single();

  const existingJson =
    (product?.images as Array<{ src: string; alt?: string; position?: number }> | null) ?? [];
  const mergedImages = [
    ...existingJson,
    ...imagesToInsert.map((img) => ({ src: img.src, alt: img.alt, position: img.position })),
  ].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  await supabase
    .from("warehouse_products")
    .update({ images: mergedImages, updated_at: new Date().toISOString() })
    .eq("id", productId);

  logger.info("Stored scraped images", {
    productId,
    imageCount: imagesToInsert.length,
    hasAlbumArt: !!scraped.albumArtUrl,
    packageMatched: !!matchedPkg,
  });
}

// === Scrape trigger helper ===
// Used in both matched and unmatched paths to avoid code duplication.

async function triggerScrapeIfNeeded(
  supabase: ReturnType<typeof createServiceRoleClient>,
  variantId: string,
  workspaceId: string,
  band: BandcampBand | undefined,
  connection: { band_url?: string | null },
  merchItem: { url?: string | null; album_title?: string | null },
) {
  // Idempotency: only trigger if missing url or type_name
  const { data: mapping } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_url, bandcamp_type_name")
    .eq("variant_id", variantId)
    .single();

  if (!mapping) return;

  const needsScrape = !mapping.bandcamp_url || !mapping.bandcamp_type_name;
  // #region agent log — only log when needsScrape=true to avoid flooding
  if (needsScrape) {
    supabase.from("channel_sync_log").insert({ workspace_id: workspaceId, channel: "bandcamp", sync_type: "debug_scrape_needed", status: "started", items_processed: 0, items_failed: 0, started_at: new Date().toISOString(), metadata: { variantId: variantId.slice(0,8), mappingId: mapping.id.slice(0,8), hasUrl: !!mapping.bandcamp_url, hasTypeName: !!mapping.bandcamp_type_name } } as never).then(() => {}).catch(() => {});
  }
  // #endregion
  if (!needsScrape) return;

  const bandSubdomain =
    band?.subdomain ??
    (connection.band_url ?? "").replace("https://", "").split(".")[0] ??
    null;

  const apiUrl = (merchItem.url as string | null | undefined) ?? null;
  const existingUrl = mapping.bandcamp_url ?? null;
  const constructedUrl =
    bandSubdomain && merchItem.album_title
      ? buildBandcampAlbumUrl(bandSubdomain, merchItem.album_title)
      : null;

  const scrapeUrl = apiUrl ?? existingUrl ?? constructedUrl;
  if (!scrapeUrl) {
    logger.warn("No scrape URL available for variant", {
      variantId,
      album_title: merchItem.album_title,
      bandSubdomain,
    });
    return;
  }

  const urlSource: "orders_api" | "constructed" = apiUrl ? "orders_api" : "constructed";
  const urlIsConstructed = !apiUrl && !existingUrl;

  // Record url source before triggering (so review queue 404 items have context)
  if (!existingUrl) {
    await supabase
      .from("bandcamp_product_mappings")
      .update({
        bandcamp_url:        scrapeUrl,
        bandcamp_url_source: urlSource,
        updated_at:          new Date().toISOString(),
      })
      .eq("id", mapping.id);
  }

  await bandcampScrapePageTask.trigger({
    url: scrapeUrl,
    mappingId: mapping.id,
    workspaceId,
    urlIsConstructed,
    albumTitle: merchItem.album_title ?? undefined,
    urlSource,
  });
}

// === Main sync task ===
// Rule #9 — serialized API access via bandcampQueue

export const bandcampSyncTask = task({
  id: "bandcamp-sync",
  queue: bandcampQueue,
  maxDuration: 600,
  run: async (payload: { workspaceId: string }) => {
    const supabase = createServiceRoleClient();
    const { workspaceId } = payload;

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
      const accessToken = await refreshBandcampToken(workspaceId);
      logger.info("Token refreshed", { workspaceId });

      const bands = await getMyBands(accessToken);
      logger.info("Got bands", { count: bands.length });

      const bandLookup = new Map<number, BandcampBand>();
      for (const band of bands) {
        bandLookup.set(band.band_id, band);
        if (band.member_bands) {
          for (const mb of band.member_bands) {
            bandLookup.set(mb.band_id, { ...mb, member_bands: [] });
          }
        }
      }

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
        const band = bandLookup.get(connection.band_id);

        // Persist subdomain to band_url if not already set
        if (band) {
          const updatePayload: Record<string, unknown> = {
            member_bands_cache: band as unknown as Record<string, unknown>,
            band_name: band.name,
            updated_at: new Date().toISOString(),
          };
          if (band.subdomain && !connection.band_url) {
            updatePayload.band_url = `https://${band.subdomain}.bandcamp.com`;
          }
          await supabase
            .from("bandcamp_connections")
            .update(updatePayload)
            .eq("id", connection.id);
        }

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

        const { data: variants } = await supabase
          .from("warehouse_product_variants")
          .select("id, sku")
          .eq("workspace_id", workspaceId);

        const { matched, unmatched } = matchSkuToVariants(merchItems, variants ?? []);

        // ── Matched items ──────────────────────────────────────────────────────

        for (const { merchItem, variantId } of matched) {
          await supabase.from("bandcamp_product_mappings").upsert(
            {
              workspace_id:            workspaceId,
              variant_id:              variantId,
              bandcamp_item_id:        merchItem.package_id,
              bandcamp_item_type:      merchItem.item_type?.toLowerCase().includes("album")
                ? "album"
                : "package",
              bandcamp_member_band_id: merchItem.member_band_id,
              bandcamp_image_url:      bandcampImageUrl(merchItem.image_url) ?? null,
              last_quantity_sold:      merchItem.quantity_sold,
              last_synced_at:          new Date().toISOString(),
              updated_at:              new Date().toISOString(),
            },
            { onConflict: "variant_id" },
          );

          // Backfill price/cost/street_date from API if missing
          const { data: existingVar } = await supabase
            .from("warehouse_product_variants")
            .select("id, price, cost, product_id, street_date, is_preorder")
            .eq("id", variantId)
            .single();

          if (existingVar) {
            const updates: Record<string, unknown> = {};

            if (
              (existingVar.price == null || existingVar.price === 0) &&
              merchItem.price != null
            ) {
              updates.price = merchItem.price;
            }
            if (
              (existingVar.cost == null || existingVar.cost === 0) &&
              merchItem.price != null
            ) {
              const p = (updates.price as number | undefined) ?? merchItem.price;
              updates.cost = Math.round(p * 0.5 * 100) / 100;
            }
            if (!existingVar.street_date && merchItem.new_date) {
              updates.street_date = merchItem.new_date;
            }
            const effectiveDate =
              (updates.street_date as string | undefined) ?? existingVar.street_date;
            if (effectiveDate && !existingVar.is_preorder && new Date(effectiveDate) > new Date()) {
              updates.is_preorder = true;
            }

            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString();
              await supabase
                .from("warehouse_product_variants")
                .update(updates)
                .eq("id", variantId);

              if (updates.is_preorder === true) {
                await preorderSetupTask.trigger({
                  variant_id: variantId,
                  workspace_id: workspaceId,
                });
              }
            }

            // API image backfill — only if product has no images yet
            if (bandcampImageUrl(merchItem.image_url) && existingVar.product_id) {
              const { count: imgCount } = await supabase
                .from("warehouse_product_images")
                .select("id", { count: "exact", head: true })
                .eq("product_id", existingVar.product_id);

              if ((imgCount ?? 0) === 0) {
                await supabase.from("warehouse_product_images").insert({
                  product_id:   existingVar.product_id,
                  workspace_id: workspaceId,
                  src:          bandcampImageUrl(merchItem.image_url),
                  alt:          merchItem.title,
                  position:     0,
                });
                await supabase
                  .from("warehouse_products")
                  .update({ images: [{ src: bandcampImageUrl(merchItem.image_url) }] })
                  .eq("id", existingVar.product_id);
              }
            }
          }

          itemsProcessed++;

          // Trigger scrape if mapping is incomplete (idempotency guard in helper)
          await triggerScrapeIfNeeded(
            supabase,
            variantId,
            workspaceId,
            band,
            connection,
            merchItem,
          );
        }

        // ── Unmatched items — auto-create DRAFT products ───────────────────────

        for (const merchItem of unmatched) {
          if (!merchItem.sku) continue;

          const artistName = band?.name ?? connection.band_name ?? "Unknown Artist";
          const title = assembleBandcampTitle(artistName, merchItem.album_title, merchItem.title);
          const tags: string[] = [];
          if (merchItem.new_date && new Date(merchItem.new_date) > new Date()) {
            tags.push("Pre-Orders", "New Releases");
          }

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
            await supabase.from("warehouse_review_queue").upsert(
              {
                workspace_id: workspaceId,
                org_id: connection.org_id ?? null,
                category: "shopify_product_create",
                severity: "medium" as const,
                title: `Shopify product creation failed: ${title}`,
                description: `SKU ${merchItem.sku} was created in the warehouse but productSetCreate failed.`,
                metadata: {
                  sku: merchItem.sku,
                  bandcamp_item_id: String(merchItem.package_id),
                  band_id: String(connection.band_id),
                  error: String(shopifyError),
                },
                status: "open" as const,
                group_key: `shopify_create_failed_${merchItem.sku}`,
                occurrence_count: 1,
              },
              { onConflict: "group_key", ignoreDuplicates: false },
            );
          }

          const { data: product, error: productError } = await supabase
            .from("warehouse_products")
            .insert({
              workspace_id:       workspaceId,
              org_id:             connection.org_id,
              shopify_product_id: shopifyProductId,
              title,
              vendor:             band?.name ?? connection.band_name,
              product_type:       merchItem.item_type ?? "Merch",
              status:             "draft",
              tags,
              image_url:          bandcampImageUrl(merchItem.image_url) ?? null,
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

          if (bandcampImageUrl(merchItem.image_url)) {
            await supabase.from("warehouse_product_images").insert({
              product_id:   product.id,
              src:          bandcampImageUrl(merchItem.image_url),
              alt:          title,
              position:     0,
            });
          }

          const bcPrice = merchItem.price ?? null;
          const bcCost = bcPrice != null ? Math.round(bcPrice * 0.5 * 100) / 100 : null;
          const { data: newVariant } = await supabase
            .from("warehouse_product_variants")
            .insert({
              product_id:   product.id,
              workspace_id: workspaceId,
              sku:          merchItem.sku,
              title:        merchItem.title,
              price:        bcPrice,
              cost:         bcCost,
              bandcamp_url: null,
              street_date:  merchItem.new_date,
              is_preorder:  tags.includes("Pre-Orders"),
            })
            .select("id")
            .single();

          if (newVariant) {
            await supabase.from("warehouse_inventory_levels").upsert(
              {
                variant_id:          newVariant.id,
                workspace_id:        workspaceId,
                sku:                 merchItem.sku,
                available:           merchItem.quantity_available ?? 0,
                committed:           0,
                incoming:            0,
                last_redis_write_at: new Date().toISOString(),
                updated_at:          new Date().toISOString(),
              },
              { onConflict: "variant_id", ignoreDuplicates: true },
            );
            logger.info("Seeded initial inventory", {
              sku: merchItem.sku,
              available: merchItem.quantity_available ?? 0,
            });

            await supabase.from("bandcamp_product_mappings").insert({
              workspace_id:            workspaceId,
              variant_id:              newVariant.id,
              bandcamp_item_id:        merchItem.package_id,
              bandcamp_item_type:      merchItem.item_type?.toLowerCase().includes("album")
                ? "album"
                : "package",
              bandcamp_member_band_id: merchItem.member_band_id,
              bandcamp_image_url:      bandcampImageUrl(merchItem.image_url) ?? null,
              bandcamp_type_name:      merchItem.item_type,
              bandcamp_new_date:       merchItem.new_date,
              last_quantity_sold:      merchItem.quantity_sold,
              last_synced_at:          new Date().toISOString(),
            });

            if (tags.includes("Pre-Orders")) {
              await preorderSetupTask.trigger({
                variant_id: newVariant.id,
                workspace_id: workspaceId,
              });
            }

            // Trigger scrape for new variant (no idempotency check — brand new mapping)
            await triggerScrapeIfNeeded(
              supabase,
              newVariant.id,
              workspaceId,
              band,
              connection,
              merchItem,
            );
          }

          itemsProcessed++;
        }

        await supabase
          .from("bandcamp_connections")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", connection.id);
      }

      // Rule #35: Alert if failure rate > 20%
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
