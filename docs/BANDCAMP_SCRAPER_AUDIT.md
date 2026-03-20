# Bandcamp Scraper Audit

**Date:** 2026-03-19  
**Issue:** Images from scraper not loading as expected

---

## Overview

The Bandcamp scraper fetches release dates and images from album page HTML (TralbumData) because the Bandcamp API does not provide these. It runs as a Trigger task `bandcamp-scrape-page` after the main sync.

---

## Data Flow

```
bandcamp-sync (main)
  → getMerchDetails (API)
  → matchSkuToVariants
  → For matched: upsert mapping, backfill variant, insert API image (if image_url), trigger bandcamp-scrape-page
  → For unmatched: create product+variant+mapping, insert API image, trigger bandcamp-scrape-page

bandcamp-scrape-page (async)
  → fetchAlbumPage(url)
  → parseTralbumData(html)
  → Update bandcamp_product_mappings (type_name, new_date, bandcamp_url)
  → Backfill variant street_date
  → storeScrapedImages() ← IMAGE STORAGE
```

---

## Root Cause: Images Not Loading

**Bug:** `storeScrapedImages` returns immediately if the product already has **any** images:

```typescript
// bandcamp-sync.ts lines 135-140
const { count: existingCount } = await supabase
  .from("warehouse_product_images")
  .select("id", { count: "exact", head: true })
  .eq("product_id", productId);

if ((existingCount ?? 0) > 0) return;  // ← BLOCKS SCRAPED IMAGES
```

**Sequence:**
1. Main sync runs first. For matched items, if `merchItem.image_url` exists, it inserts 1 image from the API (lines 406-428).
2. Main sync triggers `bandcamp-scrape-page` (async, does not wait).
3. Scrape task runs in a separate worker, **after** the main sync has finished.
4. When `storeScrapedImages` runs, the product already has 1 image from the API.
5. `existingCount > 0` → early return → **scraped images (album art, extra merch photos) never get stored**.

Same for auto-created products: we insert 1 API image (lines 417-424, 546-552) before triggering the scrape. Scraper runs later, sees existing image, skips.

---

## What Works

| Component | Status |
|-----------|--------|
| `fetchAlbumPage` | Fetches HTML with User-Agent |
| `parseTralbumData` (V1/V2) | Extracts art_id, release_date, packages with sku, image_id, arts |
| `bandcampAlbumArtUrl` / `bandcampMerchImageUrl` | Correct bcbits.com URL format |
| `street_date` backfill | Works — no early return |
| Scrape task trigger | Fired for matched + unmatched items when `merchItem.url` exists |
| SKU → package matching | Matches variant SKU to scraped package SKU |
| Unit tests | Pass against fixture |

---

## What Doesn't Work

| Issue | Cause |
|-------|-------|
| Scraped images not stored | Idempotent check blocks when API image exists |
| Additional merch arts (extra angles) | Never inserted because of above |
| Album art when API provided 1 image | Same block |

---

## Fix Applied

Change `storeScrapedImages` to **merge** instead of **skip**:

- Fetch existing image `src` URLs for the product.
- Only insert scraped images whose `src` is not already present.
- Avoid duplicates while allowing scraper to add album art + extra merch photos.

---

## Files Affected

| File | Change |
|------|--------|
| `src/trigger/tasks/bandcamp-sync.ts` | `storeScrapedImages`: remove early return, merge new images by src |
| `docs/BANDCAMP_SCRAPER_AUDIT.md` | This audit |

---

## Edge Cases

1. **Variant SKU not in scraped packages:** Only album art (if any) is added. Package-specific merch images require SKU match.
2. **Package has no image_id / arts:** Cassette in fixture has no image — we get album art only for that variant.
3. **Parse failure:** Returns default (Merch, no images). Metadata incomplete flagged in review queue.
4. **Bandcamp DOM change:** V1/V2 parsers + fixture snapshot tests catch this (Rule #18).
