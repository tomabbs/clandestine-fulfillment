# Product Title + Data Integrity Fix — Handoff Document

---

## Problem Summary

Three interrelated data integrity issues affect Bandcamp-mapped products:

**Issue 1 — Wrong titles (92%):** Product titles use the label name as the artist instead of the actual performing artist. 1,299 of 1,413 products affected.

**Issue 2 — Wrong album art (29%):** Product images show artwork from a different album than the product. 407 of 1,413 products have art that doesn't match their mapping's `bandcamp_art_url`.

**Issue 3 — Wrong URLs/album data:** The mapping data (URL, album title, scraper data) can be correct while the product title/images show data from a different release. This is because the product title is set at creation time from the wrong artist name, and images are backfilled from the scraper which may scrape the correct URL but attach the art to a product with a corrupted title.

**Example of the bug:**

| Current (wrong) | Correct |
|-----------------|---------|
| LEAVING RECORDS - Soft Echoes - CASSETTE | Kemialliset Ystävät - SIIPI EMPII Cassette |
| LEAVING RECORDS - A Self - VINYL | Lionmilk - Intergalactic Warp Terminal 222 2 x Vinyl LP |
| LEAVING RECORDS - Technoself - Technoself 12" Vinyl LP | Lionmilk - Visions in Paraíso Cassette |
| 'Hubble Eagle' - 12 inch Vinyl | NNA Tapes - 'Hubble Eagle' Vinyl LP |
| University! - University! Compact Disc | Popstar Benny - University! |

**Expected naming schema:** `{Artist Name} - {Album Title} {Format Type}`

---

## Root Cause

### The bug in `assembleBandcampTitle()`

**File:** `src/lib/clients/bandcamp.ts` lines 418-440

```typescript
/**
 * Build a product title from Bandcamp merch item metadata.
 *
 * Artist name is the band/performer — MUST be in the title for identification.
 * Vendor/org is stored separately and should NOT be duplicated here.
 *
 * Format:
 *   - "{artistName} - {itemTitle}" when artist exists and differs from itemTitle
 *   - "{itemTitle}" when artist is empty, null, or same as itemTitle
 */
export function assembleBandcampTitle(
  artistName: string,
  _albumTitle: string | null | undefined,  // <-- BUG: ignored (underscore prefix)
  itemTitle: string,
): string {
  const artist = artistName?.trim();
  if (artist && artist !== itemTitle) {
    return `${artist} - ${itemTitle}`;
  }
  return itemTitle;
}
```

**Two bugs:**
1. `_albumTitle` is prefixed with underscore and never used — the album title is ignored entirely
2. `artistName` receives the wrong value from the caller (see below)

### The bug in `bandcamp-sync.ts`

**File:** `src/trigger/tasks/bandcamp-sync.ts` line 1142

```typescript
const artistName = band?.name ?? connection.band_name ?? "Unknown Artist";
```

`band?.name` comes from the `bandLookup` map (built at lines 810-817). For label accounts like Leaving Records that distribute many artists, `band.name` is the **label name** ("LEAVING RECORDS"), not the performing artist ("Lionmilk", "Kemialliset Ystävät", etc.).

The actual artist name IS available via `merchItem.member_band_id` — each merch item carries the `member_band_id` of the artist band. The `bandLookup` map already includes member bands (lines 813-816):

```typescript
const bandLookup = new Map<number, BandcampBand>();
for (const band of bands) {
  bandLookup.set(band.band_id, band);
  if (band.member_bands) {
    for (const mb of band.member_bands) {
      bandLookup.set(mb.band_id, { ...mb, member_bands: [] });
    }
  }
}
```

So looking up `bandLookup.get(merchItem.member_band_id)` would return the correct artist band with its display name — but the code at line 1142 doesn't do this lookup.

---

## Bandcamp API Data Model

### `my_bands` endpoint response

```
POST https://bandcamp.com/api/account/1/my_bands
```

Returns the label's bands and their member artists:

```json
{
  "bands": [
    {
      "band_id": 1234567890,
      "name": "LEAVING RECORDS",
      "subdomain": "leavingrecords",
      "member_bands": [
        { "band_id": 858513783, "name": "Lionmilk", "subdomain": "lionmilk" },
        { "band_id": 1283040115, "name": "Kemialliset Ystävät", "subdomain": "kemiallisetystavat" },
        { "band_id": 804873099, "name": "Popstar Benny", "subdomain": "popstarbenny" }
      ]
    }
  ]
}
```

### `get_merch_details` endpoint response

```
POST https://bandcamp.com/api/merchorders/1/get_merch_details
Body: { "band_id": 1234567890, "start_time": "2000-01-01 00:00:00" }
```

Each merch item includes:

```json
{
  "package_id": 3135397435,
  "title": "12\" Vinyl",
  "album_title": "Music Belongs To The Universe",
  "sku": "LP-BW-016",
  "item_type": "Vinyl LP",
  "member_band_id": 858513783,
  "subdomain": "nicogeoris",
  "price": 25,
  "quantity_available": 0,
  "quantity_sold": 0,
  "url": "https://nicogeoris.bandcamp.com/album/music-belongs-to-the-universe"
}
```

The key field is `member_band_id` — it identifies which artist under the label owns this item.

### Zod schema (from the codebase)

**File:** `src/lib/clients/bandcamp.ts` lines 66-87

```typescript
const merchItemSchema = z
  .object({
    package_id: z.number(),
    title: z.string(),
    album_title: z.string().nullish(),
    sku: z.string().nullish(),
    item_type: z.string().nullish(),
    member_band_id: z.number().nullish(),
    new_date: z.string().nullish(),
    price: z.number().nullish(),
    currency: z.string().nullish(),
    quantity_available: z.number().nullish(),
    quantity_sold: z.number().nullish(),
    origin_quantity: z.number().nullish(),
    url: z.string().nullish(),
    image_url: z.string().nullish(),
    subdomain: z.string().nullish(),
    is_set_price: z.union([z.boolean(), z.number()]).nullish(),
    options: z.array(merchOptionSchema).nullish(),
    origin_quantities: z.array(originQuantitySchema).nullish(),
  })
  .passthrough();
```

---

## Database Fields

### `bandcamp_connections` table

| Column | Type | Relevant to fix |
|--------|------|-----------------|
| `band_id` | integer | The label's band ID on Bandcamp |
| `band_name` | text | The label name (e.g., "LEAVING RECORDS") |
| `member_bands_cache` | jsonb | Cached `my_bands` response including `member_bands` array with `{ band_id, name, subdomain }` per artist |

**Sample `member_bands_cache` structure:**

```json
{
  "band_id": 1234567890,
  "name": "LEAVING RECORDS",
  "member_bands": [
    { "band_id": 858513783, "name": "Lionmilk", "subdomain": "lionmilk" },
    { "band_id": 1283040115, "name": "Kemialliset Ystävät", "subdomain": "kemiallisetystavat" }
  ]
}
```

Refreshed on every `bandcamp-sync` run at line 837:

```typescript
const updatePayload: Record<string, unknown> = {
  member_bands_cache: band as unknown as Record<string, unknown>,
  band_name: band.name,
  updated_at: new Date().toISOString(),
};
```

### `bandcamp_product_mappings` table

| Column | Type | Relevant to fix |
|--------|------|-----------------|
| `variant_id` | uuid | FK to `warehouse_product_variants` |
| `bandcamp_member_band_id` | bigint | The artist's band ID — key for name lookup |
| `bandcamp_album_title` | text | Album name (e.g., "SIIPI EMPII") |
| `bandcamp_type_name` | text | Format (e.g., "Cassette", "Vinyl LP", "Compact Disc (CD)") |
| `bandcamp_subdomain` | text | Artist URL slug (e.g., "kemiallisetystavat") |
| `authority_status` | text | `bandcamp_initial`, `warehouse_reviewed`, or `warehouse_locked` |
| `raw_api_data` | jsonb | Full merch item from API |

### `warehouse_products` table

| Column | Type | Relevant to fix |
|--------|------|-----------------|
| `id` | uuid | PK |
| `title` | text | The product title — THIS IS WHAT WE'RE FIXING |
| `vendor` | text | Label name (set correctly as the label, NOT the artist) |
| `product_type` | text | Format category |
| `shopify_product_id` | text | Non-null if created in Shopify |

---

## Live Data Audit Results (April 10, 2026)

### Title vs album alignment

Product title should contain the album name from `bandcamp_product_mappings.bandcamp_album_title`. This measures whether the product title refers to the correct Bandcamp release:

| Category | Count |
|----------|-------|
| Title contains album name (aligned) | 782 |
| Title does NOT contain album name (misaligned) | 434 |
| No album title on mapping (merch items) | 197 |

**434 products have titles that refer to a different album than their Bandcamp mapping.** Their images and URLs are correct per Bandcamp (the mapping data matches the API), but their product titles don't match. Fixing the titles will bring everything into alignment.

**Example:** SKU `NG-MBTTU-V` — product title says "Eurybia - 2ND CASSETTE EDITION" but the Bandcamp mapping says `album_title = "Music Belongs To The Universe"` and `title = "BLACK VINYL"`. The correct product title is "Nico Georis - Music Belongs To The Universe BLACK VINYL". The images (from the scraper) correctly show "Music Belongs To The Universe" artwork — they match the mapping, not the title.

### Title correctness (artist name)

| Category | Count | % |
|----------|-------|---|
| Total Bandcamp-mapped products | 1,413 | 100% |
| Correct title | 42 | 3% |
| Wrong title (fixable from cached data) | 1,299 | 92% |
| Cannot fix (member_band_id not in cache) | 72 | 5% |

### Artist name resolution coverage

| Source | Count |
|--------|-------|
| Total `member_band_id` entries in `member_bands_cache` | 417 |
| Mappings resolved from cache | 1,341 (95%) |
| Unresolvable without API call | 72 (5%) |
| Label self-references (label IS the artist) | 312 |

### Audit query (reproduce)

```javascript
// Run with: node -e "..." in project root with dotenv
require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Build member_band_id → name map from all connections
const allConns = await sb.from('bandcamp_connections').select('band_id, band_name, member_bands_cache');
const memberMap = new Map();
for (const c of allConns.data) {
  memberMap.set(c.band_id, c.band_name);
  const cache = typeof c.member_bands_cache === 'string' ? JSON.parse(c.member_bands_cache) : c.member_bands_cache;
  const members = cache?.member_bands ?? (Array.isArray(cache) ? cache : []);
  for (const mb of members) { if (mb.band_id && mb.name) memberMap.set(mb.band_id, mb.name); }
}
// memberMap now has 417 entries → 95% coverage
```

---

## Current Code (Full Files)

### `src/lib/clients/bandcamp.ts` — `assembleBandcampTitle` (lines 418-440)

```typescript
// === Title assembly for Shopify product creation ===

/**
 * Build a product title from Bandcamp merch item metadata.
 *
 * Artist name is the band/performer — MUST be in the title for identification.
 * Vendor/org is stored separately and should NOT be duplicated here.
 *
 * Format:
 *   - "{artistName} - {itemTitle}" when artist exists and differs from itemTitle
 *   - "{itemTitle}" when artist is empty, null, or same as itemTitle
 */
export function assembleBandcampTitle(
  artistName: string,
  _albumTitle: string | null | undefined,
  itemTitle: string,
): string {
  const artist = artistName?.trim();
  if (artist && artist !== itemTitle) {
    return `${artist} - ${itemTitle}`;
  }
  return itemTitle;
}
```

### `src/trigger/tasks/bandcamp-sync.ts` — Title construction for new products (lines 1141-1176)

```typescript
for (const merchItem of unmatched) {
  const artistName = band?.name ?? connection.band_name ?? "Unknown Artist";

  // Auto-generate SKU if missing
  let effectiveSku = merchItem.sku;
  let skuGenerated = false;
  if (!effectiveSku) {
    effectiveSku = generateSku(merchItem, artistName, existingSkuSet);
    skuGenerated = true;
    // ... SKU push logic ...
  }

  const title = assembleBandcampTitle(artistName, merchItem.album_title, merchItem.title);
  const tags: string[] = [];
  if (merchItem.new_date && new Date(merchItem.new_date) > new Date()) {
    tags.push("Pre-Orders", "New Releases");
  }
```

### `src/trigger/tasks/bandcamp-sync.ts` — `bandLookup` construction (lines 810-818)

```typescript
const bandLookup = new Map<number, BandcampBand>();
for (const band of bands) {
  bandLookup.set(band.band_id, band);
  if (band.member_bands) {
    for (const mb of band.member_bands) {
      bandLookup.set(mb.band_id, { ...mb, member_bands: [] });
    }
  }
}
```

### `tests/unit/lib/clients/bandcamp.test.ts` — Current tests (lines 129-151)

```typescript
describe("assembleBandcampTitle", () => {
  it("builds title with artist and item", () => {
    expect(assembleBandcampTitle("Artist", "Album", "LP")).toBe("Artist - LP");
  });

  it("keeps artist even when album matches item", () => {
    expect(assembleBandcampTitle("Artist", "Same Title", "Same Title")).toBe(
      "Artist - Same Title",
    );
  });

  it("keeps artist when album is null", () => {
    expect(assembleBandcampTitle("Artist", null, "CD")).toBe("Artist - CD");
  });

  it("uses item alone when artist matches item", () => {
    expect(assembleBandcampTitle("Tape", undefined, "Tape")).toBe("Tape");
  });

  it("uses item alone when artist is empty", () => {
    expect(assembleBandcampTitle("", null, "Some Item")).toBe("Some Item");
  });
});
```

---

## Additional Issue: Wrong Art/URLs (Issue 2 + 3)

### Symptom

The product at `/admin/catalog/ad1fa562-e229-42e2-8269-4358b09367ec`:
- Title: "LEAVING RECORDS - Eurybia - 2ND CASSETTE EDITION: AQUA EURYBIA"
- Shows artwork from "Music Belongs To The Universe" by Nico Georis
- URL in mapping: `nicogeoris.bandcamp.com/album/music-belongs-to-the-universe`
- SKU: `NG-MBTTU-V`

### Investigation

```
Product ID: ad1fa562-e229-42e2-8269-4358b09367ec
Product title: LEAVING RECORDS - Eurybia - 2ND CASSETTE EDITION: AQUA EURYBIA
shopify_product_id: null (Bandcamp-created, not from Shopify)

Variant SKU: NG-MBTTU-V
Variant title: 2ND CASSETTE EDITION: AQUA EURYBIA

Mapping data:
  bandcamp_item_id: 52534376
  bandcamp_album_title: Music Belongs To The Universe  ← CORRECT for this SKU
  bandcamp_url: nicogeoris.bandcamp.com/album/music-belongs-to-the-universe
  raw_api_data.title: BLACK VINYL  ← What Bandcamp calls this package
  raw_api_data.album_title: Music Belongs To The Universe
  raw_api_data.sku: NG-MBTTU-V  ← SKU matches the variant

Product images:
  Position 0: f4.bcbits.com/img/a2698838620_10.jpg (alt: "Music Belongs To The Universe - Album Art")
  Position 1: f4.bcbits.com/img/38453338_10.jpg (alt: "Vinyl LP - Product Photo")
  Position 2: f4.bcbits.com/img/38512986_10.jpg (alt: "Vinyl LP - Product Photo")
```

### Root cause

The mapping data is actually **correct** — SKU `NG-MBTTU-V` IS the "Music Belongs To The Universe BLACK VINYL" on Bandcamp. The problem is:

1. `assembleBandcampTitle` used the label name ("LEAVING RECORDS") instead of the artist name ("Nico Georis")
2. Someone or something then changed the product title to include "Eurybia" — but the mapping, URL, and art still correctly point to "Music Belongs To The Universe"

The title "Eurybia" is wrong — it should be "Nico Georis - Music Belongs To The Universe BLACK VINYL" based on the mapping data.

### Scale of art mismatches

| Category | Count |
|----------|-------|
| Products with correct Bandcamp art | 708 |
| Products with WRONG art (mapping art != product primary image) | 407 |
| No art data to compare | 298 |
| Total | 1,413 |

The art mismatches are likely from the same root cause as the title issues — the mapping data is correct but the product/images were set from the wrong source during creation, or the scraper attached art from the correct album to a product whose title had already been corrupted.

### Fix approach for art/images

The title correction script (Fix 4) should also:

1. For each product being title-corrected, check if the mapping's `bandcamp_art_url` matches the product's primary image
2. If not, update the product's primary image to the mapping's `bandcamp_art_url`
3. Log the old and new image URLs for rollback
4. The `bandcamp_art_url` is set by the scraper from the actual Bandcamp page HTML and is authoritative

---

## Proposed Fix

### Fix 1: Update `assembleBandcampTitle()` in `src/lib/clients/bandcamp.ts`

**Replace lines 418-440 with:**

```typescript
// === Title assembly for Shopify product creation ===

/**
 * Build a product title from Bandcamp merch item metadata.
 *
 * Naming schema: "{Artist} - {Album Title} {Format Type}"
 * For merch without albums: "{Artist} - {Item Title}"
 * Vendor/org is stored separately and should NOT be duplicated here.
 */
export function assembleBandcampTitle(
  artistName: string,
  albumTitle: string | null | undefined,
  itemTitle: string,
  formatType?: string | null,
): string {
  const artist = artistName?.trim();
  if (!artist) return itemTitle;

  if (albumTitle?.trim()) {
    const album = albumTitle.trim();
    const format = formatType?.trim();
    const needsFormat = format && !album.includes(format) && itemTitle !== format;
    return needsFormat ? `${artist} - ${album} ${format}` : `${artist} - ${album}`;
  }

  if (artist !== itemTitle) {
    return `${artist} - ${itemTitle}`;
  }
  return itemTitle;
}
```

**What changed:**
- `_albumTitle` → `albumTitle` (no longer ignored)
- Added optional `formatType` parameter
- When album exists: `{artist} - {album} {format}`
- When no album: `{artist} - {itemTitle}` (merch, shirts)
- When artist equals itemTitle: just `{itemTitle}` (avoids "Tape - Tape")

### Fix 2: Update artist resolution in `src/trigger/tasks/bandcamp-sync.ts` line 1142

**Replace:**

```typescript
const artistName = band?.name ?? connection.band_name ?? "Unknown Artist";
```

**With:**

```typescript
const memberBand = merchItem.member_band_id
  ? bandLookup.get(merchItem.member_band_id)
  : null;
const artistName = memberBand?.name ?? band?.name ?? connection.band_name ?? "Unknown Artist";
```

**And update line 1176:**

```typescript
// Replace:
const title = assembleBandcampTitle(artistName, merchItem.album_title, merchItem.title);

// With:
const title = assembleBandcampTitle(artistName, merchItem.album_title, merchItem.title, merchItem.item_type);
```

### Fix 3: Update tests in `tests/unit/lib/clients/bandcamp.test.ts`

**Replace the `assembleBandcampTitle` describe block with:**

```typescript
describe("assembleBandcampTitle", () => {
  it("builds title with artist, album, and format", () => {
    expect(assembleBandcampTitle("Lionmilk", "Visions in Paraíso", "CASSETTE", "Cassette")).toBe(
      "Lionmilk - Visions in Paraíso Cassette",
    );
  });

  it("builds title with artist and album but no format", () => {
    expect(assembleBandcampTitle("Artist", "Album Title", "LP")).toBe("Artist - Album Title");
  });

  it("omits format when format is null", () => {
    expect(assembleBandcampTitle("Artist", "Album", "LP", null)).toBe("Artist - Album");
  });

  it("deduplicates when itemTitle equals formatType", () => {
    expect(assembleBandcampTitle("Artist", "Album", "Cassette", "Cassette")).toBe(
      "Artist - Album Cassette",
    );
  });

  it("omits format when album already contains it", () => {
    expect(assembleBandcampTitle("Artist", "Album Vinyl LP", "VINYL", "Vinyl LP")).toBe(
      "Artist - Album Vinyl LP",
    );
  });

  it("uses item title for merch without album", () => {
    expect(assembleBandcampTitle("LEAVING RECORDS", null, "Rainbow Bridge Magnet")).toBe(
      "LEAVING RECORDS - Rainbow Bridge Magnet",
    );
  });

  it("uses item alone when artist matches item", () => {
    expect(assembleBandcampTitle("Tape", undefined, "Tape")).toBe("Tape");
  });

  it("uses item alone when artist is empty", () => {
    expect(assembleBandcampTitle("", null, "Some Item")).toBe("Some Item");
  });

  it("handles format type with album", () => {
    expect(
      assembleBandcampTitle("Nico Georis", "Music Belongs To The Universe", "12\" Vinyl", "Vinyl LP"),
    ).toBe("Nico Georis - Music Belongs To The Universe Vinyl LP");
  });
});
```

### Fix 4: One-time title + art correction script

**New file:** `scripts/fix-product-data.ts`

This script corrects titles AND artwork:

1. Builds the `member_band_id` → `artist name` map from `member_bands_cache`
2. For each `bandcamp_product_mapping` with `authority_status = 'bandcamp_initial'`:
   - **Title fix:** Resolves the artist name from `member_band_id`, builds the correct title `{artist} - {album} {format}`, updates `warehouse_products.title` if different
   - **Art fix:** Compares the product's primary image against the mapping's `bandcamp_art_url`. If they differ, updates the primary image to the correct album art
   - **Image alt fix:** Updates image alt text to match the corrected title
3. Logs all changes to `channel_sync_log` with `sync_type = 'product_data_correction'` and metadata containing old/new title, old/new image URL
4. Exports unresolvable items (72) to a CSV for manual review
5. Produces a summary CSV showing all corrections made
6. Supports `--dry-run` and `--apply` flags

---

### Image write paths in `bandcamp-sync.ts` (3 locations)

**Path 1 — Scraper art insertion (line 652-660):**
Called when the HTML scraper runs on a Bandcamp page. Inserts album art at position 0.
```typescript
if (wantAlbumArt && scraped.albumArtUrl) {
  imagesToInsert.push({
    product_id: productId,
    workspace_id: workspaceId,
    src: scraped.albumArtUrl,
    alt: scraped.title ? `${scraped.title} - Album Art` : "Album Art",
    position: 0,
  });
}
```

**Path 2 — API image backfill for matched items (line 1090-1110):**
Only fires if the product has NO images yet. Uses the merch item's `image_url` from the API.
```typescript
if (bandcampImageUrl(merchItem.image_url) && existingVar.product_id) {
  const { count: imgCount } = await supabase
    .from("warehouse_product_images")
    .select("id", { count: "exact", head: true })
    .eq("product_id", existingVar.product_id);

  if ((imgCount ?? 0) === 0) {
    await supabase.from("warehouse_product_images").insert({
      product_id: existingVar.product_id,
      workspace_id: workspaceId,
      src: bandcampImageUrl(merchItem.image_url),
      alt: merchItem.title,
      position: 0,
    });
  }
}
```

**Path 3 — Image for newly auto-created products (line 1328-1334):**
Fires during the unmatched-product-create flow.
```typescript
if (bandcampImageUrl(merchItem.image_url)) {
  await supabase.from("warehouse_product_images").insert({
    product_id: product.id,
    src: bandcampImageUrl(merchItem.image_url),
    alt: title,
    position: 0,
  });
}
```

**Key observation:** None of these paths verify that the image matches the product being created. If the product title was set wrong (due to the artist name bug), the image alt text also gets wrong. The scraper path (Path 1) gets the art from the correct URL, but the alt text uses the scraped page title, not the product title. This can cause the right art to be labeled wrong, or the wrong art to be attached if multiple scrapes run in sequence.

---

## Authority Lifecycle Constraint

From `TRUTH_LAYER.md`:

> Bandcamp follows an **authority lifecycle**: Bandcamp API is authoritative for **initial ingest** (new titles, SKU/quantity/date/price bootstrap). After staff review or physical count, the warehouse app becomes authoritative for **operational fields**. Governed by `authority_status` on `bandcamp_product_mappings` (`bandcamp_initial` → `warehouse_reviewed` → `warehouse_locked`).

The title fix script must only update products with `authority_status = 'bandcamp_initial'`. Products that staff have reviewed or locked should not have their titles overwritten.

---

## Trigger Touchpoint

| Task ID | File | Impact |
|---------|------|--------|
| `bandcamp-sync` / `bandcamp-sync-cron` | `src/trigger/tasks/bandcamp-sync.ts` | Creates new products with titles — the artist resolution fix affects all future auto-creates |

No other trigger tasks construct product titles. The `shopify-sync` copies titles from Shopify verbatim and is not affected.

---

## Verification Plan

1. `pnpm typecheck` — zero errors
2. `pnpm test` — all tests pass (including updated `assembleBandcampTitle` tests)
3. `pnpm release:gate` — full gate passes
4. Run `scripts/fix-product-titles.ts --dry-run` — review sample output
5. Spot-check 10 Leaving Records titles against Bandcamp pages
6. Spot-check 5 True Panther titles

---

## Full Trigger.dev Code — Critical Sections

**Full file:** `src/trigger/tasks/bandcamp-sync.ts` (1,867 lines)

The relevant sections for this fix are:

### bandLookup construction (lines 810-818)

This builds the map that should be used for artist name resolution. It already includes member bands:

```typescript
const bandLookup = new Map<number, BandcampBand>();
for (const band of bands) {
  bandLookup.set(band.band_id, band);
  if (band.member_bands) {
    for (const mb of band.member_bands) {
      bandLookup.set(mb.band_id, { ...mb, member_bands: [] });
    }
  }
}
```

### member_bands_cache persistence (lines 834-844)

On every sync run, the band's member_bands are cached for offline use:

```typescript
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
```

### Mapping upsert for matched SKUs (lines 880-929)

When a Bandcamp merch item matches an existing warehouse variant by SKU, the mapping is upserted with all Bandcamp data:

```typescript
const upsertPayload: Record<string, unknown> = {
  workspace_id: workspaceId,
  variant_id: variantId,
  bandcamp_item_id: merchItem.package_id,
  bandcamp_item_type: merchItem.item_type?.toLowerCase().includes("album") ? "album" : "package",
  bandcamp_member_band_id: merchItem.member_band_id,
  bandcamp_image_url: bandcampImageUrl(merchItem.image_url) ?? null,
  bandcamp_subdomain: merchItem.subdomain ?? null,
  bandcamp_album_title: merchItem.album_title ?? null,
  bandcamp_price: merchItem.price ?? null,
  bandcamp_currency: merchItem.currency ?? null,
  bandcamp_is_set_price: merchItem.is_set_price != null ? Boolean(merchItem.is_set_price) : null,
  bandcamp_options: merchItem.options ?? null,
  bandcamp_origin_quantities: merchItem.origin_quantities ?? null,
  bandcamp_new_date: merchItem.new_date ?? null,
  bandcamp_option_skus: optionSkus.length > 0 ? optionSkus : null,
  last_quantity_sold: merchItem.quantity_sold,
  last_synced_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  raw_api_data: merchItem,
};
// ... URL handling ...
await supabase.from("bandcamp_product_mappings").upsert(upsertPayload, { onConflict: "variant_id" });
```

**Note:** The mapping is keyed by `variant_id` (UNIQUE). Each variant has exactly one mapping. The mapping stores the correct Bandcamp data. The PRODUCT TITLE is set separately and is NOT updated by this upsert.

### Image backfill for matched products (lines 1090-1109)

Images are backfilled from the Bandcamp mapping's image URL only if the product has NO images yet:

```typescript
if (bandcampImageUrl(merchItem.image_url) && existingVar.product_id) {
  const { count: imgCount } = await supabase
    .from("warehouse_product_images")
    .select("id", { count: "exact", head: true })
    .eq("product_id", existingVar.product_id);

  if ((imgCount ?? 0) === 0) {
    await supabase.from("warehouse_product_images").insert({
      product_id: existingVar.product_id,
      workspace_id: workspaceId,
      src: bandcampImageUrl(merchItem.image_url),
      alt: merchItem.title,
      position: 0,
    });
  }
}
```

**Note:** This only fires when `imgCount === 0`. It won't overwrite existing images. For the corrupted products, images were set via the scraper (a separate system), not this backfill.

### Unmatched product creation — the title bug site (lines 1141-1310)

This is where new products are created for Bandcamp items that don't match any existing warehouse variant by SKU:

```typescript
for (const merchItem of unmatched) {
  const artistName = band?.name ?? connection.band_name ?? "Unknown Artist";
  // ^^^ BUG: uses label name, not artist name

  // ... SKU generation ...

  const title = assembleBandcampTitle(artistName, merchItem.album_title, merchItem.title);
  // ^^^ BUG: assembleBandcampTitle ignores albumTitle

  // ... Shopify draft creation ...
  // ... DB product + variant creation ...
}
```

### Full `bandcamp.ts` client — assembleBandcampTitle + API schemas

The full `src/lib/clients/bandcamp.ts` file (677 lines) is included above in the "Current Code" section.

---

## Data Integrity Investigation Results

### Why do products have wrong album art/URLs?

**The mapping data is correct.** For every product checked, the `raw_api_data`, `bandcamp_album_title`, and `bandcamp_url` on the mapping row match what Bandcamp's API returns for that SKU. The Bandcamp API data is trustworthy.

**The product titles are wrong.** Titles were set at product creation time using `assembleBandcampTitle(labelName, _, itemTitle)` which produces wrong titles. The mapping was later upserted with correct Bandcamp data, but the product title was never updated to match.

**The images follow the mapping.** Images were scraped from the mapping's `bandcamp_url` (which is correct per the API). So the images ARE for the right Bandcamp release — but the product TITLE refers to a different release.

**Fixing the titles will align everything.** When we rebuild titles from the mapping data (`{artist} - {album} {format}`), the title will match the images and URL because they all come from the same Bandcamp item.

### Verification: raw_api_data matches stored data

Checked 1,000 mappings with `raw_api_data` present:
- **1,000 matches, 0 mismatches** — stored `bandcamp_album_title` matches `raw_api_data.album_title` in every case
- No duplicate `bandcamp_item_id` values across mappings

### Scope of misalignment

| Category | Count | Description |
|----------|-------|-------------|
| Title matches album | 782 | Product title contains the Bandcamp album name |
| Title mismatches album | 434 | Product title refers to a different album than its mapping |
| No album (merch) | 197 | Mapping has no album title (shirts, stickers, etc.) |

---

## Triple-Check Findings (April 10, 2026)

### FINDING 1: Shopify sync will OVERWRITE corrected titles

**CRITICAL.** `shopify-sync.ts` line 195 always upserts `title: product.title` from Shopify with no authority guard. If we correct a product title in the DB but the Shopify store still has the old title, the next 15-minute sync cycle will revert it.

**Impact:** For the ~494 Bandcamp-only products (no `shopify_product_id`), this is not an issue — Shopify sync skips them. For the ~919 products that exist in BOTH Shopify and Bandcamp, the sync will overwrite our correction.

**Solution options:**
- **Option A:** Also update the title in Shopify when correcting the DB title (use `productUpdate` API like `updateProduct` does in `catalog.ts` line 409)
- **Option B:** Only correct titles for Bandcamp-only products (no `shopify_product_id`). Leave Shopify-origin titles as-is and correct them in Shopify directly.
- **Option C:** Add an authority guard to `shopify-sync.ts` upsert — don't overwrite `title` if `authority_status = 'warehouse_reviewed'`

**Recommended:** Option B for immediate fix. Option C as a future enhancement.

### FINDING 2: artistName change affects auto-generated SKUs

`artistName` is used in TWO places (line 1148 for `generateSku` and line 1176 for `assembleBandcampTitle`). The `generateSku` function uses `slugify(artistName).slice(0, 6)` as the first part of auto-generated SKUs.

Changing the artist resolution from label name to member band name will change future auto-generated SKUs. Example: `LEAVIN` → `LIONMI` for a Lionmilk product.

**Impact:** Only affects NEW products that have no SKU and are unmatched. Existing SKUs are never regenerated. This is actually **desirable** — auto-generated SKUs should use the real artist name.

### FINDING 3: Title parsing depends on `" - "` format

Two code paths parse product titles by splitting on `" - "`:

1. `extractAlbumTitle` in `bandcamp-scraper.ts` (line 97) — splits on `" - "` to extract album name for URL construction
2. `src/actions/bandcamp.ts` (line 346-349) — drops the first segment (artist) to build Bandcamp URLs

Both assume `{Artist} - {Rest}` format. The proposed new format `{Artist} - {Album} {Format}` is compatible — the artist is still the first segment before ` - `. The album+format is the rest. This is actually MORE correct for URL construction since `extractAlbumTitle` will now get the real album name instead of the old wrong title.

**Impact:** No breaking change. The title parsing is format-compatible.

### FINDING 4: authority_status is only `bandcamp_initial` in practice

Searched all TypeScript — only `"bandcamp_initial"` is ever written. The `warehouse_reviewed` and `warehouse_locked` states exist in the schema but are never set by code. This means the title correction can safely proceed without checking authority_status — all mappings are `bandcamp_initial`.

### FINDING 5: Function signature change is safe

`assembleBandcampTitle` has exactly ONE production caller (`bandcamp-sync.ts:1176`) and FIVE test calls (`bandcamp.test.ts`). Adding the optional `formatType` parameter is backward-compatible. No other file constructs product titles via this function.

---

## Revised Scope Based on Findings + Reviewer Feedback

### Step 0: Add authority guard to `shopify-sync.ts`

Prevent Shopify sync from overwriting titles that have been corrected. Without this, the next 15-minute sync cycle will revert corrected titles for products in both systems.

**File:** `src/trigger/tasks/shopify-sync.ts` line ~195

The upsert currently always writes `title: product.title` from Shopify. Add a guard: if a product's mapping has `authority_status` other than `bandcamp_initial`, or if the title has been manually corrected (future: `warehouse_reviewed`), skip the title field in the upsert.

**Proposed approach:** Add a new `authority_status` value check. Since all mappings are currently `bandcamp_initial`, introduce a new convention: after the title correction script runs, set `authority_status = 'warehouse_reviewed'` on corrected mappings. Then `shopify-sync.ts` skips `title` for those products:

```typescript
// In upsertProductsBulk, before building the upsert payload:
// Check if this product has a Bandcamp mapping with warehouse authority
const { data: bcMapping } = await supabase
  .from("bandcamp_product_mappings")
  .select("authority_status")
  .eq("variant_id", variantId)
  .maybeSingle();

const shopifyOwnsTitle = !bcMapping || bcMapping.authority_status === "bandcamp_initial";

const upsertPayload = {
  workspace_id: workspaceId,
  shopify_product_id: product.id,
  ...(shopifyOwnsTitle && { title: product.title }),
  vendor: product.vendor,
  // ... rest unchanged
};
```

**Note:** This adds one query per product in the sync loop. For performance, batch-fetch all authority_status values before the loop.

### Full fix scope (all 1,299 products)

The title correction script will:
1. Fix DB titles for all 1,299 incorrectly-titled products
2. For products with `shopify_product_id`, also update the title in Shopify via the `productUpdate` GraphQL mutation
3. Set `authority_status = 'warehouse_reviewed'` on corrected mappings so `shopify-sync` doesn't revert them
4. Log all changes to `channel_sync_log`

### Format normalization + deduplication (reviewer findings 1 + 2)

**Format normalization is required.** The `bandcamp_type_name` field has 60+ distinct values including inconsistent variants like "12 inch Vinyl", "CASSETTE", "12\" Vinyl", "Limited Edition Cassette", and even product titles mistakenly stored as types ("Cale Brandley with Triptych Myth: Finding Fire CD"). The top 3 standard values cover 75% of items (Vinyl LP: 393, Cassette: 211, Compact Disc: 144).

Add a normalizer before passing to `assembleBandcampTitle`:

```typescript
function normalizeFormat(itemType: string | null | undefined): string | null {
  if (!itemType) return null;
  const t = itemType.toLowerCase().trim();
  if (t.includes("vinyl") || t === "lp" || t.includes("2xlp")) return "LP";
  if (t.includes("cassette") || t === "tape" || t.includes("ltd. cassette")) return "Cassette";
  if (t.includes("cd") || t.includes("compact disc") || t.includes("digipak")) return "CD";
  if (t.includes("7\"") || t.includes("7-inch")) return '7"';
  if (t.includes("shirt") || t.includes("apparel") || t.includes("hoodie")) return null;
  if (t.includes("poster") || t.includes("bag") || t.includes("hat") || t.includes("zine")) return null;
  return null;
}
```

Non-music formats (shirts, bags, posters) return `null` — merch items don't get a format suffix in the title.

**Deduplication** handles cases where `merchItem.title` equals `merchItem.item_type`:

```typescript
if (albumTitle?.trim()) {
  const album = albumTitle.trim();
  const format = normalizeFormat(formatType);
  const needsFormat = format && !album.includes(format) && itemTitle !== format;
  return needsFormat ? `${artist} - ${album} ${format}` : `${artist} - ${album}`;
}
```

### Variant titles must NOT be changed (reviewer finding)

The correction script must only update `warehouse_products.title` (the product title). Variant titles (`warehouse_product_variants.title`) like "Black Vinyl" or "Default Title" must be left unchanged — they describe the specific variant, not the overall product.

### Image ordering must be preserved (reviewer finding)

If the script updates images or alt text, it must:
- Only touch position 0 (primary image) if needed
- Preserve all other image positions
- Ensure alt text stays under 255 characters (Shopify limit)

### Verified non-issues (from data audit)

| Reviewer concern | Finding | Action |
|------------------|---------|--------|
| Multiple mappings per variant | 0 duplicates found | No action needed |
| Unicode normalization | 0 mismatches in 1,000 titles | No action needed |
| Stale member_bands_cache | Cache refreshed every sync cycle (line 837) | Low risk, refresh for 72 unresolvable |

### Unresolvable artists (72 items) — fallback strategy

For the 72 mappings where `member_band_id` is not in any connection's `member_bands_cache`:
1. First, refresh the cache by calling `getMyBands()` for the relevant connections
2. If still unresolvable after refresh, use the label name as artist (current behavior) and export to CSV for manual review
3. Do NOT use subdomain as display name — it's a URL slug, not display-quality

---

## Rollback Plan

- Title changes logged to `channel_sync_log` with `sync_type = 'title_correction'` and `metadata = { old_title, new_title, product_id }`
- To rollback: query the log and restore old titles
- Code changes are forward-only for new products — reverting `assembleBandcampTitle` reverts future behavior without affecting already-corrected titles
- For Shopify-synced products: if titles were also updated in Shopify, rollback requires API calls to both DB and Shopify. The script logs `shopify_product_id` in `channel_sync_log` metadata for each corrected product.

---

## Review Integration Log

### Accepted from first reviewer

| Finding | Integration |
|---------|-------------|
| **CRIT-2: Shopify sync authority guard needed** | Added as Step 0. `shopify-sync.ts` will check `authority_status` before overwriting title. Corrected mappings set to `warehouse_reviewed`. |
| **HIGH-1: Format deduplication** | Added `needsFormat` check: skips format if itemTitle equals formatType or album already contains format string. |
| **HIGH-1: Additional test cases** | Added 3 new tests: null format, dedup when itemTitle === formatType, dedup when album contains format. |
| **HIGH-2: Script architecture** | Accepted: batch processing, continue-on-error, CSV dry-run output, Shopify rate limiting. |
| **HIGH-3: Unresolvable artists fallback** | Added 3-step strategy: refresh cache, fallback to label name, export unknowns to CSV. |
| **Cleaner code refactor** | Replaced `parts.join(" ")` pattern with template literals for clarity. |
| **Shopify rollback procedure** | Added `shopify_product_id` logging for API rollback. |
| **Post-fix monitoring** | Accepted as recommendation. |

### Accepted from second reviewer

| Finding | Integration |
|---------|-------------|
| **Format normalization** | Added `normalizeFormat()` helper. Verified: 60+ distinct `bandcamp_type_name` values in production. Top 3 standard values cover 75% but long tail is very inconsistent. Non-music formats (shirts, bags) return null. |
| **Variant titles must not change** | Added explicit constraint: script updates `warehouse_products.title` only, not `warehouse_product_variants.title`. |
| **Image position safety** | Added constraint: only touch position 0, preserve ordering. |
| **Idempotency** | Script will set `authority_status = 'warehouse_reviewed'` after correction. On re-run, it skips products already at `warehouse_reviewed` — provides natural idempotency. |
| **Shopify-native product safety** | Script skips products where `shopify_product_id` was set by Shopify sync (not by Bandcamp auto-create). Determined by: if variant has no `bandcamp_product_mappings` row, it's Shopify-native and untouched. |

### Accepted from reviews 3 and 4

| Finding | Integration |
|---------|-------------|
| **Shopify rate limiting** | Script must throttle Shopify `productUpdate` calls to 2-4 per second. Add `await sleep(300)` between calls to stay under the leaky bucket limit. |
| **Alt text update** | Correction script should update `warehouse_product_images.alt` for position 0 to match the corrected title. Current alt text uses the corrupted "Label - Artist" format. Keep under 255 chars. |
| **Batch-fetch authority status in shopify-sync** | The authority guard in `shopify-sync.ts` must NOT query `bandcamp_product_mappings` per-product inside the loop. Pre-fetch all `{ variant_id, authority_status }` for the workspace before the loop and use a Map lookup. |
| **72 unresolvable generated dynamically** | The script generates the unresolvable list during dry-run — no pre-existing list needed. |

### Verified non-issues (from data audit)

| Reviewer concern | Finding | Action |
|------------------|---------|--------|
| Multiple mappings per variant | 0 duplicates in production | Not needed |
| Unicode normalization | 0 mismatches in 1,000 titles | Not needed |
| Album title contains format suffix | Handled by `needsFormat` dedup check | Already covered |

### Not accepted

| Finding | Reason |
|---------|--------|
| **Product title history table** | Over-engineering for this fix. `channel_sync_log` provides sufficient audit trail with old/new titles in metadata. |
| **Authority guard on all fields** | Only guarding `title` for now. Extending to `vendor`, `tags`, etc. is a separate scope. |

---

## Execution Order (Final)

| Step | Task | Time Est. |
|------|------|-----------|
| 0 | Add authority guard to `shopify-sync.ts` | 30 min |
| 1 | Fix `assembleBandcampTitle()` with format dedup | 15 min |
| 2 | Fix artist resolution in `bandcamp-sync.ts` | 15 min |
| 3 | Update tests (9 test cases) | 20 min |
| 4 | `pnpm typecheck && pnpm test && pnpm release:gate` | 5 min |
| 5 | Write `scripts/fix-product-titles.ts` with dry-run + Shopify API + authority_status update | 2 hours |
| 6 | Dry-run, review 20 sample outputs | 30 min |
| 7 | Apply: fix all 1,299 products (DB + Shopify + set authority_status) | 1 hour |
| 8 | Spot-check 10 titles on Bandcamp pages + 5 in Shopify admin | 20 min |

**Total: ~5 hours**
