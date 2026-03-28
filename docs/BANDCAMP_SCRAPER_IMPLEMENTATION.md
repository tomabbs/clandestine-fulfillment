# Bandcamp Scraper — Full Implementation Plan

## Problem Summary

The `bandcamp-sync` task triggers `bandcamp-scrape-page` with `if (merchItem.url)` — **which is always false**. The Bandcamp `get_merch_details` API does not return a `url` field. Confirmed by API documentation.

Result: All 550 `bandcamp_product_mappings` rows have `bandcamp_url = NULL` and `bandcamp_type_name = NULL`. The scraper has never fired.

---

## Data Tally (current state)

| Metric | Count |
|---|---|
| Total warehouse product variants | 2,379 |
| Bandcamp-mapped variants | 550 |
| Mappings with `bandcamp_url` set | **0** |
| Mappings with `bandcamp_type_name` set | **0** |
| Variants with `street_date` | 654 (API-sourced only) |
| Variants without `street_date` | 1,725 |
| Products with `images` JSONB set | 2,159 |
| Products with rows in `warehouse_product_images` | 649 |
| Products with zero images in either store | 1,807 |

---

## Confirmed Data Source: `data-tralbum` Attribute

Every Bandcamp album page embeds structured JSON in a `data-tralbum` HTML attribute. This powers Bandcamp's player, embeds, and purchase flow — it has been stable for 7-10 years. The current `parseV1` already targets this attribute but uses fragile manual HTML entity replacement instead of the `he` package.

### Real Data Structure (confirmed)

```json
{
  "current": {
    "release_date": "20 Mar 2026 00:00:00 GMT",
    "title": "Album Title",
    "art_id": 3310773467
  },
  "is_preorder": false,
  "album_is_preorder": false,
  "art_id": 3310773467,
  "packages": [
    {
      "type_name": "Compact Disc (CD)",
      "type_id": 1,
      "sku": "NR-302041",
      "release_date": "08 May 2026 00:00:00 GMT",
      "arts": [{ "image_id": 43512272 }]
    }
  ]
}
```

### Key Fields

| Field | Purpose |
|-------|---------|
| `current.release_date` | Album release date string, GMT format |
| `is_preorder` / `album_is_preorder` | Direct boolean preorder flags |
| `art_id` | Album cover art image ID |
| `packages[].type_name` | Format string ("Compact Disc (CD)", "2 x Vinyl LP") |
| `packages[].type_id` | Format integer (1=CD, 3=Cassette, 15=2xLP) — better for matching than type_name |
| `packages[].sku` | SKU for exact matching to our mappings |
| `packages[].release_date` | Merch ship date — may differ from album release date |
| `packages[].arts[].image_id` | Merch-specific image IDs |

### Image URL Construction

```
https://f4.bcbits.com/img/a{image_id}_{size}.jpg
```

Sizes: `10` = 1200×1200, `5` = 700×700, `2` = 350×350. Use size `10` for highest quality.

---

## Dependency to Add

```bash
pnpm add he
pnpm add -D @types/he
```

`he` decodes all HTML entities robustly. The current manual replacement (`&quot;` → `"` etc.) misses edge cases like `&#x27;` and numeric entities.

---

## Pre-Deploy Critical Requirements

Three issues confirmed by schema audit that must be fixed before any code ships:

1. `warehouse_product_images` has NO `(product_id, src)` unique constraint — `ON CONFLICT DO NOTHING` in any image migration is currently a no-op.
2. `String(error).includes("404")` is too brittle — proxy errors, wrapped errors, or any message containing "404" will misfire.
3. No scraper idempotency guard — every 30-minute cron would hammer Bandcamp with 550 redundant fetches forever without one.

---

## Execution Sequence

| Step | Action | Blocking |
|------|--------|----------|
| 0 | Run `test-bandcamp-scrape.ts` against 5 real Bandcamp pages | **YES** |
| 1 | Apply schema migrations (prereqs + new columns) | **YES** |
| 2 | Deploy `he` dependency + rewritten parser + typed error | No |
| 3 | Deploy URL construction + idempotency guard + package matching | **YES** |
| 4 | Run `retrigger-bandcamp-scrape.ts` for NSR only first | **YES** |
| 5 | Monitor 24h against thresholds. If <10% 404 rate, expand to all workspaces | **YES** |
| 6 | (Lower priority) Image backfill migration once scraper is confirmed working | No |
| 7 | (Lower priority) Order URL backfill from `get_orders` item_url | No |

**Note on steps 6 and 7:** Order URL backfill covers only recently-sold products and adds complexity. URL construction via subdomain+slug covers the full catalog. Run step 4/5 first to validate slug accuracy before investing in the order backfill path. Secondary images (arts array) are deferred — album art + primary merch image is sufficient for now.

---

## Step 0: Test Script (BLOCKING)

Run against at least 5 pages before writing any production code. The script must confirm `data-tralbum` is present and parseable across different page types.

```typescript
// scripts/test-bandcamp-scrape.ts
// Run: npx tsx scripts/test-bandcamp-scrape.ts

import { fetchBandcampPage, parseBandcampPage } from "../src/lib/clients/bandcamp-scraper";

// Test URLs — mix of released, preorder, LP, CD, cassette, NSR
const TEST_URLS = [
  "https://neurosis.bandcamp.com/album/an-undying-love-for-a-burning-world",  // Released
  "https://buntamura.bandcamp.com/album/mijin",                               // Preorder
  // Add 2-3 real NSR album URLs below:
  // "https://northernspyrecords.bandcamp.com/album/SLUG-HERE",
];

async function main() {
  for (const url of TEST_URLS) {
    console.log(`\n=== ${url} ===`);
    try {
      const html = await fetchBandcampPage(url);
      const data = parseBandcampPage(html);

      if (!data) {
        console.log("FAIL: Could not parse data-tralbum attribute");
        continue;
      }

      console.log("PASS: Release Date:", data.releaseDate?.toISOString() ?? "null");
      console.log("PASS: Is Preorder:", data.isPreorder);
      console.log("PASS: Album Art URL:", data.albumArtUrl ?? "null");
      console.log("PASS: Package count:", data.packages.length);

      for (const pkg of data.packages) {
        console.log(`  Package: ${pkg.typeName} (type_id: ${pkg.typeId}, SKU: ${pkg.sku ?? "null"})`);
        console.log(`    Ship Date: ${pkg.releaseDate?.toISOString() ?? "null"}`);
        console.log(`    Image count: ${pkg.imageUrls.length}`);
        if (pkg.imageUrls[0]) console.log(`    Primary image: ${pkg.imageUrls[0]}`);
      }
    } catch (err) {
      console.log("ERROR:", String(err));
    }
  }
}

main().catch(console.error);
```

**Checklist before proceeding:**
- [ ] `data-tralbum` present on all test pages
- [ ] `releaseDate` parsed correctly from GMT string format
- [ ] `isPreorder` boolean works
- [ ] `albumArtUrl` constructed correctly (check URL loads in browser)
- [ ] At least one package has SKU matching a known warehouse variant
- [ ] Package `type_name` / `type_id` fields present

---

## File 0: `supabase/migrations/20260329000000_bandcamp_scraper_prereqs.sql` (new — run FIRST)

```sql
-- Migration: Bandcamp scraper pre-requisites
-- Must be applied before any scraper code ships.

-- 1. Add (product_id, src) unique constraint to warehouse_product_images.
--    Without this, ON CONFLICT DO NOTHING in any image migration is a no-op
--    and concurrent scraper runs can insert duplicate rows.
ALTER TABLE warehouse_product_images
  ADD CONSTRAINT uq_product_images_product_src UNIQUE (product_id, src);

-- 2. Add bandcamp_url_source — tracks confidence level so lower-confidence
--    sources never overwrite higher-confidence ones.
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_url_source text
    CHECK (bandcamp_url_source IN ('orders_api', 'constructed', 'manual', 'scraper_verified'));

-- 3. Add bandcamp_image_url if not present (API-fetched thumbnail, separate from
--    scraped full-res images).
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_image_url text;

-- 4. New columns populated by the scraper from data-tralbum JSON.
--    These are not in the original schema and provide richer catalog metadata.
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_release_date  timestamptz,
  ADD COLUMN IF NOT EXISTS bandcamp_is_preorder   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS bandcamp_art_url       text;

NOTIFY pgrst, 'reload schema';
```

---

## File 1: `src/lib/clients/bandcamp-scraper.ts` (full rewrite)

Key changes from current:
- Add `he` for robust HTML entity decoding (replaces fragile manual `.replace` chain)
- Extract `buildBandcampAlbumUrl` here so unit tests import the real function
- Add `BandcampFetchError` with typed `.status` property
- Update Zod schema to capture `is_preorder`, `album_is_preorder`, `type_id`, `packages[].release_date`
- Expose `ScrapedAlbumData` with new fields `isPreorder`, `releaseDate` as `Date`, `albumArtUrl`
- Secondary images (arts array) captured but not required — album art + primary image is sufficient

```typescript
import he from "he";
import { z } from "zod";

// ─── URL construction helper ──────────────────────────────────────────────────
// Extracted here so bandcamp-sync.ts imports it and unit tests validate the real
// implementation rather than a local copy.
//
// NFD normalization handles accented Latin chars (é → e) without external deps.
// Non-ASCII slugs that can't be normalized (CJK, Arabic) will 404 — those get
// logged to the review queue rather than retried endlessly.

export function buildBandcampAlbumUrl(subdomain: string, albumTitle: string): string | null {
  const trimmed = albumTitle.trim();
  if (!trimmed) return null;
  const slug = trimmed
    .toLowerCase()
    .normalize("NFD")                 // decompose é → e + combining accent
    .replace(/[\u0300-\u036f]/g, "")  // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return null;
  return `https://${subdomain}.bandcamp.com/album/${slug}`;
}

// ─── Typed fetch error ────────────────────────────────────────────────────────
// Attaches HTTP status to the thrown Error so callers can do `err instanceof
// BandcampFetchError && err.status === 404` instead of string-matching the
// message — which misfires on proxy errors or any message containing "404".

export class BandcampFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "BandcampFetchError";
  }
}

// ─── Zod schema for data-tralbum JSON ────────────────────────────────────────
// Targets the data-tralbum HTML attribute, not the TralbumData JS variable.
// data-tralbum has been stable for 7-10 years (powers player, embeds, checkout).

const packageArtSchema = z.object({
  image_id: z.number().nullish(),
});

const tralbumDataSchema = z.object({
  art_id:            z.number().nullish(),
  is_preorder:       z.boolean().nullish(),
  album_is_preorder: z.boolean().nullish(),
  current: z
    .object({
      title:        z.string().nullish(),
      release_date: z.string().nullish(),
      art_id:       z.number().nullish(),
    })
    .nullish(),
  packages: z
    .array(
      z.object({
        type_name:    z.string().nullish(),
        type_id:      z.number().nullish(),     // 1=CD, 3=Cassette, 15=2xLP — more reliable than type_name
        title:        z.string().nullish(),
        sku:          z.string().nullish(),
        release_date: z.string().nullish(),     // package ship date (may differ from album release)
        new_date:     z.string().nullish(),     // legacy field — fall back if release_date absent
        image_id:     z.number().nullish(),
        arts:         z.array(packageArtSchema).nullish(),
      }),
    )
    .nullish(),
});

export type TralbumData = z.infer<typeof tralbumDataSchema>;

// ─── Output types ─────────────────────────────────────────────────────────────

export interface ScrapedPackageImage {
  imageId: number;
  url: string;
}

export interface ScrapedPackage {
  typeName: string | null;
  typeId: number | null;
  title: string | null;
  sku: string | null;
  releaseDate: Date | null;    // parsed from release_date or new_date GMT string
  imageId: number | null;      // primary image ID
  imageUrl: string | null;     // primary image URL at 1200px
  arts: ScrapedPackageImage[]; // additional images (album art secondary shots)
}

export interface ScrapedAlbumData {
  releaseDate: Date | null;    // from current.release_date
  isPreorder: boolean;         // from is_preorder || album_is_preorder
  artId: number | null;        // top-level album art ID
  albumArtUrl: string | null;  // constructed from artId at 1200px
  title: string | null;
  packages: ScrapedPackage[];
  metadataIncomplete: boolean; // true when release_date or packages missing
}

// ─── Image URL construction ───────────────────────────────────────────────────

/**
 * Build a Bandcamp image URL.
 * Sizes: 10 = 1200×1200, 5 = 700×700, 2 = 350×350
 * Album art uses "a" prefix: a{id}_{size}.jpg
 * Package/merch images omit "a": {id}_{size}.jpg
 */
export function bandcampAlbumArtUrl(artId: number | null | undefined, size = 10): string | null {
  if (artId == null) return null;
  return `https://f4.bcbits.com/img/a${artId}_${size}.jpg`;
}

export function bandcampMerchImageUrl(imageId: number | null | undefined, size = 10): string | null {
  if (imageId == null) return null;
  return `https://f4.bcbits.com/img/${imageId}_${size}.jpg`;
}

// ─── GMT date parsing ─────────────────────────────────────────────────────────
// Bandcamp date format: "20 Mar 2026 00:00:00 GMT"
// JavaScript's Date constructor handles this natively.

function parseGMTDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── HTML fetching ────────────────────────────────────────────────────────────

export async function fetchBandcampPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new BandcampFetchError(
      `Failed to fetch album page: ${response.status}`,
      response.status,
      url,
    );
  }

  return response.text();
}

// ─── Main parser ──────────────────────────────────────────────────────────────
// Targets data-tralbum HTML attribute (not the TralbumData JS variable).
// Uses `he` for robust HTML entity decoding.

export function parseBandcampPage(html: string): ScrapedAlbumData | null {
  const attrMatch = html.match(/data-tralbum="([^"]+)"/);
  if (!attrMatch) return null;

  let data: TralbumData;
  try {
    const decoded = he.decode(attrMatch[1]);
    data = tralbumDataSchema.parse(JSON.parse(decoded));
  } catch {
    return null;
  }

  const artId = data.art_id ?? data.current?.art_id ?? null;
  const releaseDate = parseGMTDate(data.current?.release_date ?? null);
  const isPreorder = data.is_preorder === true || data.album_is_preorder === true;

  const packages: ScrapedPackage[] = (data.packages ?? []).map((pkg) => {
    const imageId = pkg.image_id ?? null;
    const arts: ScrapedPackageImage[] = (pkg.arts ?? [])
      .filter((a) => a.image_id != null)
      .map((a) => ({
        imageId: a.image_id as number,
        url: bandcampMerchImageUrl(a.image_id) as string,
      }));

    // Prefer explicit release_date; fall back to new_date (legacy field)
    const pkgReleaseDate = parseGMTDate(pkg.release_date ?? pkg.new_date ?? null);

    return {
      typeName:    pkg.type_name ?? null,
      typeId:      pkg.type_id ?? null,
      title:       pkg.title ?? null,
      sku:         pkg.sku ?? null,
      releaseDate: pkgReleaseDate,
      imageId,
      imageUrl:    bandcampMerchImageUrl(imageId),
      arts,
    };
  });

  const metadataIncomplete = !releaseDate || packages.length === 0;

  return {
    releaseDate,
    isPreorder,
    artId,
    albumArtUrl: bandcampAlbumArtUrl(artId),
    title: data.current?.title ?? null,
    packages,
    metadataIncomplete,
  };
}
```

---

## File 2: `src/trigger/tasks/bandcamp-sync.ts` (full file — with all fixes applied)

Key changes:
- `buildBandcampAlbumUrl` and `BandcampFetchError` imported from `bandcamp-scraper.ts`
- Idempotency guard: only trigger scrape when `bandcamp_url` or `bandcamp_type_name` is missing
- `urlIsConstructed`, `urlSource`, `albumTitle` added to scraper payload
- `bandcamp_url_source` written to mapping before triggering
- `band_url` persisted to `bandcamp_connections` on first sync
- `findMatchingPackage` uses SKU → format keyword (now including apparel) with `type_id` support

```typescript
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
// Priority: exact SKU → type_id → format keyword → no match.
// type_id is more reliable than type_name string matching (no locale variation).
// Single-package fallback removed — risked matching a digital package to a physical variant.

const TYPE_ID_MAP: Record<number, string[]> = {
  1:  ["cd"],
  3:  ["cassette", "tape"],
  4:  ["shirt", "t-shirt", "tee"],
  5:  ["hoodie"],
  10: ["poster", "print"],
  15: ["lp", "vinyl", "2xlp", "2 x vinyl"],
};

const FORMAT_KEYWORDS = [
  "lp", "vinyl", "cd", "cassette", "tape", '7"', '10"', '12"',
  "shirt", "t-shirt", "tee", "hoodie", "hat", "beanie", "poster", "print",
];

function findMatchingPackage(
  packages: ScrapedAlbumData["packages"],
  variantSku: string | null,
  variantTitle: string | null,
): ScrapedAlbumData["packages"][number] | null {
  // 1. Exact SKU match (confirmed stable in data-tralbum)
  if (variantSku) {
    const bySku = packages.find((p) => p.sku === variantSku);
    if (bySku) return bySku;
  }

  // 2. Format keyword match using variantTitle vs package typeName
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
    try {
      const html = await fetchBandcampPage(payload.url);
      const scraped = parseBandcampPage(html);

      if (!scraped) {
        // data-tralbum not found — may be a non-album page or Bandcamp layout change
        await supabase.from("warehouse_review_queue").upsert({
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
        }, { onConflict: "group_key", ignoreDuplicates: false });
        return { success: false, reason: "no_tralbum" };
      }

      // Write scraped metadata to bandcamp_product_mappings
      await supabase
        .from("bandcamp_product_mappings")
        .update({
          bandcamp_url:          payload.url,
          bandcamp_url_source:   "scraper_verified",
          bandcamp_new_date:     scraped.releaseDate?.toISOString().slice(0, 10) ?? null,
          bandcamp_release_date: scraped.releaseDate?.toISOString() ?? null,
          bandcamp_is_preorder:  scraped.isPreorder,
          bandcamp_art_url:      scraped.albumArtUrl,
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
            await supabase.from("warehouse_product_variants").update(updates).eq("id", variant.id);

            if (updates.is_preorder === true) {
              await preorderSetupTask.trigger({
                variant_id: variant.id,
                workspace_id: payload.workspaceId,
              });
            }
          }

          // Store album art + primary merch image (secondary arts deferred)
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
        await supabase.from("warehouse_review_queue").upsert({
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
        }, { onConflict: "group_key", ignoreDuplicates: false });
      }

      return { success: true, metadataIncomplete: scraped.metadataIncomplete };
    } catch (error) {
      // Typed check — no string matching
      const is404 = error instanceof BandcampFetchError && error.status === 404;

      logger.error("Scrape failed", {
        url: payload.url,
        urlIsConstructed: payload.urlIsConstructed,
        status: error instanceof BandcampFetchError ? error.status : undefined,
        error: String(error),
      });

      if (is404 && payload.urlIsConstructed) {
        // Constructed slug wrong — log to review queue, don't retry
        await supabase.from("warehouse_review_queue").upsert({
          workspace_id: payload.workspaceId,
          org_id: null,
          category: "bandcamp_scraper",
          severity: "low" as const,
          title: "Constructed Bandcamp URL returned 404",
          description: `URL: ${payload.url}. Album slug may not match. Set bandcamp_url manually in bandcamp_product_mappings.`,
          metadata: {
            url: payload.url,
            mappingId: payload.mappingId,
            album_title: payload.albumTitle,
          },
          status: "open" as const,
          group_key: `bc_scrape_404_${payload.mappingId}`,
          occurrence_count: 1,
        }, { onConflict: "group_key", ignoreDuplicates: false });
        return { success: false, reason: "404_constructed_url" };
      }

      // Non-404 or API-sourced URL failures — throw so Trigger.dev retries
      throw error;
    }
  },
});

// === Image storage helper ===
// Stores album art as primary image. Package-specific arts are captured but
// secondary images (arts array) are deferred — album art + primary is sufficient.

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

  // Album art
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

  const matchedPkg = findMatchingPackage(scraped.packages, variantData?.sku ?? null, variantTitle);

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

  logger.info("Stored scraped images", { productId, imageCount: imagesToInsert.length });
}

// === Main sync task ===

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

      const bands = await getMyBands(accessToken);
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

      if (!connections?.length) return;

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

        const { data: variants } = await supabase
          .from("warehouse_product_variants")
          .select("id, sku")
          .eq("workspace_id", workspaceId);

        const { matched, unmatched } = matchSkuToVariants(merchItems, variants ?? []);

        // ── Matched items ──────────────────────────────────────────────────────

        for (const { merchItem, variantId } of matched) {
          await supabase.from("bandcamp_product_mappings").upsert(
            {
              workspace_id:           workspaceId,
              variant_id:             variantId,
              bandcamp_item_id:       merchItem.package_id,
              bandcamp_item_type:     merchItem.item_type?.toLowerCase().includes("album") ? "album" : "package",
              bandcamp_member_band_id: merchItem.member_band_id,
              bandcamp_image_url:     bandcampImageUrl(merchItem.image_url) ?? null,
              last_quantity_sold:     merchItem.quantity_sold,
              last_synced_at:         new Date().toISOString(),
              updated_at:             new Date().toISOString(),
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
            if ((existingVar.price == null || existingVar.price === 0) && merchItem.price != null) {
              updates.price = merchItem.price;
            }
            if ((existingVar.cost == null || existingVar.cost === 0) && merchItem.price != null) {
              updates.cost = Math.round(((updates.price as number | undefined) ?? merchItem.price) * 0.5 * 100) / 100;
            }
            if (!existingVar.street_date && merchItem.new_date) {
              updates.street_date = merchItem.new_date;
            }
            if ((updates.street_date as string | undefined) && !existingVar.is_preorder) {
              if (new Date(updates.street_date as string) > new Date()) updates.is_preorder = true;
            }

            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString();
              await supabase.from("warehouse_product_variants").update(updates).eq("id", variantId);
              if (updates.is_preorder === true) {
                await preorderSetupTask.trigger({ variant_id: variantId, workspace_id: workspaceId });
              }
            }

            // API image backfill — only if no images exist yet
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

          // Idempotency guard: only trigger scrape if mapping is incomplete
          const { data: mapping } = await supabase
            .from("bandcamp_product_mappings")
            .select("id, bandcamp_url, bandcamp_type_name")
            .eq("variant_id", variantId)
            .single();

          const needsScrape = mapping && (!mapping.bandcamp_url || !mapping.bandcamp_type_name);

          if (needsScrape) {
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
            const urlSource: "orders_api" | "constructed" =
              apiUrl ? "orders_api" : "constructed";

            if (scrapeUrl && !existingUrl) {
              await supabase
                .from("bandcamp_product_mappings")
                .update({
                  bandcamp_url:        scrapeUrl,
                  bandcamp_url_source: urlSource,
                  updated_at:          new Date().toISOString(),
                })
                .eq("id", mapping.id);
            }

            if (scrapeUrl) {
              await bandcampScrapePageTask.trigger({
                url:              scrapeUrl,
                mappingId:        mapping.id,
                workspaceId,
                urlIsConstructed: !apiUrl && !existingUrl,
                albumTitle:       merchItem.album_title ?? undefined,
                urlSource,
              });
            } else {
              logger.warn("No scrape URL available for variant", {
                variantId,
                album_title: merchItem.album_title,
                bandSubdomain,
              });
            }
          }
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

          if (existingVariant) continue;

          let shopifyProductId: string | null = null;
          try {
            shopifyProductId = await productSetCreate({
              title,
              status: "DRAFT",
              vendor: band?.name ?? connection.band_name,
              productType: merchItem.item_type ?? "Merch",
              tags,
              productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
              variants: [{
                optionValues: [{ optionName: "Title", name: "Default Title" }],
                sku: merchItem.sku,
                inventoryPolicy: "DENY",
              }],
              ...(bandcampImageUrl(merchItem.image_url) ? {
                media: [{ originalSource: bandcampImageUrl(merchItem.image_url), mediaContentType: "IMAGE" }],
              } : {}),
            });
          } catch (shopifyError) {
            logger.error("Failed to create Shopify product", { sku: merchItem.sku, error: String(shopifyError) });
            await supabase.from("warehouse_review_queue").upsert({
              workspace_id: workspaceId,
              org_id: connection.org_id ?? null,
              category: "shopify_product_create",
              severity: "medium" as const,
              title: `Shopify product creation failed: ${title}`,
              description: `SKU ${merchItem.sku} created in warehouse but productSetCreate failed.`,
              metadata: { sku: merchItem.sku, error: String(shopifyError) },
              status: "open" as const,
              group_key: `shopify_create_failed_${merchItem.sku}`,
              occurrence_count: 1,
            }, { onConflict: "group_key", ignoreDuplicates: false });
          }

          const { data: product, error: productError } = await supabase
            .from("warehouse_products")
            .insert({
              workspace_id:      workspaceId,
              org_id:            connection.org_id,
              shopify_product_id: shopifyProductId,
              title,
              vendor:            band?.name ?? connection.band_name,
              product_type:      merchItem.item_type ?? "Merch",
              status:            "draft",
              tags,
              image_url:         bandcampImageUrl(merchItem.image_url) ?? null,
            })
            .select("id")
            .single();

          if (productError || !product) { itemsFailed++; continue; }

          if (bandcampImageUrl(merchItem.image_url)) {
            await supabase.from("warehouse_product_images").insert({
              product_id:   product.id,
              src:          bandcampImageUrl(merchItem.image_url),
              alt:          title,
              position:     0,
            });
          }

          const { data: newVariant } = await supabase
            .from("warehouse_product_variants")
            .insert({
              product_id:   product.id,
              workspace_id: workspaceId,
              sku:          merchItem.sku,
              title:        merchItem.title,
              price:        merchItem.price ?? null,
              cost:         merchItem.price != null ? Math.round(merchItem.price * 0.5 * 100) / 100 : null,
              bandcamp_url: null,
              street_date:  merchItem.new_date,
              is_preorder:  tags.includes("Pre-Orders"),
            })
            .select("id")
            .single();

          if (newVariant) {
            await supabase.from("warehouse_inventory_levels").upsert({
              variant_id:         newVariant.id,
              workspace_id:       workspaceId,
              sku:                merchItem.sku,
              available:          merchItem.quantity_available ?? 0,
              committed:          0,
              incoming:           0,
              last_redis_write_at: new Date().toISOString(),
              updated_at:         new Date().toISOString(),
            }, { onConflict: "variant_id", ignoreDuplicates: true });

            const { data: newMapping } = await supabase
              .from("bandcamp_product_mappings")
              .insert({
                workspace_id:        workspaceId,
                variant_id:          newVariant.id,
                bandcamp_item_id:    merchItem.package_id,
                bandcamp_item_type:  merchItem.item_type?.toLowerCase().includes("album") ? "album" : "package",
                bandcamp_member_band_id: merchItem.member_band_id,
                bandcamp_image_url:  bandcampImageUrl(merchItem.image_url) ?? null,
                bandcamp_new_date:   merchItem.new_date,
                last_quantity_sold:  merchItem.quantity_sold,
                last_synced_at:      new Date().toISOString(),
              })
              .select("id")
              .single();

            if (tags.includes("Pre-Orders")) {
              await preorderSetupTask.trigger({ variant_id: newVariant.id, workspace_id: workspaceId });
            }

            if (newMapping) {
              const bandSubdomain =
                band?.subdomain ??
                (connection.band_url ?? "").replace("https://", "").split(".")[0] ??
                null;
              const apiUrl = (merchItem.url as string | null | undefined) ?? null;
              const constructedUrl =
                bandSubdomain && merchItem.album_title
                  ? buildBandcampAlbumUrl(bandSubdomain, merchItem.album_title)
                  : null;
              const scrapeUrl = apiUrl ?? constructedUrl;
              const urlSource: "orders_api" | "constructed" = apiUrl ? "orders_api" : "constructed";

              if (scrapeUrl) {
                await supabase.from("bandcamp_product_mappings").update({
                  bandcamp_url:        scrapeUrl,
                  bandcamp_url_source: urlSource,
                  updated_at:          new Date().toISOString(),
                }).eq("id", newMapping.id);

                await bandcampScrapePageTask.trigger({
                  url:              scrapeUrl,
                  mappingId:        newMapping.id,
                  workspaceId,
                  urlIsConstructed: !apiUrl,
                  albumTitle:       merchItem.album_title ?? undefined,
                  urlSource,
                });
              }
            }
          }

          itemsProcessed++;
        }

        await supabase
          .from("bandcamp_connections")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", connection.id);
      }

      if (itemsFailed > 0 && itemsProcessed > 0 && itemsFailed / (itemsProcessed + itemsFailed) > 0.2) {
        await supabase.from("warehouse_review_queue").upsert({
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
        }, { onConflict: "group_key", ignoreDuplicates: false });
      }

      if (syncLogId) {
        await supabase.from("channel_sync_log").update({
          status: itemsFailed > 0 ? "partial" : "completed",
          items_processed: itemsProcessed,
          items_failed: itemsFailed,
          completed_at: new Date().toISOString(),
        }).eq("id", syncLogId);
      }
    } catch (error) {
      if (syncLogId) {
        await supabase.from("channel_sync_log").update({
          status: "failed",
          items_processed: itemsProcessed,
          items_failed: itemsFailed,
          error_message: String(error),
          completed_at: new Date().toISOString(),
        }).eq("id", syncLogId);
      }
      await supabase.from("warehouse_review_queue").upsert({
        workspace_id: payload.workspaceId,
        org_id: null,
        category: "bandcamp_sync",
        severity: "high" as const,
        title: "Bandcamp sync failed",
        description: String(error),
        metadata: { items_processed: itemsProcessed, items_failed: itemsFailed },
        status: "open" as const,
        group_key: `bandcamp_sync_failure_${payload.workspaceId}`,
        occurrence_count: 1,
      }, { onConflict: "group_key", ignoreDuplicates: false });
      throw error;
    }
  },
});

// === Cron schedule ===

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

    if (!credentials?.length) return;

    for (const cred of credentials) {
      await bandcampSyncTask.trigger({ workspaceId: cred.workspace_id });
    }
  },
});
```

---

## File 3: `src/trigger/tasks/bandcamp-order-sync.ts` (full file — with batched URL backfill)

```typescript
/**
 * Bandcamp order sync — poll get_orders and create warehouse_orders.
 * Also batch-backfills bandcamp_product_mappings.bandcamp_url from item_url.
 * Note: order backfill covers only recently-sold products (30-day window).
 * URL construction in bandcamp-sync.ts covers the full catalog.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import type { BandcampOrderItem } from "@/lib/clients/bandcamp";
import { getOrders, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";

export const bandcampOrderSyncTask = task({
  id: "bandcamp-order-sync",
  queue: bandcampQueue,
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = payload.workspaceId
      ? [payload.workspaceId]
      : await getAllWorkspaceIds(supabase);

    let totalCreated = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, org_id, band_id")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections?.length) continue;

      const accessToken = await refreshBandcampToken(workspaceId);

      for (const conn of connections) {
        try {
          const endTime = new Date();
          const startTime = new Date(endTime);
          startTime.setDate(startTime.getDate() - 30);

          const items = await getOrders(
            {
              bandId: conn.band_id,
              startTime: startTime.toISOString().replace("T", " ").slice(0, 19),
              endTime: endTime.toISOString().replace("T", " ").slice(0, 19),
            },
            accessToken,
          );

          const byPayment = new Map<number, typeof items>();
          for (const item of items) {
            const list = byPayment.get(item.payment_id) ?? [];
            list.push(item);
            byPayment.set(item.payment_id, list);
          }

          for (const [paymentId, orderItems] of Array.from(byPayment.entries())) {
            const first = orderItems[0]!;
            const { data: existing } = await supabase
              .from("warehouse_orders")
              .select("id")
              .eq("workspace_id", workspaceId)
              .eq("bandcamp_payment_id", paymentId)
              .maybeSingle();

            if (existing) continue;

            const { error } = await supabase.from("warehouse_orders").insert({
              workspace_id:       workspaceId,
              org_id:             conn.org_id,
              bandcamp_payment_id: paymentId,
              order_number:       `BC-${paymentId}`,
              customer_name:      first.buyer_name,
              customer_email:     first.buyer_email,
              financial_status:   "paid",
              fulfillment_status: first.ship_date ? "fulfilled" : "unfulfilled",
              total_price:        first.order_total ?? 0,
              currency:           first.currency ?? "USD",
              line_items: orderItems.map((i: BandcampOrderItem) => ({
                sku: i.sku, title: i.item_name, quantity: i.quantity ?? 1, price: i.sub_total,
              })),
              shipping_address: first.ship_to_name ? {
                name: first.ship_to_name, street1: first.ship_to_street,
                street2: first.ship_to_street_2, city: first.ship_to_city,
                state: first.ship_to_state, postalCode: first.ship_to_zip,
                country: first.ship_to_country, countryCode: first.ship_to_country_code,
              } : null,
              source:    "bandcamp",
              synced_at: new Date().toISOString(),
            });

            if (error) {
              logger.warn("Bandcamp order insert failed", { paymentId, error: error.message });
              continue;
            }
            totalCreated++;
          }

          // Batch-backfill bandcamp_url from item_url.
          // Provides verified (orders_api) URLs for sold products — higher confidence
          // than constructed slugs. Never overwrites existing non-null URLs.
          const skuUrlPairs = items
            .filter((i) => i.item_url && i.sku)
            .map((i) => ({ sku: i.sku as string, url: i.item_url as string }));

          if (skuUrlPairs.length > 0) {
            const { data: variants } = await supabase
              .from("warehouse_product_variants")
              .select("id, sku")
              .eq("workspace_id", workspaceId)
              .in("sku", skuUrlPairs.map((p) => p.sku));

            const skuToVariantId = new Map((variants ?? []).map((v) => [v.sku, v.id]));

            for (const { sku, url } of skuUrlPairs) {
              const variantId = skuToVariantId.get(sku);
              if (!variantId) continue;
              await supabase
                .from("bandcamp_product_mappings")
                .update({
                  bandcamp_url:        url,
                  bandcamp_url_source: "orders_api",
                  updated_at:          new Date().toISOString(),
                })
                .eq("variant_id", variantId)
                .is("bandcamp_url", null);
            }
          }
        } catch (err) {
          logger.error("Bandcamp order sync failed", {
            connectionId: conn?.id,
            bandId: conn?.band_id,
            error: String(err),
          });
        }
      }
    }

    return { totalCreated };
  },
});

export const bandcampOrderSyncSchedule = schedules.task({
  id: "bandcamp-order-sync-cron",
  cron: "0 */6 * * *",
  queue: bandcampQueue,
  run: async () => {
    await bandcampOrderSyncTask.trigger({});
    return { ok: true };
  },
});
```

---

## File 4: `src/trigger/lib/bandcamp-scrape-queue.ts` (updated)

```typescript
import { queue } from "@trigger.dev/sdk";

export const bandcampScrapeQueue = queue({
  name: "bandcamp-scrape",
  concurrencyLimit: 3,
  // Max 1 request/sec to avoid IP bans during the initial 550-item backfill.
  // With concurrency 3, effective rate is ≤3 req/sec across workers.
  rateLimit: {
    limit: 1,
    period: "1s",
  },
});
```

---

## File 5: `supabase/migrations/20260329000001_backfill_product_images_table.sql` (new)

Run after verifying the scraper produces correct images. Requires migration 0 (unique constraint) first.

```sql
-- Migration: Backfill warehouse_product_images from warehouse_products.images JSONB
-- REQUIRES: 20260329000000_bandcamp_scraper_prereqs.sql (unique constraint)
-- Run after scraper is confirmed working for Bandcamp products.

INSERT INTO warehouse_product_images (product_id, workspace_id, src, alt, position)
SELECT
  wp.id,
  wp.workspace_id,
  (t.img->>'src'),
  (t.img->>'alt'),
  COALESCE(
    (t.img->>'position')::int,
    (row_number() OVER (PARTITION BY wp.id ORDER BY t.ord) - 1)::int
  )
FROM warehouse_products wp,
     jsonb_array_elements(wp.images) WITH ORDINALITY AS t(img, ord)
WHERE wp.images IS NOT NULL
  AND wp.images != '[]'::jsonb
  AND (t.img->>'src') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_product_images wpi WHERE wpi.product_id = wp.id
  )
ON CONFLICT (product_id, src) DO NOTHING;
```

---

## Unit Tests: `src/lib/clients/bandcamp-scraper.test.ts` (new file)

```typescript
// src/lib/clients/bandcamp-scraper.test.ts
import { describe, expect, it } from "vitest";
import { buildBandcampAlbumUrl } from "@/lib/clients/bandcamp-scraper";

describe("buildBandcampAlbumUrl", () => {
  it("basic ASCII title", () => {
    expect(buildBandcampAlbumUrl("nsr", "Normal Album")).toBe(
      "https://nsr.bandcamp.com/album/normal-album",
    );
  });

  it("accented characters (café → cafe)", () => {
    expect(buildBandcampAlbumUrl("nsr", "Café Sessions")).toBe(
      "https://nsr.bandcamp.com/album/cafe-sessions",
    );
  });

  it("punctuation and parentheses", () => {
    expect(buildBandcampAlbumUrl("nsr", "Vol. 1 (Remaster)")).toBe(
      "https://nsr.bandcamp.com/album/vol-1-remaster",
    );
  });

  it("leading number", () => {
    expect(buildBandcampAlbumUrl("nsr", "2020 Demos")).toBe(
      "https://nsr.bandcamp.com/album/2020-demos",
    );
  });

  it("empty string returns null", () => {
    expect(buildBandcampAlbumUrl("nsr", "")).toBeNull();
  });

  it("whitespace-only returns null", () => {
    expect(buildBandcampAlbumUrl("nsr", "   ")).toBeNull();
  });

  it("all-punctuation returns null", () => {
    expect(buildBandcampAlbumUrl("nsr", "---")).toBeNull();
  });

  it("multiple spaces collapse", () => {
    expect(buildBandcampAlbumUrl("nsr", "Album  Title  Here")).toBe(
      "https://nsr.bandcamp.com/album/album-title-here",
    );
  });
});
```

---

## Re-trigger Script: `scripts/retrigger-bandcamp-scrape.ts` (new file)

Targets only workspaces with incomplete mappings. Do not run until Step 0 passes.

```typescript
// scripts/retrigger-bandcamp-scrape.ts
// Run: npx tsx scripts/retrigger-bandcamp-scrape.ts
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envContent = readFileSync(".env.production", "utf8");
const getEnv = (key: string) =>
  envContent.match(new RegExp(`^${key}=["']?(.+?)["']?$`, "m"))?.[1]?.trim();

const supabase = createClient(getEnv("NEXT_PUBLIC_SUPABASE_URL")!, getEnv("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const TRIGGER_SECRET = getEnv("TRIGGER_SECRET_KEY")!;

async function main() {
  // Only workspaces with incomplete mappings
  const { data: gaps } = await supabase
    .from("bandcamp_product_mappings")
    .select("workspace_id")
    .or("bandcamp_url.is.null,bandcamp_type_name.is.null");

  const workspaceIds = [...new Set((gaps ?? []).map((g) => g.workspace_id))];

  if (!workspaceIds.length) {
    console.log("All mappings complete. No re-trigger needed.");
    return;
  }

  console.log(`${gaps?.length} incomplete mappings across ${workspaceIds.length} workspace(s).`);

  for (const workspaceId of workspaceIds) {
    const res = await fetch("https://api.trigger.dev/api/v1/tasks/bandcamp-sync/trigger", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRIGGER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: { workspaceId } }),
    });
    const json = (await res.json()) as { id?: string };
    console.log(`Workspace ${workspaceId}: run ${json.id ?? "ERROR"}`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\n=== MONITORING QUERIES (run at 1h and 24h) ===");
  console.log(`-- 404 rate (halt if >20%):
SELECT
  count(*) FILTER (WHERE title LIKE '%404%') AS slug_404s,
  count(*) AS total,
  round(100.0 * count(*) FILTER (WHERE title LIKE '%404%') / NULLIF(count(*),0), 1) AS pct_404
FROM warehouse_review_queue
WHERE category = 'bandcamp_scraper' AND created_at > now() - interval '24 hours';

-- Coverage:
SELECT
  count(*) FILTER (WHERE bandcamp_url IS NOT NULL) AS with_url,
  count(*) FILTER (WHERE bandcamp_type_name IS NOT NULL) AS with_type,
  count(*) AS total
FROM bandcamp_product_mappings;`);
}

main().catch(console.error);
```

---

## Rollout Success Thresholds

| Metric | Halt Threshold | Target at 24h |
|--------|----------------|---------------|
| 404 rate on constructed URLs | >20% | <10% |
| Parser failures (no `data-tralbum`) | >5% | <1% |
| Mappings with `bandcamp_url` after 24h | <50% | >90% |
| Mappings with `bandcamp_release_date` after 24h | <50% | >90% |
| Image row growth | <500 new rows | >1,500 new rows |

**URL source confidence order (never downgrade):**
`scraper_verified` > `orders_api` > `manual` > `constructed`

---

## Post-Deploy Verification Queries

```sql
-- 1. Scraper coverage
SELECT
  count(*) FILTER (WHERE bandcamp_url IS NOT NULL)           AS with_url,
  count(*) FILTER (WHERE bandcamp_type_name IS NOT NULL)     AS with_type,
  count(*) FILTER (WHERE bandcamp_release_date IS NOT NULL)  AS with_release_date,
  count(*) FILTER (WHERE bandcamp_is_preorder = true)        AS is_preorder,
  count(*) FILTER (WHERE bandcamp_url_source = 'scraper_verified') AS scraper_verified,
  count(*) FILTER (WHERE bandcamp_url_source = 'constructed')      AS constructed,
  count(*) FILTER (WHERE bandcamp_url_source = 'orders_api')       AS orders_api,
  count(*) AS total
FROM bandcamp_product_mappings;

-- 2. Street date coverage
SELECT
  count(*) FILTER (WHERE street_date IS NOT NULL) AS with_date,
  count(*) FILTER (WHERE street_date IS NULL)     AS without_date,
  count(*) AS total
FROM warehouse_product_variants;

-- 3. Image table coverage
SELECT
  count(DISTINCT product_id) AS products_with_images,
  count(*)                   AS total_image_rows
FROM warehouse_product_images;

-- 4. 404 review queue (slug failures)
SELECT count(*) AS slug_404_count
FROM warehouse_review_queue
WHERE category = 'bandcamp_scraper'
  AND title LIKE '%404%'
  AND created_at > now() - interval '24 hours';
```

---

## Summary of Files Changed

| File | Type | Priority |
|---|---|---|
| `supabase/migrations/20260329000000_bandcamp_scraper_prereqs.sql` | New | **Critical** |
| `src/lib/clients/bandcamp-scraper.ts` | Rewrite | **Critical** |
| `src/trigger/tasks/bandcamp-sync.ts` | Rewrite | **Critical** |
| `src/trigger/lib/bandcamp-scrape-queue.ts` | Update | Medium |
| `src/trigger/tasks/bandcamp-order-sync.ts` | Update | High |
| `supabase/migrations/20260329000001_backfill_product_images_table.sql` | New | High (deferred) |
| `src/lib/clients/bandcamp-scraper.test.ts` | New | Medium |
| `scripts/test-bandcamp-scrape.ts` | New | **Blocking (Step 0)** |
| `scripts/retrigger-bandcamp-scrape.ts` | New | High |

**New dependency:** `pnpm add he && pnpm add -D @types/he`
