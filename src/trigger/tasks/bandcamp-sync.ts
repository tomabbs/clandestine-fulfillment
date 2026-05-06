import { logger, schedules, task } from "@trigger.dev/sdk";
import type { BandcampBand, BandcampMerchItem } from "@/lib/clients/bandcamp";
import {
  assembleBandcampTitle,
  bandcampImageUrl,
  getMerchDetails,
  getMyBands,
  matchSkuToVariants,
  refreshBandcampToken,
  updateSku,
} from "@/lib/clients/bandcamp";
import type { ScrapedAlbumData, ScrapedTrack } from "@/lib/clients/bandcamp-scraper";
import {
  BandcampFetchError,
  buildBandcampAlbumUrl,
  extractAlbumTitle,
  fetchBandcampPage,
  parseBandcampPage,
} from "@/lib/clients/bandcamp-scraper";
import {
  fetchProductVariantsByProductId,
  findOrCreateCollection,
  inventoryItemUpdate,
  productArchive,
  productCreateMedia,
  productSetCreate,
  publishToSafeChannels,
  shopifyGraphQL,
} from "@/lib/clients/shopify-client";
import { buildShopifyVariantInput } from "@/lib/clients/shopify-variant-input";
import { computeBandcampSeedQuantity } from "@/lib/server/bandcamp-effective-available";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { matchTagToTaxonomy } from "@/lib/shared/genre-taxonomy";
import { deriveStreetDateAndPreorder, isFutureReleaseDate } from "@/lib/shared/preorder-dates";
import {
  CATEGORY_DEFAULT_WEIGHTS,
  CATEGORY_EXPECTED_FIELDS,
  classifyProduct,
  isAlbumLinkedBundle,
  type ProductCategory,
} from "@/lib/shared/product-categories";
import { normalizeShopifyProductId } from "@/lib/shared/shopify-id";
import {
  detectMultiVariantOptions,
  inferOptionName,
  optionDisplayValue,
} from "@/trigger/lib/bandcamp-apparel";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { bandcampScrapeQueue } from "@/trigger/lib/bandcamp-scrape-queue";
import { crossReferenceAlbumUrls } from "@/trigger/lib/bandcamp-url-crossref";
import {
  calculateDelayMs,
  checkCircuitBreaker,
  classifyFailureReason,
  extractSubdomain,
  recordCircuitFailure,
  recordCircuitSuccess,
} from "@/trigger/lib/domain-circuit-breaker";
import { preorderSetupTask } from "@/trigger/tasks/preorder-setup";

// ─── SKU generation for items without one ─────────────────────────────────────

const FORMAT_CODES: Record<string, string> = {
  vinyl: "LP",
  "record/vinyl": "LP",
  lp: "LP",
  "2xlp": "2LP",
  "compact disc": "CD",
  cd: "CD",
  cassette: "CS",
  "cassette tape": "CS",
  tape: "CS",
  '7"': "7IN",
  '10"': "10IN",
  '12"': "12IN",
  "t-shirt": "TS",
  shirt: "TS",
  tee: "TS",
  "sweater/hoodie": "HOODIE",
  hoodie: "HOODIE",
  "poster/print": "POSTER",
  poster: "POSTER",
  bag: "BAG",
  tote: "BAG",
  "hat/cap": "HAT",
  sticker: "STICKER",
  patch: "PATCH",
  pin: "PIN",
  other: "MERCH",
};

function deriveFormatCode(itemType: string | null | undefined, title: string): string {
  const type = (itemType ?? "").toLowerCase().trim();
  if (FORMAT_CODES[type]) return FORMAT_CODES[type];
  const t = title.toLowerCase();
  if (t.includes("vinyl") || t.includes(" lp") || t.includes('12"') || t.includes("12\u201D"))
    return "LP";
  if (t.includes("compact disc") || t.includes(" cd")) return "CD";
  if (t.includes("cassette") || t.includes("tape")) return "CS";
  if (t.includes("t-shirt") || t.includes("tee")) return "TS";
  if (t.includes("poster")) return "POSTER";
  if (t.includes("hoodie") || t.includes("sweatshirt")) return "HOODIE";
  if (t.includes("bag") || t.includes("tote")) return "BAG";
  if (t.includes('7"') || t.includes("7\u201D")) return "7IN";
  return "MERCH";
}

function slugify(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
}

function generateSku(
  merchItem: { item_type?: string | null; title: string; album_title?: string | null },
  artistName: string,
  existingSkus: Set<string>,
): string {
  const format = deriveFormatCode(merchItem.item_type, merchItem.title);
  const artistSlug = slugify(artistName).slice(0, 6);
  const albumSlug = slugify(merchItem.album_title ?? merchItem.title).slice(0, 12);

  let base = `${format}-${artistSlug}-${albumSlug}`;
  if (!base || base === `${format}--`) base = `${format}-${Date.now().toString(36).toUpperCase()}`;

  let candidate = base;
  let suffix = 2;
  while (existingSkus.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  existingSkus.add(candidate);
  return candidate;
}

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
    const items = tracks.map((t) => `<li>${t.title} (${t.durationFormatted})</li>`).join("\n  ");
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
  "lp",
  "vinyl",
  "cd",
  "cassette",
  "tape",
  '7"',
  '10"',
  '12"',
  // Apparel and merch
  "shirt",
  "t-shirt",
  "tee",
  "hoodie",
  "hat",
  "beanie",
  "poster",
  "print",
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
  maxDuration: 60, // 15s fetch + parse + DB + optional Shopify description push; 30s was tight in production
  run: async (payload: {
    url: string;
    mappingId: string;
    workspaceId: string;
    urlIsConstructed?: boolean;
    albumTitle?: string;
    urlSource?: "orders_api" | "constructed" | "manual";
    productCategory?: string | null;
    isDeadUrlProbe?: boolean;
  }) => {
    const supabase = createServiceRoleClient();
    const subdomain = extractSubdomain(payload.url);

    // Circuit breaker guard — skip if domain is in cooldown
    if (subdomain) {
      const { allowed, effectiveRps } = await checkCircuitBreaker(
        supabase,
        payload.workspaceId,
        subdomain,
        { ignoreOpen: payload.isDeadUrlProbe ?? false },
      );
      if (!allowed) {
        logger.info("Circuit breaker open, skipping scrape", {
          subdomain,
          url: payload.url,
          mappingId: payload.mappingId,
        });
        return { success: false, reason: "circuit_open", subdomain };
      }

      // Adaptive delay based on AIMD-computed RPS
      const delayMs = calculateDelayMs(effectiveRps);
      if (delayMs > 200) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

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
        const cat = (payload.productCategory ?? "other") as ProductCategory;
        const expectsTracks = CATEGORY_EXPECTED_FIELDS[cat]?.tracks ?? false;

        // Only flag as error when we EXPECT album data for this category
        if (expectsTracks && !payload.isDeadUrlProbe) {
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
        }

        // Track consecutive failures + update mapping state
        await supabase
          .from("bandcamp_product_mappings")
          .update({
            last_failure_reason: "parse_failure",
            last_http_status: 200,
            updated_at: new Date().toISOString(),
          })
          .eq("id", payload.mappingId);
        await supabase.rpc("increment_consecutive_failures", {
          p_mapping_id: payload.mappingId,
        });
        if (subdomain) {
          await recordCircuitSuccess(supabase, payload.workspaceId, subdomain);
        }
        return { success: false, reason: "no_tralbum" };
      }

      // Write scraped metadata — category-gated enrichment
      if (!payload.productCategory) {
        logger.warn(
          "Missing productCategory in scrape payload — defaulting to album expectations",
          {
            mappingId: payload.mappingId,
            url: payload.url,
          },
        );
      }
      const category = (payload.productCategory ?? "other") as ProductCategory;
      const expectations = CATEGORY_EXPECTED_FIELDS[category] ?? CATEGORY_EXPECTED_FIELDS.other;

      const tagMatch = scraped.tagNorms.length > 0 ? matchTagToTaxonomy(scraped.tagNorms) : null;

      // Revival semantics: dead -> probation (not active), probation/active -> active
      const { data: currentMapping } = await supabase
        .from("bandcamp_product_mappings")
        .select("scrape_status")
        .eq("id", payload.mappingId)
        .single();
      const currentStatus = currentMapping?.scrape_status ?? "active";
      const newScrapeStatus = currentStatus === "dead" ? "probation" : "active";

      const mappingUpdate: Record<string, unknown> = {
        scrape_failure_count: 0,
        consecutive_failures: 0,
        scrape_status: newScrapeStatus,
        last_failure_reason: null,
        last_http_status: null,
        bandcamp_url: payload.url,
        bandcamp_url_source: "scraper_verified",
        bandcamp_art_url: scraped.albumArtUrl,
        bandcamp_tralbum_id: scraped.tralbumId,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Album-specific fields: only write when category expects them
      if (expectations.about) {
        // For bundles at /album/ URLs, validate data-tralbum actually had content
        if (category === "bundle" && !isAlbumLinkedBundle(payload.url, category)) {
          // Standalone merch bundle — art only, skip album fields
        } else {
          mappingUpdate.bandcamp_type_name = scraped.packages[0]?.typeName ?? null;
          mappingUpdate.bandcamp_new_date = scraped.releaseDate
            ? scraped.releaseDate.toISOString().slice(0, 10)
            : null;
          mappingUpdate.bandcamp_release_date = scraped.releaseDate?.toISOString() ?? null;
          mappingUpdate.bandcamp_is_preorder = scraped.isPreorder;
          mappingUpdate.bandcamp_about = scraped.about;
          mappingUpdate.bandcamp_credits = scraped.credits;
          mappingUpdate.bandcamp_tracks = scraped.tracks.length > 0 ? scraped.tracks : null;
          mappingUpdate.bandcamp_upc = scraped.upc;
        }
      }

      if (expectations.tags) {
        mappingUpdate.bandcamp_tags = scraped.tags.length > 0 ? scraped.tags : null;
        mappingUpdate.bandcamp_tag_norms = scraped.tagNorms.length > 0 ? scraped.tagNorms : null;
        mappingUpdate.bandcamp_primary_genre = tagMatch?.bcGenre ?? null;
        mappingUpdate.bandcamp_tags_fetched_at =
          scraped.tags.length > 0 ? new Date().toISOString() : null;
      }

      const { error: updateErr } = await supabase
        .from("bandcamp_product_mappings")
        .update(mappingUpdate)
        .eq("id", payload.mappingId);
      if (updateErr) throw updateErr;

      // Inline reconciliation: auto-resolve open review queue items for this mapping
      const { data: resolved } = await supabase
        .from("warehouse_review_queue")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("category", "bandcamp_scraper")
        .eq("status", "open")
        .like("group_key", `%${payload.mappingId}%`)
        .select("id");
      if (resolved && resolved.length > 0) {
        logger.info("Auto-resolved review queue items on scrape success", {
          mappingId: payload.mappingId,
          resolvedCount: resolved.length,
        });
      }

      // Record circuit breaker success (AIMD additive increase)
      if (subdomain) {
        await recordCircuitSuccess(supabase, payload.workspaceId, subdomain);
      }

      // Propagate to linked variant
      const { data: mapping } = await supabase
        .from("bandcamp_product_mappings")
        .select("variant_id, authority_status")
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

          // Always refresh street_date from scraper when Bandcamp is still authority
          // (previously only set when empty — this fixes the scraper-path detection gap)
          const scrapedDate = scraped.releaseDate
            ? scraped.releaseDate.toISOString().slice(0, 10)
            : null;
          const isInitialAuthority =
            !mapping.authority_status || mapping.authority_status === "bandcamp_initial";
          if (scrapedDate && (isInitialAuthority || !variant.street_date)) {
            updates.street_date = scrapedDate;
          }

          const effectiveDate = (updates.street_date as string | undefined) ?? variant.street_date;
          const shouldBePreorder = scraped.isPreorder || isFutureReleaseDate(effectiveDate);
          if (shouldBePreorder && !variant.is_preorder) {
            updates.is_preorder = true;
          }

          if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString();
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

          // Store album art + primary merch image
          if (variant.product_id) {
            await storeScrapedImages(
              supabase,
              variant.product_id,
              payload.workspaceId,
              scraped,
              variant.id,
              variant.title,
              payload.albumTitle ?? null,
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

      if (scraped.metadataIncomplete && expectations.tracks) {
        // Only flag as incomplete when we EXPECT tracks/packages for this category
        // (merch/apparel will always have 0 packages — that's correct, not incomplete)
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

      await supabase
        .from("channel_sync_log")
        .insert({
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
        })
        .then(
          () => {},
          (err) =>
            logger.warn("channel_sync_log insert failed", {
              error: String(err),
              task: "bandcamp-scrape-page",
              context: "scrape_success_audit",
            }),
        );

      return { success: true, metadataIncomplete: scraped.metadataIncomplete };
    } catch (error) {
      const is404 = error instanceof BandcampFetchError && error.status === 404;
      const httpStatus = error instanceof BandcampFetchError ? error.status : undefined;
      const retryAfterSec =
        error instanceof BandcampFetchError ? error.retryAfterSeconds : undefined;
      const failureReason = classifyFailureReason(httpStatus, error);

      logger.error("Scrape failed", {
        url: payload.url,
        urlIsConstructed: payload.urlIsConstructed,
        status: httpStatus,
        retryAfterSeconds: retryAfterSec,
        failureReason,
        error: String(error),
      });

      await supabase
        .from("channel_sync_log")
        .insert({
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
            failureReason,
          },
        })
        .then(
          () => {},
          (err) =>
            logger.warn("channel_sync_log insert failed", {
              error: String(err),
              task: "bandcamp-scrape-page",
              context: "scrape_failure_audit",
            }),
        );

      // Step 1: Update mapping state FIRST (consecutive_failures, scrape_status)
      await supabase
        .from("bandcamp_product_mappings")
        .update({
          last_failure_reason: failureReason,
          last_http_status: httpStatus ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", payload.mappingId);

      const { data: failResult } = await supabase.rpc("increment_consecutive_failures", {
        p_mapping_id: payload.mappingId,
      });
      const mappingRow = Array.isArray(failResult) ? failResult[0] : failResult;
      const newStatus = mappingRow?.new_status;
      const newCount = mappingRow?.new_count;

      if (newStatus === "dead") {
        logger.warn("Mapping marked DEAD", {
          mappingId: payload.mappingId,
          url: payload.url,
          consecutiveFailures: newCount,
        });
      } else if (newStatus === "probation") {
        logger.info("Mapping entered probation", {
          mappingId: payload.mappingId,
          consecutiveFailures: newCount,
        });
      }

      // Step 2: Update domain state (circuit breaker)
      if (subdomain) {
        await recordCircuitFailure(supabase, payload.workspaceId, subdomain, httpStatus);
      }

      // Dead URL probes: suppress review queue items, only track failures
      if (payload.isDeadUrlProbe) {
        return {
          success: false,
          reason: "dead_probe_failed",
          httpStatus,
          consecutiveFailures: newCount,
        };
      }

      if (is404 && payload.urlIsConstructed) {
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

      if (error instanceof BandcampFetchError) {
        const isBlockedByCloudflare =
          (httpStatus ?? 0) === 403 ||
          (httpStatus ?? 0) === 408 ||
          (httpStatus ?? 0) === 429 ||
          (httpStatus ?? 0) === 503;

        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: payload.workspaceId,
            org_id: null,
            category: "bandcamp_scraper",
            severity: isBlockedByCloudflare ? ("medium" as const) : ("low" as const),
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
  expectedAlbumTitle: string | null,
) {
  // Guard: if we know what album we expected to scrape and the page returned
  // a different title, the URL likely resolved to the wrong page. Skip images
  // entirely to avoid cross-pollinating album art across unrelated products.
  if (expectedAlbumTitle && scraped.title) {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .trim();
    const expected = normalize(expectedAlbumTitle);
    const actual = normalize(scraped.title);
    if (expected && actual && !actual.includes(expected) && !expected.includes(actual)) {
      logger.warn("Scraped page title does not match expected album — skipping images", {
        productId,
        expectedAlbumTitle,
        scrapedTitle: scraped.title,
      });
      return;
    }
  }

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

  const matchedPkg = findMatchingPackage(scraped.packages, variantData?.sku ?? null, variantTitle);

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
      : wantAlbumArt
        ? 1
        : 0;

  if (matchedPkg) {
    for (const art of matchedPkg.arts) {
      if (!art.url) continue;
      const artId = extractBandcampImageId(art.url);
      if (!artId) continue;
      if (existingSrcs.has(art.url)) continue; // exact URL already stored
      if (seenInThisRun.has(artId)) continue; // same image (different URL) already handled

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

  // Sync to product.images JSONB for legacy compatibility and get shopify_product_id
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("images, shopify_product_id")
    .eq("id", productId)
    .single();

  // Push new images to Shopify (best-effort — DB is the source of truth)
  if (product?.shopify_product_id) {
    try {
      await productCreateMedia(
        product.shopify_product_id,
        imagesToInsert.map((img) => ({
          originalSource: img.src,
          alt: img.alt,
          mediaContentType: "IMAGE" as const,
        })),
      );
      logger.info("Pushed scraped images to Shopify", {
        productId,
        shopifyProductId: product.shopify_product_id,
        imageCount: imagesToInsert.length,
      });
    } catch (err) {
      logger.warn("Failed to push scraped images to Shopify (DB already updated)", {
        productId,
        shopifyProductId: product.shopify_product_id,
        error: String(err),
      });
    }
  }

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
  _band: BandcampBand | undefined,
  _connection: { band_url?: string | null },
  merchItem: { url?: string | null; album_title?: string | null },
) {
  // Scraper is enrichment-only: about, credits, tracks, package photos.
  // URL comes from the API (merchItem.url), never constructed.
  const { data: mapping } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, bandcamp_url, bandcamp_about, product_category, bandcamp_type_name")
    .eq("variant_id", variantId)
    .single();

  if (!mapping) return;

  // Only scrape if missing enrichment data (about/credits/tracks)
  if (mapping.bandcamp_about) return;

  const scrapeUrl = (merchItem.url as string | null) ?? mapping.bandcamp_url;
  if (!scrapeUrl) return;

  const cat =
    mapping.product_category ??
    classifyProduct(mapping.bandcamp_type_name, scrapeUrl, merchItem.album_title ?? null);

  await bandcampScrapePageTask.trigger({
    url: scrapeUrl,
    mappingId: mapping.id,
    workspaceId,
    urlIsConstructed: false,
    albumTitle: merchItem.album_title ?? undefined,
    urlSource: "orders_api",
    productCategory: cat,
  });
}

// === Main sync task ===
// Rule #9 — serialized API access via bandcampQueue

export const bandcampSyncTask = task({
  id: "bandcamp-sync",
  queue: bandcampQueue,
  maxDuration: 1800, // 30 min — sync + sweep triggers can take longer with 550 mappings
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
    let lastVariantQueryCount = 0;

    try {
      const { data: workspaceSettings, error: workspaceSettingsError } = await supabase
        .from("workspaces")
        .select("bandcamp_sync_paused, bandcamp_scraper_settings")
        .eq("id", workspaceId)
        .single();

      if (workspaceSettingsError) {
        throw workspaceSettingsError;
      }

      if (workspaceSettings?.bandcamp_sync_paused) {
        logger.warn("bandcamp-sync skipped: workspace bandcamp_sync_paused=true", {
          workspaceId,
        });
        if (syncLogId) {
          await supabase
            .from("channel_sync_log")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
              metadata: {
                skipped: true,
                reason: "bandcamp_sync_paused",
              },
            })
            .eq("id", syncLogId);
        }
        return;
      }

      const accessToken = await refreshBandcampToken(workspaceId);
      logger.info("Token refreshed", { workspaceId });

      const bands = await getMyBands(accessToken);
      logger.info("Got bands", { count: bands.length });

      const bandLookup = new Map<number, BandcampBand>();
      const subdomainLookup = new Map<string, BandcampBand>();
      for (const band of bands) {
        bandLookup.set(band.band_id, band);
        if (band.subdomain) subdomainLookup.set(band.subdomain.toLowerCase(), band);
        if (band.member_bands) {
          for (const mb of band.member_bands) {
            bandLookup.set(mb.band_id, { ...mb, member_bands: [] });
            if (mb.subdomain)
              subdomainLookup.set(mb.subdomain.toLowerCase(), { ...mb, member_bands: [] });
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
          await supabase.from("bandcamp_connections").update(updatePayload).eq("id", connection.id);
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

        const variants: Array<{ id: string; sku: string }> = [];
        {
          const PAGE = 1000;
          let offset = 0;
          while (true) {
            const { data: page } = await supabase
              .from("warehouse_product_variants")
              .select("id, sku")
              .eq("workspace_id", workspaceId)
              .range(offset, offset + PAGE - 1);
            if (!page || page.length === 0) break;
            variants.push(...page);
            if (page.length < PAGE) break;
            offset += PAGE;
          }
        }

        lastVariantQueryCount = variants.length;
        logger.info("Loaded variants for SKU matching", {
          workspaceId,
          variantCount: lastVariantQueryCount,
        });

        const { matched, unmatched } = matchSkuToVariants(merchItems, variants);
        totalMerchItems += merchItems.length;
        unmatchedMerchCount += unmatched.length;

        // ── Matched items ──────────────────────────────────────────────────────

        for (const { merchItem, variantId } of matched) {
          // Extract option SKUs for GIN-indexed lookups
          const optionSkus = (merchItem.options ?? [])
            .map((o) => o.sku)
            .filter((s): s is string => !!s);

          // Bandcamp-permanent fields: always updated from API regardless of authority_status
          const upsertPayload: Record<string, unknown> = {
            workspace_id: workspaceId,
            variant_id: variantId,
            bandcamp_item_id: merchItem.package_id,
            bandcamp_item_type: merchItem.item_type?.toLowerCase().includes("album")
              ? "album"
              : "package",
            bandcamp_member_band_id: merchItem.member_band_id,
            bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
            bandcamp_subdomain: merchItem.subdomain ?? null,
            bandcamp_album_title: merchItem.album_title ?? null,
            bandcamp_price: merchItem.price ?? null,
            bandcamp_currency: merchItem.currency ?? null,
            bandcamp_is_set_price:
              merchItem.is_set_price != null ? Boolean(merchItem.is_set_price) : null,
            bandcamp_options: merchItem.options ?? null,
            bandcamp_origin_quantities: merchItem.origin_quantities ?? null,
            bandcamp_new_date: merchItem.new_date ?? null,
            bandcamp_option_skus: optionSkus.length > 0 ? optionSkus : null,
            last_quantity_sold: merchItem.quantity_sold,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            raw_api_data: merchItem,
          };

          // Classify product category from API data
          upsertPayload.product_category = classifyProduct(
            merchItem.item_type ?? null,
            merchItem.url ?? null,
            merchItem.title ?? null,
          );

          // Only overwrite URL if the API actually provides one — avoid nullifying
          // URLs that were set by the sales backfill or scraper
          if (merchItem.url) {
            upsertPayload.bandcamp_url = merchItem.url;
            upsertPayload.bandcamp_url_source = "orders_api";
          }

          const { error: upsertError } = await supabase
            .from("bandcamp_product_mappings")
            .upsert(upsertPayload, { onConflict: "variant_id" });

          if (upsertError) {
            logger.error("Mapping upsert failed", {
              variantId,
              error: upsertError.message,
              url: upsertPayload.bandcamp_url,
              subdomain: upsertPayload.bandcamp_subdomain,
            });
            itemsFailed++;
            continue;
          }

          // Read current mapping authority + scraped preorder data for conditional updates
          const { data: mapping } = await supabase
            .from("bandcamp_product_mappings")
            .select("authority_status, bandcamp_release_date, bandcamp_is_preorder")
            .eq("variant_id", variantId)
            .single();

          const authorityStatus = mapping?.authority_status ?? "bandcamp_initial";

          const { data: existingVar } = await supabase
            .from("warehouse_product_variants")
            .select("id, sku, price, cost, product_id, street_date, is_preorder")
            .eq("id", variantId)
            .single();

          // Preorder detection runs for ALL authority levels — a warehouse_reviewed product
          // can still become a preorder when Bandcamp publishes a future release date.
          // This is intentionally separate from the bandcamp_initial operational block below.
          if (existingVar) {
            const preorderDerived = deriveStreetDateAndPreorder({
              scraperReleaseDate: mapping?.bandcamp_release_date,
              merchNewDate: merchItem.new_date,
              bandcampIsPreorder: mapping?.bandcamp_is_preorder,
              currentStreetDate: existingVar.street_date,
              authorityStatus, // honours warehouse authority for overwrite rules
            });

            const preorderUpdates: Record<string, unknown> = {};

            // Always correct street_date when scraper has a better future date —
            // bandcamp_new_date (listing date) is frequently wrong for preorders
            if (
              preorderDerived.street_date &&
              preorderDerived.street_date !== existingVar.street_date &&
              mapping?.bandcamp_release_date // only when scraper date is the source
            ) {
              preorderUpdates.street_date = preorderDerived.street_date;
            }

            if (preorderDerived.is_preorder !== existingVar.is_preorder) {
              preorderUpdates.is_preorder = preorderDerived.is_preorder;
            }

            if (Object.keys(preorderUpdates).length > 0) {
              preorderUpdates.updated_at = new Date().toISOString();
              await supabase
                .from("warehouse_product_variants")
                .update(preorderUpdates)
                .eq("id", variantId);

              if (preorderUpdates.is_preorder === true) {
                await preorderSetupTask.trigger({
                  variant_id: variantId,
                  workspace_id: workspaceId,
                });
                logger.info("Triggered preorder-setup (all-authority path)", {
                  variantId,
                  sku: existingVar.sku,
                  authorityStatus,
                  releaseDate: preorderDerived.street_date,
                });
              }
            }
          }

          if (existingVar && authorityStatus === "bandcamp_initial") {
            // Bandcamp owns operational fields during initial ingest only
            const updates: Record<string, unknown> = {};

            // SKU overwrite with audit trail
            if (merchItem.sku && existingVar.sku !== merchItem.sku) {
              const { data: collision } = await supabase
                .from("warehouse_product_variants")
                .select("id")
                .eq("workspace_id", workspaceId)
                .eq("sku", merchItem.sku)
                .neq("id", variantId)
                .limit(1);

              if (!collision?.length) {
                await supabase
                  .from("channel_sync_log")
                  .insert({
                    workspace_id: workspaceId,
                    channel: "bandcamp",
                    sync_type: "sku_overwrite",
                    status: "completed",
                    items_processed: 1,
                    started_at: new Date().toISOString(),
                    completed_at: new Date().toISOString(),
                    metadata: {
                      variant_id: variantId,
                      old_sku: existingVar.sku,
                      new_sku: merchItem.sku,
                      bandcamp_item_id: merchItem.package_id,
                    },
                  })
                  .then(
                    () => {},
                    (err) =>
                      logger.warn("channel_sync_log insert failed", {
                        error: String(err),
                        task: "bandcamp-sync",
                        context: "sku_overwrite_audit",
                      }),
                  );
                updates.sku = merchItem.sku;
              } else {
                logger.warn("SKU collision — skipping overwrite", {
                  old: existingVar.sku,
                  new: merchItem.sku,
                  collidesWithVariant: collision[0].id,
                });
              }
            }

            // Price
            if (merchItem.price != null && (existingVar.price == null || existingVar.price === 0)) {
              updates.price = merchItem.price;
            }
            // Cost is not derived from price — leave null until actual cost data is available

            // Street date — for bandcamp_initial only; all-authority preorder path is above
            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString();
              await supabase.from("warehouse_product_variants").update(updates).eq("id", variantId);
            }

            // Inventory seeding: if warehouse is 0 and Bandcamp has stock, seed once.
            // Phase 1 follow-up #2: trust the origin allocation sum (controlled
            // stock), NOT customer-facing TOP `quantity_available` (which can be
            // inflated by merchant baselines per Part 9 audit). Origin sum is the
            // only safe seed source for Phase 4's bidirectional bridge.
            const seedDecision = computeBandcampSeedQuantity(merchItem);
            if (seedDecision.effective > 0) {
              const { data: inv } = await supabase
                .from("warehouse_inventory_levels")
                .select("available")
                .eq("variant_id", variantId)
                .single();

              if (inv && inv.available === 0) {
                const seedSku = (updates.sku as string | undefined) ?? existingVar.sku;
                if (seedSku) {
                  await recordInventoryChange({
                    workspaceId,
                    sku: seedSku,
                    delta: seedDecision.effective,
                    source: "backfill",
                    correlationId: `bandcamp-seed:${connection.band_id}:${merchItem.package_id}:initial`,
                    metadata: {
                      band_id: connection.band_id,
                      bandcamp_item_id: merchItem.package_id,
                      effective_source: seedDecision.source,
                      effective_quantity: seedDecision.effective,
                      top_quantity_available: merchItem.quantity_available ?? null,
                    },
                  });
                  logger.info("Seeded inventory from Bandcamp", {
                    sku: seedSku,
                    quantity: seedDecision.effective,
                    source: seedDecision.source,
                    top_quantity: merchItem.quantity_available ?? null,
                  });
                }
              }
            }
          } else if (existingVar) {
            // warehouse_reviewed or warehouse_locked: cost is not derived from price

            // API image backfill — only if product has no images yet
            if (bandcampImageUrl(merchItem.image_url) && existingVar.product_id) {
              const { count: imgCount } = await supabase
                .from("warehouse_product_images")
                .select("id", { count: "exact", head: true })
                .eq("product_id", existingVar.product_id);

              if ((imgCount ?? 0) === 0) {
                const imgSrc = bandcampImageUrl(merchItem.image_url) as string;
                await supabase.from("warehouse_product_images").insert({
                  product_id: existingVar.product_id,
                  workspace_id: workspaceId,
                  src: imgSrc,
                  alt: merchItem.title,
                  position: 0,
                });
                await supabase
                  .from("warehouse_products")
                  .update({ images: [{ src: imgSrc }] })
                  .eq("id", existingVar.product_id);

                // Push to Shopify (best-effort)
                const { data: prod } = await supabase
                  .from("warehouse_products")
                  .select("shopify_product_id")
                  .eq("id", existingVar.product_id)
                  .single();
                if (prod?.shopify_product_id) {
                  try {
                    await productCreateMedia(prod.shopify_product_id, [
                      { originalSource: imgSrc, alt: merchItem.title, mediaContentType: "IMAGE" },
                    ]);
                  } catch (err) {
                    logger.warn("Failed to push backfilled image to Shopify", {
                      productId: existingVar.product_id,
                      error: String(err),
                    });
                  }
                }
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

        // Collect existing SKUs for collision detection during auto-generation
        const existingSkuSet = new Set(variants.map((v) => v.sku));

        const enableSkuPush =
          (workspaceSettings?.bandcamp_scraper_settings as Record<string, unknown>)
            ?.enable_sku_push === true;

        for (const merchItem of unmatched) {
          const memberBand = merchItem.member_band_id
            ? bandLookup.get(merchItem.member_band_id)
            : null;
          const subdomainBand = merchItem.subdomain
            ? subdomainLookup.get(merchItem.subdomain.toLowerCase())
            : null;
          // Prefer subdomain-resolved artist when member_band_id points to the
          // label itself (or is absent). This prevents albums from inheriting
          // the label name as the artist.
          const isLabelMemberBand = memberBand && band && memberBand.band_id === band.band_id;
          const artistName =
            (!isLabelMemberBand && memberBand?.name) ||
            subdomainBand?.name ||
            memberBand?.name ||
            band?.name ||
            connection.band_name ||
            "Unknown Artist";

          // Auto-generate SKU if missing
          let effectiveSku = merchItem.sku;
          let skuGenerated = false;
          if (!effectiveSku) {
            effectiveSku = generateSku(merchItem, artistName, existingSkuSet);
            skuGenerated = true;
            logger.info("Auto-generated SKU", {
              sku: effectiveSku,
              title: merchItem.title,
              packageId: merchItem.package_id,
            });

            // Push generated SKU to Bandcamp so both sides match
            if (enableSkuPush) {
              try {
                await updateSku(
                  [{ id: merchItem.package_id, id_type: "p", sku: effectiveSku }],
                  accessToken,
                );
                logger.info("Pushed generated SKU to Bandcamp", {
                  sku: effectiveSku,
                  packageId: merchItem.package_id,
                });
              } catch (err) {
                logger.warn("Failed to push SKU to Bandcamp", {
                  sku: effectiveSku,
                  error: String(err),
                });
              }
            }
          }

          const title = assembleBandcampTitle(
            artistName,
            merchItem.album_title,
            merchItem.title,
            merchItem.item_type,
          );
          const tags: string[] = [];
          if (merchItem.new_date && new Date(merchItem.new_date) > new Date()) {
            tags.push("Pre-Order", "New Releases");
          }

          // Primary dedup key: a Bandcamp package should map to one variant per workspace.
          // SKU-only matching can miss when upstream SKU strings drift.
          const { data: existingMappingByPackage } = await supabase
            .from("bandcamp_product_mappings")
            .select("id, variant_id")
            .eq("workspace_id", workspaceId)
            .eq("bandcamp_item_id", merchItem.package_id)
            .maybeSingle();

          if (existingMappingByPackage) {
            await supabase
              .from("bandcamp_product_mappings")
              .update({
                bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
                bandcamp_type_name: merchItem.item_type,
                product_category: classifyProduct(
                  merchItem.item_type ?? null,
                  merchItem.url ?? null,
                  merchItem.title ?? null,
                ),
                bandcamp_new_date: merchItem.new_date,
                bandcamp_url: merchItem.url ?? null,
                bandcamp_url_source: merchItem.url ? "orders_api" : null,
                bandcamp_subdomain: merchItem.subdomain ?? null,
                bandcamp_album_title: merchItem.album_title ?? null,
                bandcamp_price: merchItem.price ?? null,
                bandcamp_currency: merchItem.currency ?? null,
                bandcamp_is_set_price:
                  merchItem.is_set_price != null ? Boolean(merchItem.is_set_price) : null,
                bandcamp_options: merchItem.options ?? null,
                bandcamp_origin_quantities: merchItem.origin_quantities ?? null,
                bandcamp_option_skus: (merchItem.options ?? [])
                  .map((o) => o.sku)
                  .filter((s): s is string => !!s),
                last_quantity_sold: merchItem.quantity_sold,
                last_synced_at: new Date().toISOString(),
                raw_api_data: merchItem,
              })
              .eq("id", existingMappingByPackage.id);
            itemsProcessed++;
            continue;
          }

          // Phase A — Apparel multi-variant create path.
          //
          // When a Bandcamp package exposes >=2 distinct option SKUs (typically
          // apparel sizes), each option must materialize as a first-class
          // warehouse_product_variants row + Shopify variant. We CANNOT add
          // multiple bandcamp_product_mappings rows per package because of
          // unique index `uq_bandcamp_mappings_workspace_item_id` on
          // (workspace_id, bandcamp_item_id) — option attribution lives on
          // each variant via `bandcamp_option_id` / `bandcamp_option_title`
          // (migration 20260420000005_variant_bandcamp_option.sql).
          const multiOptions = detectMultiVariantOptions(merchItem.options);

          if (multiOptions) {
            const optionSkus = multiOptions.map((o) => o.sku);

            // Pre-flight collision check: if ANY option SKU already exists as a
            // variant in this workspace we cannot safely auto-merge — the
            // existing variant might be tied to a different package, Shopify
            // product, or live inventory. Park as a review item and skip.
            const { data: collisions } = await supabase
              .from("warehouse_product_variants")
              .select("sku")
              .eq("workspace_id", workspaceId)
              .in("sku", optionSkus);

            if (collisions && collisions.length > 0) {
              await supabase.from("warehouse_review_queue").upsert(
                {
                  workspace_id: workspaceId,
                  org_id: connection.org_id ?? null,
                  category: "bandcamp_apparel_sku_collision",
                  severity: "high" as const,
                  title: `Apparel option SKU collision: ${merchItem.title}`,
                  description:
                    "Bandcamp package exposes multiple option SKUs but one or more already exist as warehouse variants. Manual reconciliation required.",
                  metadata: {
                    bandcamp_item_id: String(merchItem.package_id),
                    band_id: String(connection.band_id),
                    option_skus: optionSkus,
                    collided_skus: collisions.map((c) => c.sku),
                    title: merchItem.title,
                  },
                  status: "open" as const,
                  group_key: `bandcamp_apparel_collision_${workspaceId}_${merchItem.package_id}`,
                  occurrence_count: 1,
                },
                { onConflict: "group_key", ignoreDuplicates: false },
              );
              itemsFailed++;
              continue;
            }

            const bcPrice = merchItem.price ?? null;
            const bcCurrency = (merchItem.currency as string) ?? "USD";
            const bcCost: number | null = null;
            const bcBarcode =
              ((merchItem as Record<string, unknown>).barcode as string | null) ?? null;
            const productCategory = classifyProduct(
              merchItem.item_type ?? null,
              merchItem.url ?? null,
              merchItem.title ?? null,
            );

            let collectionId: string | null = null;
            try {
              collectionId = await findOrCreateCollection(band?.name ?? connection.band_name);
            } catch {
              // Non-critical
            }

            // DB-first: warehouse_products (no Shopify ID yet)
            const { data: parentProduct, error: parentProductError } = await supabase
              .from("warehouse_products")
              .insert({
                workspace_id: workspaceId,
                org_id: connection.org_id,
                shopify_product_id: null,
                title,
                vendor: band?.name ?? connection.band_name,
                product_type: merchItem.item_type ?? "Merch",
                status: "draft",
                tags,
              })
              .select("id")
              .single();

            if (parentProductError || !parentProduct) {
              logger.error("Failed to create apparel parent product", {
                package_id: merchItem.package_id,
                error: parentProductError?.message,
              });
              itemsFailed++;
              continue;
            }

            if (bandcampImageUrl(merchItem.image_url)) {
              await supabase.from("warehouse_product_images").insert({
                product_id: parentProduct.id,
                src: bandcampImageUrl(merchItem.image_url),
                alt: title,
                position: 0,
              });
            }

            // Insert N variants in a single call so all-or-nothing semantics hold.
            const optionName = inferOptionName(multiOptions.map((o) => o.title));
            const variantRows = multiOptions.map((opt, idx) => ({
              product_id: parentProduct.id,
              workspace_id: workspaceId,
              sku: opt.sku,
              title: optionDisplayValue(opt, idx),
              price: bcPrice,
              cost: bcCost,
              weight: CATEGORY_DEFAULT_WEIGHTS[productCategory]?.value ?? 0.5,
              weight_unit: "lb",
              bandcamp_url: merchItem.url ?? null,
              street_date: merchItem.new_date,
              is_preorder: tags.includes("Pre-Order"),
              option1_name: optionName,
              option1_value: optionDisplayValue(opt, idx),
              bandcamp_option_id: opt.optionId,
              bandcamp_option_title: opt.title || null,
            }));

            const { data: insertedVariants, error: variantInsertError } = await supabase
              .from("warehouse_product_variants")
              .insert(variantRows)
              .select("id, sku");

            if (variantInsertError || !insertedVariants || insertedVariants.length === 0) {
              logger.error("Failed to create apparel variants", {
                package_id: merchItem.package_id,
                error: variantInsertError?.message ?? "missing variant ids",
                code: variantInsertError?.code ?? null,
              });

              await supabase.from("warehouse_products").delete().eq("id", parentProduct.id);
              await supabase.from("warehouse_review_queue").upsert(
                {
                  workspace_id: workspaceId,
                  org_id: connection.org_id ?? null,
                  category: "bandcamp_sync_variant_create_failed",
                  severity: "high" as const,
                  title: `Bandcamp apparel variant insert failed: ${merchItem.title}`,
                  description:
                    "Bandcamp sync could not create the per-option warehouse variants for an apparel package; parent product row was rolled back before any Shopify create.",
                  metadata: {
                    bandcamp_item_id: String(merchItem.package_id),
                    band_id: String(connection.band_id),
                    pg_error: variantInsertError?.message ?? null,
                    pg_code: variantInsertError?.code ?? null,
                    option_skus: optionSkus,
                  },
                  status: "open" as const,
                  group_key: `bandcamp_apparel_variant_create_failed_${workspaceId}_${merchItem.package_id}`,
                  occurrence_count: 1,
                },
                { onConflict: "group_key", ignoreDuplicates: false },
              );
              itemsFailed++;
              continue;
            }

            // Stable order for downstream operations: match insertion (option) order.
            const variantBySku = new Map(insertedVariants.map((v) => [v.sku.toUpperCase(), v]));
            const orderedVariants = multiOptions.map((opt) => {
              const found = variantBySku.get(opt.sku.toUpperCase());
              if (!found) {
                throw new Error(
                  `Apparel variant lookup failed: SKU ${opt.sku} not in insertedVariants`,
                );
              }
              return { ...found, option: opt };
            });
            const primary = orderedVariants[0];

            // Seed inventory rows + apply Bandcamp quantities via canonical write path.
            for (const v of orderedVariants) {
              await supabase.from("warehouse_inventory_levels").upsert(
                {
                  variant_id: v.id,
                  workspace_id: workspaceId,
                  sku: v.sku,
                  available: 0,
                  committed: 0,
                  incoming: 0,
                },
                { onConflict: "variant_id", ignoreDuplicates: true },
              );

              if (v.option.quantityAvailable > 0) {
                await recordInventoryChange({
                  workspaceId,
                  sku: v.sku,
                  delta: v.option.quantityAvailable,
                  source: "backfill",
                  correlationId: `bandcamp-seed:${connection.band_id}:${merchItem.package_id}:opt:${v.option.optionId ?? v.sku}`,
                  metadata: {
                    band_id: connection.band_id,
                    package_id: merchItem.package_id,
                    bandcamp_option_id: v.option.optionId,
                    bandcamp_option_title: v.option.title,
                    apparel_multi_variant: true,
                  },
                });
              }
              existingSkuSet.add(v.sku);
            }

            // Single mapping row per package (unique index requires it). The
            // mapping points at the FIRST option as the "primary" variant; per-
            // option attribution lives on each variant via bandcamp_option_id.
            const newOptionSkus = multiOptions.map((o) => o.sku);
            const { error: mappingInsertError } = await supabase
              .from("bandcamp_product_mappings")
              .insert({
                workspace_id: workspaceId,
                variant_id: primary.id,
                bandcamp_item_id: merchItem.package_id,
                bandcamp_item_type: merchItem.item_type?.toLowerCase().includes("album")
                  ? "album"
                  : "package",
                bandcamp_member_band_id: merchItem.member_band_id,
                bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
                bandcamp_type_name: merchItem.item_type,
                product_category: productCategory,
                bandcamp_new_date: merchItem.new_date,
                bandcamp_url: merchItem.url ?? null,
                bandcamp_url_source: merchItem.url ? "orders_api" : null,
                bandcamp_subdomain: merchItem.subdomain ?? null,
                bandcamp_album_title: merchItem.album_title ?? null,
                bandcamp_price: merchItem.price ?? null,
                bandcamp_currency: merchItem.currency ?? null,
                bandcamp_is_set_price:
                  merchItem.is_set_price != null ? Boolean(merchItem.is_set_price) : null,
                bandcamp_options: merchItem.options ?? null,
                bandcamp_origin_quantities: merchItem.origin_quantities ?? null,
                bandcamp_option_skus: newOptionSkus,
                last_quantity_sold: merchItem.quantity_sold,
                last_synced_at: new Date().toISOString(),
                authority_status: "bandcamp_initial",
                raw_api_data: merchItem,
              });

            if (mappingInsertError) {
              logger.error("Failed to create apparel mapping; rolling back", {
                package_id: merchItem.package_id,
                error: mappingInsertError.message,
              });
              await supabase
                .from("warehouse_product_variants")
                .delete()
                .in(
                  "id",
                  insertedVariants.map((v) => v.id),
                );
              await supabase.from("warehouse_products").delete().eq("id", parentProduct.id);
              itemsFailed++;
              continue;
            }

            if (tags.includes("Pre-Order")) {
              await preorderSetupTask.trigger({
                variant_id: primary.id,
                workspace_id: workspaceId,
              });
            }

            await triggerScrapeIfNeeded(
              supabase,
              primary.id,
              workspaceId,
              band,
              connection,
              merchItem,
            );

            // Shopify CREATE — multi-variant productSet payload.
            let shopifyProductIdMV: string | null = null;
            try {
              shopifyProductIdMV = normalizeShopifyProductId(
                await productSetCreate({
                  title,
                  status: "DRAFT",
                  vendor: band?.name ?? connection.band_name,
                  productType: merchItem.item_type ?? "Merch",
                  tags,
                  ...(collectionId ? { collections: [collectionId] } : {}),
                  productOptions: [
                    {
                      name: optionName,
                      values: orderedVariants.map((v, idx) => ({
                        name: optionDisplayValue(v.option, idx),
                      })),
                    },
                  ],
                  variants: orderedVariants.map((v, idx) =>
                    buildShopifyVariantInput({
                      sku: v.sku,
                      optionName,
                      optionValue: optionDisplayValue(v.option, idx),
                      price: bcPrice,
                      cost: bcCost,
                      currency: bcCurrency,
                      barcode: bcBarcode,
                      category: productCategory,
                    }),
                  ),
                  ...(bandcampImageUrl(merchItem.image_url)
                    ? {
                        files: [
                          {
                            originalSource: bandcampImageUrl(merchItem.image_url),
                            alt: title,
                          },
                        ],
                      }
                    : {}),
                }),
              );

              logger.info("Created Shopify DRAFT product (multi-variant)", {
                package_id: merchItem.package_id,
                shopifyProductId: shopifyProductIdMV,
                variant_count: orderedVariants.length,
              });

              await supabase
                .from("warehouse_products")
                .update({
                  shopify_product_id: shopifyProductIdMV,
                  synced_at: new Date().toISOString(),
                })
                .eq("id", parentProduct.id);

              const { data: attachedRow, error: attachError } = await supabase
                .from("warehouse_products")
                .select("id")
                .eq("id", parentProduct.id)
                .eq("shopify_product_id", shopifyProductIdMV)
                .maybeSingle();

              if (attachError || !attachedRow) {
                // Non-null assertion: productSetCreate just succeeded above
                // (line ~1843), so shopifyProductIdMV is guaranteed string here.
                // The let-typed `string | null` keeps TS from narrowing it
                // automatically inside this branch.
                await productArchive(shopifyProductIdMV as string);
                logger.error(
                  "Archived multi-variant Shopify product after DB attach verification failed",
                  {
                    package_id: merchItem.package_id,
                    shopifyProductId: shopifyProductIdMV,
                    attachError: attachError?.message ?? null,
                  },
                );
                await supabase.from("warehouse_review_queue").upsert(
                  {
                    workspace_id: workspaceId,
                    org_id: connection.org_id ?? null,
                    category: "shopify_product_create",
                    severity: "high" as const,
                    title: `Shopify apparel product auto-archived: attach failed (${merchItem.title})`,
                    description:
                      "Shopify multi-variant product was created but failed post-create DB attach verification; product was immediately archived.",
                    metadata: {
                      bandcamp_item_id: String(merchItem.package_id),
                      shopify_product_id: shopifyProductIdMV,
                      warehouse_product_id: parentProduct.id,
                      attach_error: attachError?.message ?? null,
                    },
                    status: "open" as const,
                    group_key: `shopify_attach_failed_apparel_${workspaceId}_${merchItem.package_id}`,
                    occurrence_count: 1,
                  },
                  { onConflict: "group_key", ignoreDuplicates: false },
                );
                itemsFailed++;
                continue;
              }

              try {
                await publishToSafeChannels(shopifyProductIdMV);
              } catch (pubErr) {
                logger.warn("Failed to publish multi-variant product to channels", {
                  shopifyProductId: shopifyProductIdMV,
                  error: String(pubErr),
                });
              }

              // Back-fill shopify_variant_id + shopify_inventory_item_id per
              // warehouse variant (matched by SKU). Also set per-variant weight
              // since productSet's measurement field doesn't always propagate.
              try {
                const shopVariants = await fetchProductVariantsByProductId(shopifyProductIdMV);
                const shopBySku = new Map<string, (typeof shopVariants)[number]>();
                for (const sv of shopVariants) {
                  if (sv.sku) shopBySku.set(sv.sku.toUpperCase(), sv);
                }
                const weight = CATEGORY_DEFAULT_WEIGHTS[productCategory];

                for (const v of orderedVariants) {
                  const sv = shopBySku.get(v.sku.toUpperCase());
                  if (!sv) continue;
                  await supabase
                    .from("warehouse_product_variants")
                    .update({
                      shopify_variant_id: sv.id,
                      shopify_inventory_item_id: sv.inventoryItemId,
                    })
                    .eq("id", v.id);

                  if (weight && sv.inventoryItemId) {
                    try {
                      await inventoryItemUpdate(sv.inventoryItemId, {
                        measurement: { weight: { value: weight.value, unit: weight.unit } },
                      });
                    } catch (weightErr) {
                      logger.warn("Failed to set apparel variant weight", {
                        shopifyProductId: shopifyProductIdMV,
                        sku: v.sku,
                        error: String(weightErr),
                      });
                    }
                  }
                }
              } catch (backfillErr) {
                logger.warn("Failed to back-fill apparel Shopify variant IDs", {
                  shopifyProductId: shopifyProductIdMV,
                  error: String(backfillErr),
                });
              }
            } catch (shopifyError) {
              logger.error(
                "Failed to create multi-variant Shopify product, continuing warehouse-only",
                {
                  package_id: merchItem.package_id,
                  error: String(shopifyError),
                },
              );
              await supabase.from("warehouse_review_queue").upsert(
                {
                  workspace_id: workspaceId,
                  org_id: connection.org_id ?? null,
                  category: "shopify_product_create",
                  severity: "medium" as const,
                  title: `Shopify apparel product creation failed: ${title}`,
                  description: `Multi-variant Shopify product creation failed for package ${merchItem.package_id}.`,
                  metadata: {
                    bandcamp_item_id: String(merchItem.package_id),
                    band_id: String(connection.band_id),
                    warehouse_product_id: parentProduct.id,
                    option_skus: optionSkus,
                    error: String(shopifyError),
                  },
                  status: "open" as const,
                  group_key: `shopify_create_failed_apparel_${workspaceId}_${merchItem.package_id}`,
                  occurrence_count: 1,
                },
                { onConflict: "group_key", ignoreDuplicates: false },
              );
            }

            itemsProcessed++;
            continue;
          }

          const { data: existingVariant } = await supabase
            .from("warehouse_product_variants")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("sku", effectiveSku)
            .maybeSingle();

          if (existingVariant) {
            // SKU exists from a prior run or Shopify sync -- ensure a mapping row exists
            const { data: existingMapping } = await supabase
              .from("bandcamp_product_mappings")
              .select("id")
              .eq("variant_id", existingVariant.id)
              .maybeSingle();

            if (!existingMapping) {
              const newOptionSkus = (merchItem.options ?? [])
                .map((o) => o.sku)
                .filter((s): s is string => !!s);
              await supabase
                .from("bandcamp_product_mappings")
                .insert({
                  workspace_id: workspaceId,
                  variant_id: existingVariant.id,
                  bandcamp_item_id: merchItem.package_id,
                  bandcamp_item_type: merchItem.item_type?.toLowerCase().includes("album")
                    ? "album"
                    : "package",
                  bandcamp_member_band_id: merchItem.member_band_id,
                  bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
                  bandcamp_type_name: merchItem.item_type,
                  product_category: classifyProduct(
                    merchItem.item_type ?? null,
                    merchItem.url ?? null,
                    merchItem.title ?? null,
                  ),
                  bandcamp_new_date: merchItem.new_date,
                  bandcamp_url: merchItem.url ?? null,
                  bandcamp_url_source: merchItem.url ? "orders_api" : null,
                  bandcamp_subdomain: merchItem.subdomain ?? null,
                  bandcamp_album_title: merchItem.album_title ?? null,
                  bandcamp_price: merchItem.price ?? null,
                  bandcamp_currency: merchItem.currency ?? null,
                  bandcamp_is_set_price:
                    merchItem.is_set_price != null ? Boolean(merchItem.is_set_price) : null,
                  bandcamp_options: merchItem.options ?? null,
                  bandcamp_origin_quantities: merchItem.origin_quantities ?? null,
                  bandcamp_option_skus: newOptionSkus.length > 0 ? newOptionSkus : null,
                  last_quantity_sold: merchItem.quantity_sold,
                  last_synced_at: new Date().toISOString(),
                  authority_status: "bandcamp_initial",
                  raw_api_data: merchItem,
                })
                .then(
                  () => {
                    itemsProcessed++;
                  },
                  (err) => {
                    logger.warn("Failed to create mapping for existing SKU", {
                      error: String(err),
                      sku: effectiveSku,
                    });
                    itemsFailed++;
                  },
                );
            } else {
              itemsProcessed++;
            }
            continue;
          }

          const bcPrice = merchItem.price ?? null;
          const bcCurrency = (merchItem.currency as string) ?? "USD";
          const bcCost: number | null = null;
          const bcBarcode =
            ((merchItem as Record<string, unknown>).barcode as string | null) ?? null;
          const productCategory = classifyProduct(
            merchItem.item_type ?? null,
            merchItem.url ?? null,
            merchItem.title ?? null,
          );

          let collectionId: string | null = null;
          try {
            collectionId = await findOrCreateCollection(band?.name ?? connection.band_name);
          } catch {
            // Non-critical — product still gets created without collection
          }

          // DB-first creation order prevents leaking duplicate Shopify drafts when
          // variant insert collides on UNIQUE(workspace_id, sku).
          let shopifyProductId: string | null = null;

          const { data: product, error: productError } = await supabase
            .from("warehouse_products")
            .insert({
              workspace_id: workspaceId,
              org_id: connection.org_id,
              shopify_product_id: null,
              title,
              vendor: band?.name ?? connection.band_name,
              product_type: merchItem.item_type ?? "Merch",
              status: "draft",
              tags,
            })
            .select("id")
            .single();

          if (productError || !product) {
            logger.error("Failed to create product", {
              sku: effectiveSku,
              error: productError?.message,
            });
            itemsFailed++;
            continue;
          }

          if (bandcampImageUrl(merchItem.image_url)) {
            await supabase.from("warehouse_product_images").insert({
              product_id: product.id,
              src: bandcampImageUrl(merchItem.image_url),
              alt: title,
              position: 0,
            });
          }

          const { data: newVariant, error: variantInsertError } = await supabase
            .from("warehouse_product_variants")
            .insert({
              product_id: product.id,
              workspace_id: workspaceId,
              sku: effectiveSku,
              title: merchItem.title,
              price: bcPrice,
              cost: bcCost,
              weight: CATEGORY_DEFAULT_WEIGHTS[productCategory]?.value ?? 0.5,
              weight_unit: "lb",
              bandcamp_url: merchItem.url ?? null,
              street_date: merchItem.new_date,
              is_preorder: tags.includes("Pre-Order"),
            })
            .select("id")
            .single();

          if (variantInsertError || !newVariant) {
            logger.error("Failed to create variant in unmatched path", {
              sku: effectiveSku,
              error: variantInsertError?.message ?? "missing variant id",
              code: variantInsertError?.code ?? null,
            });

            await supabase.from("warehouse_products").delete().eq("id", product.id);
            await supabase.from("warehouse_review_queue").upsert(
              {
                workspace_id: workspaceId,
                org_id: connection.org_id ?? null,
                category: "bandcamp_sync_variant_create_failed",
                severity: "high" as const,
                title: `Bandcamp variant creation failed: ${effectiveSku}`,
                description:
                  "Bandcamp sync could not create the warehouse variant; draft warehouse product row was rolled back before any Shopify create.",
                metadata: {
                  sku: effectiveSku,
                  bandcamp_item_id: String(merchItem.package_id),
                  band_id: String(connection.band_id),
                  pg_error: variantInsertError?.message ?? null,
                  pg_code: variantInsertError?.code ?? null,
                },
                status: "open" as const,
                group_key: `bandcamp_variant_create_failed_${workspaceId}_${effectiveSku}`,
                occurrence_count: 1,
              },
              { onConflict: "group_key", ignoreDuplicates: false },
            );

            itemsFailed++;
            continue;
          } else {
            // Step 1: Seed inventory row at zero (safe baseline)
            await supabase.from("warehouse_inventory_levels").upsert(
              {
                variant_id: newVariant.id,
                workspace_id: workspaceId,
                sku: effectiveSku,
                available: 0,
                committed: 0,
                incoming: 0,
              },
              { onConflict: "variant_id", ignoreDuplicates: true },
            );

            // Step 2: Apply actual Bandcamp quantity via canonical write path (Rule #20).
            // This ensures Redis is updated and fanout pushes to Bandcamp + client stores.
            // Phase 1 follow-up #2: seed from origin allocation sum (controlled
            // stock), NOT TOP quantity_available which can be inflated by merchant
            // baselines (Part 9). Single-origin merchants without origin tracking
            // fall back to TOP via `computeBandcampSeedQuantity`.
            const seedDecision = computeBandcampSeedQuantity(merchItem);
            if (seedDecision.effective > 0) {
              await recordInventoryChange({
                workspaceId,
                sku: effectiveSku,
                delta: seedDecision.effective,
                source: "backfill",
                correlationId: `bandcamp-seed:${connection.band_id}:${merchItem.package_id}`,
                metadata: {
                  band_id: connection.band_id,
                  package_id: merchItem.package_id,
                  effective_source: seedDecision.source,
                  effective_quantity: seedDecision.effective,
                  top_quantity_available: merchItem.quantity_available ?? null,
                },
              });
            }

            logger.info("Seeded initial inventory", {
              sku: effectiveSku,
              available: seedDecision.effective,
              source: seedDecision.source,
              top_quantity: merchItem.quantity_available ?? null,
              skuGenerated,
            });

            const newOptionSkus = (merchItem.options ?? [])
              .map((o) => o.sku)
              .filter((s): s is string => !!s);
            await supabase.from("bandcamp_product_mappings").insert({
              workspace_id: workspaceId,
              variant_id: newVariant.id,
              bandcamp_item_id: merchItem.package_id,
              bandcamp_item_type: merchItem.item_type?.toLowerCase().includes("album")
                ? "album"
                : "package",
              bandcamp_member_band_id: merchItem.member_band_id,
              bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
              bandcamp_type_name: merchItem.item_type,
              product_category: classifyProduct(
                merchItem.item_type ?? null,
                merchItem.url ?? null,
                merchItem.title ?? null,
              ),
              bandcamp_new_date: merchItem.new_date,
              bandcamp_url: merchItem.url ?? null,
              bandcamp_url_source: merchItem.url ? "orders_api" : null,
              bandcamp_subdomain: merchItem.subdomain ?? null,
              bandcamp_album_title: merchItem.album_title ?? null,
              bandcamp_price: merchItem.price ?? null,
              bandcamp_currency: merchItem.currency ?? null,
              bandcamp_is_set_price:
                merchItem.is_set_price != null ? Boolean(merchItem.is_set_price) : null,
              bandcamp_options: merchItem.options ?? null,
              bandcamp_origin_quantities: merchItem.origin_quantities ?? null,
              bandcamp_option_skus: newOptionSkus.length > 0 ? newOptionSkus : null,
              last_quantity_sold: merchItem.quantity_sold,
              last_synced_at: new Date().toISOString(),
              authority_status: "bandcamp_initial",
              raw_api_data: merchItem,
            });

            if (tags.includes("Pre-Order")) {
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

            const { data: mappingBeforeShopifyCreate, error: mappingCheckError } = await supabase
              .from("bandcamp_product_mappings")
              .select("id, variant_id")
              .eq("workspace_id", workspaceId)
              .eq("bandcamp_item_id", merchItem.package_id)
              .maybeSingle();

            if (
              mappingCheckError ||
              !mappingBeforeShopifyCreate ||
              mappingBeforeShopifyCreate.variant_id !== newVariant.id
            ) {
              logger.error("Aborting Shopify create due to non-definitive mapping state", {
                sku: effectiveSku,
                packageId: merchItem.package_id,
                mappingCheckError: mappingCheckError?.message ?? null,
                mappingVariantId: mappingBeforeShopifyCreate?.variant_id ?? null,
                expectedVariantId: newVariant.id,
              });

              await supabase.from("warehouse_review_queue").upsert(
                {
                  workspace_id: workspaceId,
                  org_id: connection.org_id ?? null,
                  category: "bandcamp_sync_mapping_guardrail",
                  severity: "high" as const,
                  title: `Bandcamp mapping guardrail blocked Shopify create: ${effectiveSku}`,
                  description:
                    "Skipped Shopify product creation because package-level dedup state was not definitive.",
                  metadata: {
                    sku: effectiveSku,
                    packageId: merchItem.package_id,
                    expected_variant_id: newVariant.id,
                    actual_variant_id: mappingBeforeShopifyCreate?.variant_id ?? null,
                    error: mappingCheckError?.message ?? null,
                  },
                  status: "open" as const,
                  group_key: `bandcamp_mapping_guardrail_${workspaceId}_${merchItem.package_id}`,
                  occurrence_count: 1,
                },
                { onConflict: "group_key", ignoreDuplicates: false },
              );
              itemsFailed++;
              continue;
            }

            try {
              shopifyProductId = normalizeShopifyProductId(
                await productSetCreate({
                  title,
                  status: "DRAFT",
                  vendor: band?.name ?? connection.band_name,
                  productType: merchItem.item_type ?? "Merch",
                  tags,
                  ...(collectionId ? { collections: [collectionId] } : {}),
                  productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
                  variants: [
                    buildShopifyVariantInput({
                      sku: effectiveSku,
                      price: bcPrice,
                      cost: bcCost,
                      currency: bcCurrency,
                      barcode: bcBarcode,
                      category: productCategory,
                    }),
                  ],
                  // Shopify ProductSetInput uses `files: [FileSetInput!]` (2024-10+).
                  // `media` is not a valid field on ProductSetInput and is silently ignored —
                  // passing it caused all Bandcamp-synced products to be created without images.
                  ...(bandcampImageUrl(merchItem.image_url)
                    ? {
                        files: [
                          {
                            originalSource: bandcampImageUrl(merchItem.image_url),
                            alt: title,
                          },
                        ],
                      }
                    : {}),
                }),
              );
              logger.info("Created Shopify DRAFT product", { sku: effectiveSku, shopifyProductId });

              await supabase
                .from("warehouse_products")
                .update({
                  shopify_product_id: shopifyProductId,
                  synced_at: new Date().toISOString(),
                })
                .eq("id", product.id);

              const { data: productAttachedRow, error: attachError } = await supabase
                .from("warehouse_products")
                .select("id")
                .eq("id", product.id)
                .eq("shopify_product_id", shopifyProductId)
                .maybeSingle();

              if (attachError || !productAttachedRow) {
                // Non-null assertion same as the multi-variant branch above —
                // productSetCreate just succeeded so shopifyProductId is string.
                await productArchive(shopifyProductId as string);
                logger.error("Archived Shopify product after DB attach verification failed", {
                  sku: effectiveSku,
                  shopifyProductId,
                  attachError: attachError?.message ?? null,
                  warehouseProductId: product.id,
                });
                await supabase.from("warehouse_review_queue").upsert(
                  {
                    workspace_id: workspaceId,
                    org_id: connection.org_id ?? null,
                    category: "shopify_product_create",
                    severity: "high" as const,
                    title: `Shopify product auto-archived: attach failed (${effectiveSku})`,
                    description:
                      "Shopify product was created but failed post-create DB attach verification; product was immediately archived to prevent unmanaged duplicates.",
                    metadata: {
                      sku: effectiveSku,
                      shopify_product_id: shopifyProductId,
                      warehouse_product_id: product.id,
                      package_id: merchItem.package_id,
                      attach_error: attachError?.message ?? null,
                    },
                    status: "open" as const,
                    group_key: `shopify_attach_failed_autarchive_${workspaceId}_${effectiveSku}`,
                    occurrence_count: 1,
                  },
                  { onConflict: "group_key", ignoreDuplicates: false },
                );
                itemsFailed++;
                continue;
              }

              try {
                await publishToSafeChannels(shopifyProductId);
              } catch (pubErr) {
                logger.warn("Failed to publish product to channels", {
                  shopifyProductId,
                  error: String(pubErr),
                });
              }

              // productSet doesn't reliably propagate weight — set via inventoryItemUpdate
              const weight = CATEGORY_DEFAULT_WEIGHTS[productCategory];
              if (weight) {
                try {
                  const varData = await shopifyGraphQL<{
                    product: {
                      variants: {
                        nodes: Array<{ inventoryItem: { id: string } }>;
                      };
                    };
                  }>(
                    `query V($id: ID!) { product(id: $id) { variants(first: 1) { nodes { inventoryItem { id } } } } }`,
                    { id: shopifyProductId },
                  );
                  const invItemId = varData?.product?.variants?.nodes?.[0]?.inventoryItem?.id;
                  if (invItemId) {
                    await inventoryItemUpdate(invItemId, {
                      measurement: { weight: { value: weight.value, unit: weight.unit } },
                    });
                  }
                } catch (weightErr) {
                  logger.warn("Failed to set variant weight", {
                    shopifyProductId,
                    error: String(weightErr),
                  });
                }
              }
            } catch (shopifyError) {
              logger.error("Failed to create Shopify product, continuing with warehouse-only", {
                sku: effectiveSku,
                error: String(shopifyError),
              });
              await supabase.from("warehouse_review_queue").upsert(
                {
                  workspace_id: workspaceId,
                  org_id: connection.org_id ?? null,
                  category: "shopify_product_create",
                  severity: "medium" as const,
                  title: `Shopify product creation failed: ${title}`,
                  description: `SKU ${effectiveSku} was created in the warehouse but productSetCreate failed.`,
                  metadata: {
                    sku: effectiveSku,
                    bandcamp_item_id: String(merchItem.package_id),
                    band_id: String(connection.band_id),
                    warehouse_product_id: product.id,
                    error: String(shopifyError),
                  },
                  status: "open" as const,
                  group_key: `shopify_create_failed_${effectiveSku}`,
                  occurrence_count: 1,
                },
                { onConflict: "group_key", ignoreDuplicates: false },
              );
            }
          }

          itemsProcessed++;
        }

        // Backfill API data to existing mappings that were created before api_complete migration.
        // These have bandcamp_item_id but are missing subdomain, album_title, raw_api_data.
        for (const merchItem of merchItems) {
          await supabase
            .from("bandcamp_product_mappings")
            .update({
              bandcamp_subdomain: merchItem.subdomain ?? undefined,
              bandcamp_album_title: merchItem.album_title ?? undefined,
              bandcamp_price: merchItem.price ?? undefined,
              bandcamp_currency: merchItem.currency ?? undefined,
              bandcamp_is_set_price:
                merchItem.is_set_price != null ? Boolean(merchItem.is_set_price) : undefined,
              bandcamp_options: merchItem.options ?? undefined,
              bandcamp_origin_quantities: merchItem.origin_quantities ?? undefined,
              bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? undefined,
              bandcamp_new_date: merchItem.new_date ?? undefined,
              raw_api_data: merchItem,
              updated_at: new Date().toISOString(),
            })
            .eq("workspace_id", workspaceId)
            .eq("bandcamp_item_id", merchItem.package_id)
            .is("raw_api_data", null)
            .then(
              () => {},
              (err) =>
                logger.warn("Legacy mapping backfill failed", {
                  error: String(err),
                  task: "bandcamp-sync",
                  packageId: merchItem.package_id,
                }),
            );
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
              matchRate:
                totalMerchItems > 0
                  ? Math.round(((totalMerchItems - unmatchedMerchCount) / totalMerchItems) * 100)
                  : null,
              variant_query_count: lastVariantQueryCount,
              matched_count: totalMerchItems - unmatchedMerchCount,
              variants_truncated_warning: lastVariantQueryCount >= 10000,
            },
          })
          .eq("id", syncLogId);
      }

      logger.info("Bandcamp sync complete", {
        itemsProcessed,
        itemsFailed,
        totalMerchItems,
        unmatchedMerchCount,
      });

      // Cross-reference album URLs from digital sales to physical merch mappings
      const urlsMatched = await crossReferenceAlbumUrls(supabase, workspaceId);
      if (urlsMatched > 0) {
        logger.info("Cross-referenced album URLs from sales", { urlsMatched });
      }

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
      // Only pick active/probation mappings (dead URLs are handled by reconciliation probes).
      const { data: withUrlNoType } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url, product_category, bandcamp_type_name")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_url", "is", null)
        .is("bandcamp_type_name", null)
        .in("scrape_status", ["active", "probation"])
        .limit(100);

      const g1SweepSelected = withUrlNoType?.length ?? 0;
      let g1SweepTriggered = 0;
      if (withUrlNoType && withUrlNoType.length > 0) {
        logger.info(`Sweep group 1: ${withUrlNoType.length} mappings with URL but no type_name`);
        for (const pm of withUrlNoType) {
          // Reject URLs with garbage slugs (e.g. /album/- from prior sweep bugs)
          const urlSlug = (pm.bandcamp_url as string).split("/album/")[1] ?? "";
          if (!urlSlug || urlSlug.length < 2 || /^-+$/.test(urlSlug)) {
            await supabase
              .from("bandcamp_product_mappings")
              .update({
                bandcamp_url: null,
                bandcamp_url_source: null,
                updated_at: new Date().toISOString(),
              })
              .eq("id", pm.id);
            logger.warn("Sweep group 1: cleared bad URL slug", {
              mappingId: pm.id,
              url: pm.bandcamp_url,
            });
            continue;
          }
          const cat =
            pm.product_category ?? classifyProduct(pm.bandcamp_type_name, pm.bandcamp_url, null);
          await bandcampScrapePageTask.trigger({
            url: pm.bandcamp_url as string,
            mappingId: pm.id,
            workspaceId,
            urlIsConstructed: false,
            urlSource: "orders_api",
            productCategory: cat,
          });
          g1SweepTriggered++;
        }
      }

      // Group 2: no URL — LAST RESORT URL construction from band subdomain + product title.
      //
      // Priority: sales crossref (97% match) > manual entry > construction (causes ~75% of errors).
      // Only construct URLs for IN-STOCK items. OOS items without a URL are not worth the error noise.
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
        .limit(200);

      const g2SweepSelected = noUrlNoType?.length ?? 0;
      let g2SweepTriggered = 0;
      let g2SkipNoVariantTitle = 0;
      let g2SkipNoSubdomain = 0;
      let g2SkipBadSlug = 0;
      let g2SkipUrlRace = 0;
      let g2SkipOos = 0;

      if (noUrlNoType && noUrlNoType.length > 0) {
        // Resolve variant → product title + inventory
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

        // Check in-stock status — only construct URLs for in-stock items
        const inStockSet = new Set<string>();
        for (let i = 0; i < variantIds.length; i += 200) {
          const batch = variantIds.slice(i, i + 200);
          const { data: inv } = await supabase
            .from("warehouse_inventory_levels")
            .select("variant_id, available")
            .in("variant_id", batch)
            .gt("available", 0);
          for (const row of inv ?? []) inStockSet.add(row.variant_id);
        }

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
        interface MemberBandEntry {
          band_id: number;
        }
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
            logger.warn("Sweep group 2: member_bands_cache parse failed", {
              connectionBandId: conn.band_id,
            });
          }
          for (const mb of memberBands) {
            if (typeof mb?.band_id === "number" && !memberBandParentSubdomain.has(mb.band_id)) {
              memberBandParentSubdomain.set(mb.band_id, parentSub);
            }
          }
        }

        for (const pm of noUrlNoType) {
          // Skip OOS items — URL construction is error-prone and not worth it for OOS
          if (!inStockSet.has(pm.variant_id)) {
            g2SkipOos++;
            continue;
          }

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
            await supabase.from("warehouse_review_queue").upsert(
              {
                workspace_id: workspaceId,
                category: "bandcamp_scraper",
                severity: "low" as const,
                title: `Cannot resolve Bandcamp URL: no subdomain for member_band_id ${memberBandId}`,
                description: `Mapping ${pm.id} (${vInfo.productTitle}) has member_band_id ${memberBandId} which does not match any active connection or member_bands_cache. Set bandcamp_url manually to enable scraping.`,
                metadata: {
                  mappingId: pm.id,
                  memberBandId,
                  productName: vInfo.productTitle,
                  sku: vInfo.sku,
                },
                status: "open" as const,
                group_key: `bc_unresolvable_${pm.id}`,
                occurrence_count: 1,
              },
              { onConflict: "group_key", ignoreDuplicates: true },
            );
            logger.warn("Sweep group 2: no subdomain for mapping", {
              mappingId: pm.id,
              memberBandId,
            });
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

          logger.info("Sweep group 2 item (constructed, in-stock only)", {
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

          const g2Cat = classifyProduct(null, scrapeUrl, albumTitle ?? null);
          await bandcampScrapePageTask.trigger({
            url: scrapeUrl,
            mappingId: pm.id,
            workspaceId,
            urlIsConstructed: true,
            albumTitle: albumTitle ?? undefined,
            urlSource: "constructed",
            productCategory: g2Cat,
          });
          g2SweepTriggered++;
        }
        logger.info(
          `Sweep group 2: triggered ${g2SweepTriggered}/${noUrlNoType.length} scrapes (skipped ${g2SkipOos} OOS)`,
        );
      }

      // Group 3: already scraped (has art_url) but missing about/credits/upc/tracks.
      // These were scraped before this feature was added — backfill on subsequent runs.
      // Only active/probation mappings (dead handled by reconciliation probes).
      // Only album-format categories (merch/apparel don't have about).
      const { data: scrapedNoAbout } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, bandcamp_url, product_category, bandcamp_type_name")
        .eq("workspace_id", workspaceId)
        .not("bandcamp_art_url", "is", null)
        .is("bandcamp_about", null)
        .not("bandcamp_url", "is", null)
        .in("scrape_status", ["active", "probation"])
        .not("product_category", "in", '("apparel","merch")')
        .limit(100);

      const g3SweepSelected = scrapedNoAbout?.length ?? 0;
      let g3SweepTriggered = 0;
      if (scrapedNoAbout && scrapedNoAbout.length > 0) {
        logger.info(
          `Sweep group 3: ${scrapedNoAbout.length} already-scraped mappings missing about/credits/upc`,
        );
        for (const pm of scrapedNoAbout) {
          const g3Cat =
            pm.product_category ?? classifyProduct(pm.bandcamp_type_name, pm.bandcamp_url, null);
          await bandcampScrapePageTask.trigger({
            url: pm.bandcamp_url as string,
            mappingId: pm.id,
            workspaceId,
            urlIsConstructed: false,
            urlSource: "orders_api",
            productCategory: g3Cat,
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
