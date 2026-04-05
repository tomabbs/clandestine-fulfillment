---
name: Bandcamp Scraper Fix
overview: "Fix the Bandcamp scraper pipeline end-to-end. Root cause: get_merch_details never returns url, so scraper never fires. Fix: construct album URL from band.subdomain + slugified album_title, parse data-tralbum attribute with he package for robust entity decoding, add idempotency guard, typed errors, and rate limiting."
todos:
  - id: step0-test-scrape
    content: "BLOCKING: run scripts/test-bandcamp-scrape.ts against 5 real pages including NSR albums; confirm data-tralbum present, releaseDate parsed, isPreorder correct, package SKUs visible, albumArtUrl loads"
    status: completed
  - id: dep-he
    content: pnpm add he && pnpm add -D @types/he
    status: completed
  - id: migration-0
    content: "Apply 20260329000000_bandcamp_scraper_prereqs.sql: unique constraint on warehouse_product_images(product_id,src), bandcamp_url_source column, bandcamp_release_date/is_preorder/art_url columns on bandcamp_product_mappings"
    status: completed
  - id: rewrite-scraper
    content: "Rewrite src/lib/clients/bandcamp-scraper.ts: use he for entity decoding, BandcampFetchError with (message,status,url) constructor, updated Zod schema with is_preorder/album_is_preorder/type_id/packages.release_date, buildBandcampAlbumUrl exported from here, parseBandcampPage returning typed ScrapedAlbumData with Date objects"
    status: completed
  - id: rewrite-sync
    content: "Rewrite src/trigger/tasks/bandcamp-sync.ts: import buildBandcampAlbumUrl + BandcampFetchError from scraper; idempotency guard; urlIsConstructed/urlSource/albumTitle in payload; write bandcamp_release_date/is_preorder/art_url; findMatchingPackage with type_id + format keywords including apparel; 404 catch using instanceof"
    status: completed
  - id: update-queue
    content: "Add rateLimit: { limit: 1, period: '1s' } to bandcamp-scrape-queue.ts"
    status: completed
  - id: order-backfill
    content: Add batched item_url backfill to bandcamp-order-sync.ts with bandcamp_url_source='orders_api'; never overwrite non-null URLs
    status: completed
  - id: unit-tests
    content: Add src/lib/clients/bandcamp-scraper.test.ts importing real buildBandcampAlbumUrl function
    status: completed
  - id: retrigger
    content: Run scripts/retrigger-bandcamp-scrape.ts for NSR only first; monitor 404 rate at 1h and 24h; expand to all workspaces if <10% 404 rate
    status: completed
  - id: image-migration
    content: "(Deferred) Migration 20260329000001: backfill warehouse_product_images from images JSONB after scraper confirmed working"
    status: pending
isProject: false
---

# Bandcamp Scraper Fix Plan

## Root Cause Summary

```
bandcamp-sync
  └── for each matched/unmatched merch item:
        if (merchItem.url)   ← ALWAYS FALSE (API never returns url field)
          trigger bandcamp-scrape-page
```

The Bandcamp `get_merch_details` API does not return a `url` field. All 550 `bandcamp_product_mappings` rows have `bandcamp_url = NULL` and `bandcamp_type_name = NULL`, confirming the scraper (`bandcamp-scrape-page` task) has never run.

## Data Already Available

- `band.subdomain` — in `bandSchema` already; populated via `getMyBands()`, accessible as `bandLookup.get(connection.band_id)?.subdomain` inside the sync loop
- `merchItem.album_title` — in `merchItemSchema` already; the album name used to construct the slug
- `item_url` — in `BandcampOrderItem` already (e.g., `"http://band.bandcamp.com/album/foo-bar"`); the orders API returns exact URLs but `bandcamp-order-sync.ts` never uses them to backfill mappings

## Execution Sequence


| Step | Fix                                              | Blocking? | Notes                                                                 |
| ---- | ------------------------------------------------ | --------- | --------------------------------------------------------------------- |
| 0    | Test scrape                                      | **Yes**   | Determines whether `arts` and package `sku` fields exist in real HTML |
| 1    | Fix 4 — retry behavior                           | No        | Safe, tiny, deploy immediately                                        |
| 2    | Fix 1 — URL construction + Fix 3 — package match | **Yes**   | Core scraper unlock; must be right before re-triggering               |
| 3    | Fix 2 — order URL backfill (batched)             | No        | Enriches URL quality over time                                        |
| 4    | Fix 5 — image backfill migration                 | No        | Run after verifying scraper produces good images                      |
| 5    | Fix 6 — re-trigger sync                          | **Yes**   | Batched, monitored; do not proceed if slug 404 rate is high           |


---

## Step 0 (BLOCKING): Test scrape

Before writing any code, run `fetchAlbumPage` + `parseTralbumData` against a known NSR album URL and log the complete raw TralbumData JSON. This verifies:

1. `packages[].arts` — does it exist and contain image IDs? If not, secondary image logic is dead on arrival and must be replaced with DOM scraping.
2. `packages[].sku` — are SKUs present? Determines whether the title-keyword fallback (Fix 3) is needed immediately.
3. `art_id` — is the top-level album art ID populated? Needed for album art URL construction.
4. `releaseDate` — is it in `current.release_date` or `release_date`? Parser already handles both; just confirm.

**If `arts` is empty or missing:** the secondary image plan needs to be revised before any rollout. Halt until the scraper output is understood.

---

## Fix 1: Unblock scraper trigger — URL construction

**File:** `[src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts)`

Add a `buildBandcampAlbumUrl` helper. The slug construction is intentionally simple — non-ASCII and punctuation edge cases are logged rather than silently producing bad URLs.

```typescript
function buildBandcampAlbumUrl(subdomain: string, albumTitle: string): string | null {
  if (!albumTitle.trim()) return null;
  const slug = albumTitle
    .toLowerCase()
    .normalize('NFD')                    // decompose accented chars (é → e + combining)
    .replace(/[\u0300-\u036f]/g, '')     // strip combining diacritics (café → cafe)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return null;
  return `https://${subdomain}.bandcamp.com/album/${slug}`;
}
```

NFD normalization handles the most common non-ASCII case (accented Latin letters) without external dependencies. Genuinely non-ASCII slugs (CJK, Arabic, etc.) will still produce wrong URLs — these are logged via the 404 path (see below).

Replace both `if (merchItem.url)` blocks (matched path ~line 466, unmatched path ~line 667):

```typescript
const bandSubdomain =
  bandLookup.get(connection.band_id)?.subdomain ??
  (connection.band_url ?? '').replace('https://', '').split('.')[0] ??
  null;

const scrapeUrl =
  (merchItem.url as string | null | undefined) ??
  (bandSubdomain && merchItem.album_title
    ? buildBandcampAlbumUrl(bandSubdomain, merchItem.album_title)
    : null);

if (scrapeUrl && mapping) {
  await bandcampScrapePageTask.trigger({
    url: scrapeUrl,
    mappingId: mapping.id,
    workspaceId,
    urlIsConstructed: !merchItem.url,  // flag for 404 logging in scraper
  });
}
```

The `urlIsConstructed` flag in the scrape payload tells the scraper task to log a warning (and create a review queue item) if the URL returns a 404, so slug failures are surfaced rather than silently producing empty data.

Also persist subdomain to `bandcamp_connections.band_url` if missing:

```typescript
if (band?.subdomain && !connection.band_url) {
  await supabase
    .from('bandcamp_connections')
    .update({ band_url: `https://${band.subdomain}.bandcamp.com` })
    .eq('id', connection.id);
}
```

**Unit tests to add** in `src/lib/clients/bandcamp-scraper.test.ts` (or similar):

```typescript
buildBandcampAlbumUrl('nsr', 'Normal Album')       // → .../album/normal-album
buildBandcampAlbumUrl('nsr', 'Café Sessions')      // → .../album/cafe-sessions
buildBandcampAlbumUrl('nsr', 'Vol. 1 (Remaster)')  // → .../album/vol-1-remaster
buildBandcampAlbumUrl('nsr', '')                   // → null
buildBandcampAlbumUrl('nsr', '---')                // → null
```

---

## Fix 2: Backfill item_url from order sync (batched)

**File:** `[src/trigger/tasks/bandcamp-order-sync.ts](src/trigger/tasks/bandcamp-order-sync.ts)`

After processing orders for a connection, batch-backfill `bandcamp_product_mappings.bandcamp_url` from `item_url`. Single variant query per connection (not per item) avoids N×2 query explosion.

```typescript
// After the byPayment loop, add a single-pass URL backfill:
const skuUrlPairs = items
  .filter((i) => i.item_url && i.sku)
  .map((i) => ({ sku: i.sku as string, url: i.item_url as string }));

if (skuUrlPairs.length > 0) {
  const { data: variants } = await supabase
    .from('warehouse_product_variants')
    .select('id, sku')
    .eq('workspace_id', workspaceId)
    .in('sku', skuUrlPairs.map((p) => p.sku));

  const skuToVariantId = new Map((variants ?? []).map((v) => [v.sku, v.id]));

  for (const { sku, url } of skuUrlPairs) {
    const variantId = skuToVariantId.get(sku);
    if (!variantId) continue;
    await supabase
      .from('bandcamp_product_mappings')
      .update({ bandcamp_url: url, updated_at: new Date().toISOString() })
      .eq('variant_id', variantId)
      .is('bandcamp_url', null);  // only fill if not already set
  }
}
```

This is 1 bulk SELECT + at most N individual UPDATEs (only for mappings still missing a URL — typically approaches 0 after the first run). The `.is('bandcamp_url', null)` guard ensures order-synced URLs never overwrite scraper-verified URLs.

---

## Fix 3: Package matching fallback — title keyword match

**File:** `[src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts)` — `storeScrapedImages` (~line 178)

Replace the single-package assumption (risky: could match a digital package for a physical variant) with a format-keyword match:

```typescript
const FORMAT_KEYWORDS = ['lp', 'vinyl', 'cd', 'cassette', 'tape', '7"', '10"', '12"'];

function findMatchingPackage(
  packages: ScrapedAlbumData['packages'],
  variantSku: string | null,
  variantTitle: string | null,
) {
  // 1. Exact SKU match (most reliable)
  if (variantSku) {
    const bysku = packages.find((p) => p.sku === variantSku);
    if (bysku) return bysku;
  }

  // 2. Format keyword match on variant title vs package title
  if (variantTitle) {
    const vtLower = variantTitle.toLowerCase();
    const keyword = FORMAT_KEYWORDS.find((k) => vtLower.includes(k));
    if (keyword) {
      const byKeyword = packages.find((p) =>
        p.title?.toLowerCase().includes(keyword)
      );
      if (byKeyword) return byKeyword;
    }
  }

  return null; // no match — don't guess
}
```

Dropping the single-package fallback prevents pulling digital album art for a physical LP variant when they happen to be the only package listed. When no match is found, album art (top-level `artId`) is still stored — only the package-specific secondary photos are skipped.

**Also verify `bandcamp_type_name` write path:** The scraper writes `bandcamp_type_name` to `bandcamp_product_mappings` (line 33 of `bandcamp-sync.ts`). It does NOT write it to `warehouse_product_variants` or `warehouse_products`. Currently all 550 rows show `bandcamp_type_name = NULL` because the scraper has never run. After Fix 1 unblocks the scraper, this field will populate automatically on the next sync. No additional code change needed — just confirm post-deploy.

---

## Fix 4: Fix scraper retry on parse failure

**File:** `[src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts)` — `bandcampScrapePageTask.run` (~line 113)

Also handle 404 from constructed URLs specifically:

```typescript
} catch (error) {
  const is404 = String(error).includes('404');
  logger.error("Scrape failed", {
    url: payload.url,
    urlIsConstructed: payload.urlIsConstructed,
    error: String(error),
  });

  if (is404 && payload.urlIsConstructed) {
    // Constructed slug was wrong — log to review queue, don't retry
    await supabase.from("warehouse_review_queue").upsert({
      workspace_id: payload.workspaceId,
      category: "bandcamp_scraper",
      severity: "low",
      title: `Constructed Bandcamp URL returned 404`,
      description: `URL: ${payload.url}. The album slug may not match. Manual URL correction needed.`,
      metadata: { url: payload.url, mappingId: payload.mappingId },
      status: "open",
      group_key: `bc_scrape_404_${payload.mappingId}`,
      occurrence_count: 1,
    }, { onConflict: "group_key", ignoreDuplicates: false });
    return { success: false, reason: '404_constructed_url' };  // don't retry 404s
  }

  throw error; // non-404 failures: throw so Trigger.dev retries
}
```

This differentiates real network/parse failures (retried) from bad constructed slugs (logged to review queue, not retried endlessly).

Also add `urlIsConstructed: boolean` to the scraper task payload type.

---

## Fix 5: Backfill warehouse_product_images from images JSONB

**File:** New migration `supabase/migrations/20260329000001_backfill_product_images_table.sql`

2,159 products have `images` JSONB set (from Shopify sync) but only 649 have rows in `warehouse_product_images`. Run after verifying the scraper produces good images (so scraped images are written first for Bandcamp products, and this backfill only fills the remaining gap for non-Bandcamp products).

```sql
INSERT INTO warehouse_product_images (product_id, workspace_id, src, alt, position)
SELECT
  wp.id,
  wp.workspace_id,
  (img->>'src'),
  (img->>'alt'),
  COALESCE(
    (img->>'position')::int,
    (row_number() OVER (PARTITION BY wp.id ORDER BY ord) - 1)::int
  )
FROM warehouse_products wp,
     jsonb_array_elements(wp.images) WITH ORDINALITY AS t(img, ord)
WHERE wp.images IS NOT NULL
  AND wp.images != '[]'::jsonb
  AND (img->>'src') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_product_images wpi WHERE wpi.product_id = wp.id
  )
ON CONFLICT DO NOTHING;
```

---

## Fix 6: Re-trigger sync — batched with monitoring

After deploying Fixes 1–4, trigger `bandcamp-sync` in batches rather than all at once:

- Process 50 `bandcamp_product_mappings` per batch with a 2-second delay between scrape triggers
- Monitor the review queue for `category = 'bandcamp_scraper'` and `title LIKE '%404%'` items — if more than 20% of URLs are 404ing, halt and investigate slug construction
- The scraper writes are additive: `storeScrapedImages` only inserts images not already present (`existingSrcs` set check), so re-running is safe
- `street_date` backfill: the sync only sets `street_date` when `!variant.street_date` — existing dates are never overwritten

**Rollback plan:** If scraped data is wrong (e.g., wrong album art for a product), the scraper-inserted images are in `warehouse_product_images` and can be deleted by `product_id` with a targeted SQL DELETE. No destructive writes occur to `warehouse_products` (only additive image inserts and additive JSON merges).