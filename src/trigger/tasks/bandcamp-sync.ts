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
import type { ScrapedAlbumData, ScrapedTrack } from "@/lib/clients/bandcamp-scraper";
import {
  BandcampFetchError,
  bandcampAlbumArtUrl,
  bandcampMerchImageUrl,
  extractAlbumTitle,
  buildBandcampAlbumUrl,
  fetchBandcampPage,
  parseBandcampPage,
} from "@/lib/clients/bandcamp-scraper";
import { productSetCreate } from "@/lib/clients/shopify-client";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { bandcampScrapeQueue } from "@/trigger/lib/bandcamp-scrape-queue";
import { preorderSetupTask } from "@/trigger/tasks/preorder-setup";

// ─── Description HTML builder ──────────────────────────────────────────────────
// Composes a Shopify-ready HTML description from Bandcamp metadata.
// Each section is only included when the data is present.
// Sections: About | Tracklist | Credits

function buildDescriptionHtml(
  about: string | null,
  tracks: ScrapedTrack[],
  credits: string | null,
): string | null {
  const parts: string[] = [];

  if (about) {
    // Preserve paragraph breaks (double newlines) as <p> tags
    const paragraphs = about
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`);
    parts.push(paragraphs.join("\n"));
  }

  if (tracks.length > 0) {
    const items = tracks
      .map((t) => `<li>${t.title} (${t.durationFormatted})</li>`)
      .join("\n  ");
    parts.push(`<p><strong>Tracklist</strong></p>\n<ol>\n  ${items}\n</ol>`);
  }

  if (credits) {
    // Preserve line breaks in credits block
    const creditsHtml = credits
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
      .join("\n");
    parts.push(`<p><strong>Credits</strong></p>\n${creditsHtml}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

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
  maxDuration: 60,  // 15s fetch + parse + DB + optional Shopify description push; 30s was tight in production
  run: async (payload: {
    url: string;
    mappingId: string;
    workspaceId: string;
    urlIsConstructed?: boolean;
    albumTitle?: string;
    urlSource?: "orders_api" | "constructed" | "manual";
  }) => {
    const supabase = createServiceRoleClient();
    try {
      // Record attempt time before fetching — tracks even if task crashes mid-run
      await supabase
        .from("bandcamp_product_mappings")
        .update({ last_scrape_attempt_at: new Date().toISOString() })
        .eq("id", payload.mappingId);

      const html = await fetchBandcampPage(payload.url);
      const scraped = parseBandcampPage(html);

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
        // Count toward Group 1 sweep cap — otherwise this mapping is re-triggered forever and starves the queue.
        await supabase.rpc("increment_bandcamp_scrape_failures", { p_mapping_id: payload.mappingId });
        return { success: false, reason: "no_tralbum" };
      }

      // Write scraped metadata — update mapping with all data-tralbum fields
      const { error: updateErr } = await supabase
        .from("bandcamp_product_mappings")
        .update({
          scrape_failure_count:  0,
          bandcamp_url:          payload.url,
          bandcamp_url_source:   "scraper_verified",
          bandcamp_type_name:    scraped.packages[0]?.typeName ?? null,
          bandcamp_new_date:     scraped.releaseDate
            ? scraped.releaseDate.toISOString().slice(0, 10)
            : null,
          bandcamp_release_date: scraped.releaseDate?.toISOString() ?? null,
          bandcamp_is_preorder:  scraped.isPreorder,
          bandcamp_art_url:      scraped.albumArtUrl,
          bandcamp_about:        scraped.about,
          bandcamp_credits:      scraped.credits,
          bandcamp_tracks:       scraped.tracks.length > 0 ? scraped.tracks : null,
          last_synced_at:        new Date().toISOString(),
          updated_at:            new Date().toISOString(),
        })
        .eq("id", payload.mappingId);

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

          // Write album-level metadata to warehouse_products.
          // variant.product_id is already available from the SELECT above.
          // Conditional WHERE guards prevent overwriting existing data — no pre-SELECT needed.
          if (variant.product_id) {
            // UPC: set once (WHERE bandcamp_upc IS NULL)
            if (scraped.upc) {
              await supabase
                .from("warehouse_products")
                .update({ bandcamp_upc: scraped.upc, updated_at: new Date().toISOString() })
                .eq("id", variant.product_id)
                .is("bandcamp_upc", null);
            }

            // description_html: composed from about + tracks + credits.
            // Only write when currently null or empty — preserves staff edits.
            const builtDescription = buildDescriptionHtml(
              scraped.about,
              scraped.tracks,
              scraped.credits,
            );
            if (builtDescription) {
              await supabase
                .from("warehouse_products")
                .update({
                  description_html: builtDescription,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", variant.product_id)
                .or("description_html.is.null,description_html.eq.");
            }

            // Sync description to Shopify if the product has a Shopify ID.
            // Only push when we just wrote description_html (i.e. it was null/empty).
            // Fetch shopify_product_id — single read to avoid blind push on every scrape.
            if (builtDescription) {
              const { data: productRow } = await supabase
                .from("warehouse_products")
                .select("shopify_product_id, description_html")
                .eq("id", variant.product_id)
                .single();

              // Push to Shopify only when description_html was just populated
              // (i.e. the DB now has our built description, meaning it was null before)
              if (
                productRow?.shopify_product_id &&
                productRow.description_html === builtDescription
              ) {
                try {
                  const { productUpdate: shopifyProductUpdate } = await import(
                    "@/lib/clients/shopify"
                  );
                  await shopifyProductUpdate({
                    id: productRow.shopify_product_id,
                    descriptionHtml: builtDescription,
                  });
                  logger.info("Pushed description to Shopify", {
                    productId: variant.product_id,
                    shopifyProductId: productRow.shopify_product_id,
                  });
                } catch (shopifyErr) {
                  logger.warn("Failed to push description to Shopify (non-fatal)", {
                    productId: variant.product_id,
                    error: String(shopifyErr),
                  });
                }
              }
            }

            // UPC → variant barcode: write to variant.barcode if currently empty.
            // This makes the UPC available for scanner functions.
            // Note: this is the album-level digital UPC; physical format barcodes may differ.
            if (scraped.upc) {
              await supabase
                .from("warehouse_product_variants")
                .update({ barcode: scraped.upc, updated_at: new Date().toISOString() })
                .eq("id", variant.id)
                .is("barcode", null);
            }
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

      await supabase.from("channel_sync_log").insert({
        workspace_id: payload.workspaceId,
        channel: "bandcamp",
        sync_type: "scrape_page",
        status: "completed",
        items_processed: 1,
        items_failed: 0,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        metadata: {
          url: payload.url,
          mappingId: payload.mappingId,
          httpStatus: 200,
          metadataIncomplete: scraped.metadataIncomplete,
        },
      }).then(() => {}, () => {});

      return { success: true, metadataIncomplete: scraped.metadataIncomplete };
    } catch (error) {
      const is404 = error instanceof BandcampFetchError && error.status === 404;
      const httpStatus = error instanceof BandcampFetchError ? error.status : undefined;
      const retryAfterSec = error instanceof BandcampFetchError ? error.retryAfterSeconds : undefined;

      logger.error("Scrape failed", {
        url: payload.url,
        urlIsConstructed: payload.urlIsConstructed,
        status: httpStatus,
        retryAfterSeconds: retryAfterSec,
        error: String(error),
      });

      await supabase.from("channel_sync_log").insert({
        workspace_id: payload.workspaceId,
        channel: "bandcamp",
        sync_type: "scrape_page",
        status: "failed",
        items_processed: 0,
        items_failed: 1,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        error_message: String(error).slice(0, 500),
        metadata: {
          url: payload.url,
          mappingId: payload.mappingId,
          httpStatus,
          retryAfterSeconds: retryAfterSec,
          urlIsConstructed: payload.urlIsConstructed,
        },
      }).then(() => {}, () => {});

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
        // Increment failure count so Group 1 sweep eventually stops re-queueing this item
        await supabase.rpc("increment_bandcamp_scrape_failures", { p_mapping_id: payload.mappingId });
        return { success: false, reason: "404_constructed_url" };
      }

      // Non-404 or API-sourced URL failures → throw so Trigger.dev retries
      // For all BandcampFetchError (any HTTP error from Bandcamp including 403/429 blocking
      // from cloud server IPs), log to review queue instead of silently retrying forever.
      // This provides visibility + stops the retry loop for known permanent failures.
      if (error instanceof BandcampFetchError) {
        const httpStatus = error.status;
        const isBlockedByCloudflare = httpStatus === 403 || httpStatus === 408 || httpStatus === 429 || httpStatus === 503;

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

        // Increment failure count for all HTTP errors (including 408 timeout from AbortSignal)
        // After 5 failures, Group 1 sweep stops re-queueing this item
        await supabase.rpc("increment_bandcamp_scrape_failures", { p_mapping_id: payload.mappingId });

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

/**
 * Extract the numeric Bandcamp image ID from any Bandcamp CDN URL.
 * Handles both "a"-prefixed album art and plain merch photo URLs,
 * and normalises away leading zeroes so dedup works across URL formats.
 *
 * f4.bcbits.com/img/a1234567890_10.jpg  → "1234567890"
 * f4.bcbits.com/img/0001234567890_10.jpg → "1234567890"
 * f4.bcbits.com/img/1234567890_10.jpg   → "1234567890"
 */
function extractBandcampImageId(url: string): string | null {
  const m = url.match(/\/img\/a?0*(\d+)_\d+\./);
  return m ? m[1] : null;
}

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
    .select("id, src, position")
    .eq("product_id", productId)
    .order("position", { ascending: true });

  // Dedup by both exact URL and by extracted Bandcamp image ID (catches zero-padding differences)
  const existingSrcs = new Set((existingImages ?? []).map((i) => i.src));
  const existingImageIds = new Set(
    (existingImages ?? []).map((i) => extractBandcampImageId(i.src)).filter(Boolean),
  );

  const imagesToInsert: Array<{
    product_id: string;
    workspace_id: string;
    src: string;
    alt: string | null;
    position: number;
  }> = [];

  // Primary merch image from matched package — append AFTER album art
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

  // Album art is always primary (position 0). If there are existing images, shift them up.
  const albumArtId = scraped.albumArtUrl ? extractBandcampImageId(scraped.albumArtUrl) : null;
  const wantAlbumArt =
    scraped.albumArtUrl &&
    !existingSrcs.has(scraped.albumArtUrl) &&
    !(albumArtId && existingImageIds.has(albumArtId));

  if (wantAlbumArt && (existingImages?.length ?? 0) > 0) {
    // Shift all existing images up by 1 to make room for album art at position 0
    for (const img of existingImages ?? []) {
      await supabase
        .from("warehouse_product_images")
        .update({ position: img.position + 1 })
        .eq("id", img.id);
    }
  }

  if (wantAlbumArt && scraped.albumArtUrl) {
    imagesToInsert.push({
      product_id: productId,
      workspace_id: workspaceId,
      src: scraped.albumArtUrl,
      alt: scraped.title ? `${scraped.title} - Album Art` : "Album Art",
      position: 0,
    });
  }

  // All package arts (arts[0] = same as API image, arts[1..n] = secondary product photos).
  // Dedup by image ID catches zero-padded vs non-zero-padded URL variants.
  // seenInThisRun prevents adding the same art twice when iterating multiple packages.
  const seenInThisRun = new Set(existingImageIds);
  let nextPos =
    (existingImages?.length ?? 0) > 0
      ? Math.max(...(existingImages ?? []).map((i) => i.position), -1) + (wantAlbumArt ? 2 : 1)
      : wantAlbumArt ? 1 : 0;

  if (matchedPkg) {
    for (const art of matchedPkg.arts) {
      if (!art.url) continue;
      const artId = extractBandcampImageId(art.url);
      if (!artId) continue;
      if (existingSrcs.has(art.url)) continue;   // exact URL already stored
      if (seenInThisRun.has(artId)) continue;     // same image (different URL) already handled

      seenInThisRun.add(artId);
      imagesToInsert.push({
        product_id: productId,
        workspace_id: workspaceId,
        src: art.url,
        alt: matchedPkg.typeName ? `${matchedPkg.typeName} - Product Photo` : "Product Photo",
        position: nextPos++,
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

  // Sync to product.images JSONB for legacy compatibility
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("images")
    .eq("id", productId)
    .single();

  const existingJson =
    (product?.images as Array<{ src: string; alt?: string; position?: number }> | null) ?? [];
  const mergedImages = [
    ...existingJson.map((img) =>
      wantAlbumArt ? { ...img, position: (img.position ?? 0) + 1 } : img,
    ),
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
  // Idempotency: trigger if (a) not yet scraped, OR (b) scraped before about/credits/upc/tracks
  // were added (has art_url but no about text yet — backfill window).
  // TODO: once backfill confirmed complete (COUNT(*) WHERE bandcamp_art_url IS NOT NULL
  //   AND bandcamp_about IS NULL = 0), simplify to:
  //   !mapping.bandcamp_type_name || !mapping.bandcamp_about
  const { data: mapping } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_url, bandcamp_type_name, bandcamp_art_url, bandcamp_about")
    .eq("variant_id", variantId)
    .single();

  if (!mapping) return;

  const needsScrape =
    !mapping.bandcamp_url ||
    !mapping.bandcamp_type_name ||
    (mapping.bandcamp_art_url && !mapping.bandcamp_about);
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
  maxDuration: 1800,  // 30 min — sync + sweep triggers can take longer with 550 mappings
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
    let totalMerchItems = 0;
    let unmatchedMerchCount = 0;

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
        totalMerchItems += merchItems.length;
        unmatchedMerchCount += unmatched.length;

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
            // Step 1: Seed inventory row at zero (safe baseline)
            await supabase.from("warehouse_inventory_levels").upsert(
              {
                variant_id:   newVariant.id,
                workspace_id: workspaceId,
                sku:          merchItem.sku,
                available:    0,
                committed:    0,
                incoming:     0,
              },
              { onConflict: "variant_id", ignoreDuplicates: true },
            );

            // Step 2: Apply actual Bandcamp quantity via canonical write path (Rule #20).
            // This ensures Redis is updated and fanout pushes to Bandcamp + client stores.
            const initialQty = merchItem.quantity_available ?? 0;
            if (initialQty > 0) {
              await recordInventoryChange({
                workspaceId,
                sku: merchItem.sku,
                delta: initialQty,
                source: "backfill",
                correlationId: `bandcamp-seed:${connection.band_id}:${merchItem.package_id}`,
                metadata: {
                  band_id: connection.band_id,
                  package_id: merchItem.package_id,
                },
              });
            }

            logger.info("Seeded initial inventory", {
              sku: merchItem.sku,
              available: initialQty,
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
            metadata: {
              totalMerchItems,
              unmatchedMerchCount,
              matchRate: totalMerchItems > 0
                ? Math.round(((totalMerchItems - unmatchedMerchCount) / totalMerchItems) * 100)
                : null,
            },
          })
          .eq("id", syncLogId);
      }

      logger.info("Bandcamp sync complete", { itemsProcessed, itemsFailed, totalMerchItems, unmatchedMerchCount });

      // ── Sweep: trigger scraper for ALL mappings that need it ─────────────────
      // This covers variants that are out of stock / removed from active Bandcamp
      // catalog (not returned by getMerchDetails), so triggerScrapeIfNeeded is
      // never called for them during normal matched-variant processing.
      //
      // Group 1: mappings with bandcamp_url but no bandcamp_type_name (49 items)
      // Group 2: mappings with no URL at all — construct from band subdomain +
      //          warehouse product title (processed up to 100/run, same cap as scrape-sweep cron)

      const sweepDiagStartedAt = new Date().toISOString();

      // Group 1: has URL, missing type_name — needs scraping.
      // Skip items with 5+ failures to prevent infinite re-queueing of
      // Cloudflare-blocked or permanently-broken URLs.
      const { data: withUrlNoType } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_url", "is", null)
        .is("bandcamp_type_name", null)
        .or("scrape_failure_count.is.null,scrape_failure_count.lt.5")
        .limit(100);

      const g1SweepSelected = withUrlNoType?.length ?? 0;
      let g1SweepTriggered = 0;
      if (withUrlNoType && withUrlNoType.length > 0) {
        logger.info(`Sweep group 1: ${withUrlNoType.length} mappings with URL but no type_name`);
        for (const pm of withUrlNoType) {
          await bandcampScrapePageTask.trigger({
            url: pm.bandcamp_url as string,
            mappingId: pm.id,
            workspaceId,
            urlIsConstructed: false,
            urlSource: "orders_api",
          });
          g1SweepTriggered++;
        }
      }

      // Group 2: no URL — construct from band subdomain + product title.
      //
      // FIX (2026-04-01): Original code used org_id as the Map key, but ALL 17 connections
      // share org_id: 382a91dd (Clandestine Distribution). Map overwrites duplicates →
      // only the last connection's subdomain survived → wrong URLs for all 500 items.
      //
      // Fix: use bandcamp_member_band_id (set on every mapping) → connection.band_id → subdomain.
      // Fallback: member_bands_cache for label sub-artists (e.g. NSR member bands).
      const { data: noUrlNoType } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, variant_id, bandcamp_member_band_id")
        .eq("workspace_id", workspaceId)
        .is("bandcamp_url", null)
        .is("bandcamp_type_name", null)
        .limit(100);

      const g2SweepSelected = noUrlNoType?.length ?? 0;
      let g2SweepTriggered = 0;
      let g2SkipNoVariantTitle = 0;
      let g2SkipNoSubdomain = 0;
      let g2SkipBadSlug = 0;
      let g2SkipUrlRace = 0;

      if (noUrlNoType && noUrlNoType.length > 0) {
        // Resolve variant → product title
        const variantIds = noUrlNoType.map((m) => m.variant_id);
        const { data: variants } = await supabase
          .from("warehouse_product_variants")
          .select("id, sku, warehouse_products!inner(title)")
          .in("id", variantIds);

        const variantMap = new Map(
          (variants ?? []).map((v) => [
            v.id,
            {
              sku: v.sku,
              productTitle: (v.warehouse_products as unknown as { title: string }).title,
            },
          ]),
        );

        // Build band_id → subdomain map (17 unique keys — no overwrite issue)
        const { data: allConns } = await supabase
          .from("bandcamp_connections")
          .select("band_id, band_url, member_bands_cache")
          .eq("workspace_id", workspaceId)
          .not("band_url", "is", null);

        const bandIdToSubdomain = new Map<number, string>(
          (allConns ?? []).map((c) => [
            c.band_id as number,
            (c.band_url ?? "").replace("https://", "").split(".")[0],
          ]),
        );

        // Secondary: label sub-artists via member_bands_cache
        // (e.g. NSR member artists whose albums live at northernspyrecords.bandcamp.com)
        interface MemberBandEntry { band_id: number }
        const memberBandParentSubdomain = new Map<number, string>();
        for (const conn of allConns ?? []) {
          const parentSub = (conn.band_url ?? "").replace("https://", "").split(".")[0];
          if (!parentSub) continue;
          let memberBands: MemberBandEntry[] = [];
          try {
            const raw = conn.member_bands_cache;
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (Array.isArray(parsed?.member_bands)) {
              memberBands = parsed.member_bands;
            } else if (Array.isArray(parsed)) {
              memberBands = parsed as MemberBandEntry[];
            }
          } catch {
            logger.warn("Sweep group 2: member_bands_cache parse failed", { connectionBandId: conn.band_id });
          }
          for (const mb of memberBands) {
            if (typeof mb?.band_id === "number" && !memberBandParentSubdomain.has(mb.band_id)) {
              memberBandParentSubdomain.set(mb.band_id, parentSub);
            }
          }
        }

        for (const pm of noUrlNoType) {
          const vInfo = variantMap.get(pm.variant_id);
          if (!vInfo?.productTitle) {
            g2SkipNoVariantTitle++;
            continue;
          }

          const memberBandId = pm.bandcamp_member_band_id as number | null;
          const subdomain =
            (memberBandId ? bandIdToSubdomain.get(memberBandId) : null) ??
            (memberBandId ? memberBandParentSubdomain.get(memberBandId) : null) ??
            null;

          if (!subdomain) {
            // Cannot resolve — log to review queue for manual intervention (~7% of items)
            await supabase.from("warehouse_review_queue").upsert(
              {
                workspace_id: workspaceId,
                category: "bandcamp_scraper",
                severity: "low" as const,
                title: `Cannot construct Bandcamp URL: no subdomain for member_band_id ${memberBandId}`,
                description: `Mapping ${pm.id} has member_band_id ${memberBandId} which does not match any active connection or member_bands_cache. Set bandcamp_url manually to enable scraping.`,
                metadata: { mappingId: pm.id, memberBandId },
                status: "open" as const,
                group_key: `bc_unresolvable_${pm.id}`,
                occurrence_count: 1,
              },
              { onConflict: "group_key", ignoreDuplicates: true },
            );
            logger.warn("Sweep group 2: no subdomain for mapping", { mappingId: pm.id, memberBandId });
            g2SkipNoSubdomain++;
            continue;
          }

          const rawTitle = vInfo.productTitle;
          const albumTitle = extractAlbumTitle(rawTitle);

          const scrapeUrl = albumTitle ? buildBandcampAlbumUrl(subdomain, albumTitle) : null;
          if (!scrapeUrl) {
            g2SkipBadSlug++;
            continue;
          }

          logger.info("Sweep group 2 item", {
            mappingId: pm.id,
            memberBandId,
            subdomain,
            constructedUrl: scrapeUrl,
            source: memberBandId && bandIdToSubdomain.has(memberBandId) ? "direct" : "member_cache",
          });

          // Idempotency guard: only write URL if not already set by a concurrent process
          const { data: urlWritten } = await supabase
            .from("bandcamp_product_mappings")
            .update({
              bandcamp_url: scrapeUrl,
              bandcamp_url_source: "constructed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", pm.id)
            .is("bandcamp_url", null)
            .select("id")
            .single();

          if (!urlWritten) {
            g2SkipUrlRace++;
            continue;
          }

          await bandcampScrapePageTask.trigger({
            url: scrapeUrl,
            mappingId: pm.id,
            workspaceId,
            urlIsConstructed: true,
            albumTitle: albumTitle ?? undefined,
            urlSource: "constructed",
          });
          g2SweepTriggered++;
        }
        logger.info(`Sweep group 2: triggered ${g2SweepTriggered}/${noUrlNoType.length} scrapes for no-URL mappings`);
      }

      // Group 3: already scraped (has art_url) but missing about/credits/upc/tracks.
      // These were scraped before this feature was added — backfill on subsequent runs.
      // Limit 100/run to match scrape-sweep cron pacing.
      const { data: scrapedNoAbout } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_art_url", "is", null)
        .is("bandcamp_about", null)
        .not("bandcamp_url", "is", null)
        .limit(100);

      const g3SweepSelected = scrapedNoAbout?.length ?? 0;
      let g3SweepTriggered = 0;
      if (scrapedNoAbout && scrapedNoAbout.length > 0) {
        logger.info(`Sweep group 3: ${scrapedNoAbout.length} already-scraped mappings missing about/credits/upc`);
        for (const pm of scrapedNoAbout) {
          await bandcampScrapePageTask.trigger({
            url: pm.bandcamp_url as string,
            mappingId: pm.id,
            workspaceId,
            urlIsConstructed: false,
            urlSource: "orders_api",
          });
          g3SweepTriggered++;
        }
      }

      const sweepDiagTotal = g1SweepTriggered + g2SweepTriggered + g3SweepTriggered;
      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "bandcamp",
        sync_type: "scrape_diag",
        status: "completed",
        items_processed: sweepDiagTotal,
        items_failed: 0,
        started_at: sweepDiagStartedAt,
        completed_at: new Date().toISOString(),
        metadata: {
          source: "bandcamp_sync_embedded_sweep",
          limits: { per_group: 100 },
          scrape_queue_concurrency: 5,
          scrape_task_max_duration_sec: 60,
          g1: { selected: g1SweepSelected, triggered: g1SweepTriggered },
          g2: {
            selected: g2SweepSelected,
            triggered: g2SweepTriggered,
            skip_no_variant_title: g2SkipNoVariantTitle,
            skip_no_subdomain: g2SkipNoSubdomain,
            skip_bad_slug: g2SkipBadSlug,
            skip_url_already_set: g2SkipUrlRace,
          },
          g3: { selected: g3SweepSelected, triggered: g3SweepTriggered },
        },
      });
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
