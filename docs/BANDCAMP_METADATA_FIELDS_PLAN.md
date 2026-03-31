# Bandcamp Metadata Fields — Implementation Plan & Dev Review Handoff

**Feature:** Scrape `about` (description), `credits`, and `upc` from Bandcamp album pages  
**Status:** Reviewed — ready to execute  
**Ticket scope:** 6 tasks — 1 migration, 2 file patches, 1 sweep extension, 1 test addition, 1 deploy  
**Estimated effort:** 2–3 hours  

### Review Response (2026-03-31)

Dev review complete. Changes incorporated from feedback:

| Issue | Severity | Resolution |
|-------|----------|------------|
| `productId` source unclear | Medium | Clarified: comes from `variant.product_id` in existing SELECT (line 131). No extra lookup needed. |
| Two DB calls for `description_html` check | Low | Replaced with single conditional UPDATE using Supabase `.or()` filter |
| Idempotency guard complexity | Low | Added inline `// TODO` comment; simplification path documented |
| `bandcamp_about` missing from SELECT in guard | Medium | Confirmed explicitly in section 6c — now called out clearly |
| Credits field use case unclear | Low | Clarified: displayed on admin catalog detail + client portal product page (future PR) |
| Missing negative test for staff edits | Low | Added to verification checklist (section 10) |

---

## Table of Contents

1. [Research Findings](#1-research-findings)
2. [What We're Adding](#2-what-were-adding)
3. [Data Flow Diagram](#3-data-flow-diagram)
4. [File 1 — Migration (NEW)](#4-file-1--migration-new)
5. [File 2 — bandcamp-scraper.ts (PATCH)](#5-file-2--bandcamp-scraperts-patch)
6. [File 3 — bandcamp-sync.ts (PATCH)](#6-file-3--bandcamp-syncts-patch)
7. [File 4 — Unit Tests (PATCH)](#7-file-4--unit-tests-patch)
8. [Current State Reference](#8-current-state-reference)
9. [Risk & Rollback](#9-risk--rollback)
10. [Verification Checklist](#10-verification-checklist)
11. [Doc Sync Contract](#11-doc-sync-contract)

---

## 1. Research Findings

### 1.1 Bandcamp Merch API — does it have these fields?

**NO.** The Bandcamp merch API (`get_merch_details` endpoint) only returns:

```typescript
// src/lib/clients/bandcamp.ts — BandcampMerchItem
{
  package_id, title, album_title, sku, item_type,
  member_band_id, new_date, price, currency,
  quantity_available, quantity_sold, origin_quantity,
  url, image_url
}
```

`about`, `credits`, and `upc` are **not** in the API response.

### 1.2 Album Page — `data-tralbum.current` keys (live test)

Live test on `horselords.bandcamp.com/album/interventions` (March 31, 2026):

```
Status: 200 | HTML length: 348,029 bytes

data-tralbum.current keys:
about, art_id, artist, audit, auto_repriced, band_id, credits,
download_desc_id, download_pref, featured_track_id, id, is_set_price,
killed, minimum_price, minimum_price_nonzero, mod_date, new_date,
new_desc_format, private, publish_date, purchase_title, purchase_url,
release_date, require_email, require_email_0, selling_band_id, set_price,
title, type, upc
```

**Fields confirmed:**
- `current.about` → "horselords.info\n\nWest African rhythms collide with just intonation guitars..." (full album description)
- `current.credits` → "Sam Haberman\nMax Eilbacher\nOwen Gardner\nAndrew Bernstein\n\nrecorded by Horse Lords and Chris Freeland\n\nmixed by Horse Lords\n\nmastered by Sarah..."
- `current.upc` → `"703610875463"` (album UPC/EAN, string)

The screenshots provided by the user (The Necks - Disquiet) also confirm:
- `about`: full album description block visible on album page
- `credits`: "Composer: Abrahams/Buck/Swanton (control)\nRecorded by Tim Whitten..."
- `upc`: `634457226203`

### 1.3 Current scraper state

The current `tralbumDataSchema` only parses:
- `art_id`, `is_preorder`, `album_is_preorder`
- `current.title`, `current.release_date`, `current.art_id`
- `packages[]` (type_name, sku, images, etc.)

The `current.about`, `current.credits`, and `current.upc` keys **exist in the live JSON** but are dropped by the Zod parser today.

### 1.4 Database state

`warehouse_products` migration (`20260316000002_products.sql`) has:
```sql
CREATE TABLE warehouse_products (
  id uuid, workspace_id uuid, org_id uuid,
  shopify_product_id text, title text, vendor text,
  product_type text, status text, tags text[],
  shopify_handle text, images jsonb,
  created_at timestamptz, updated_at timestamptz, synced_at timestamptz
  -- NO description_html, NO bandcamp_upc
);
```

However, `src/actions/catalog.ts` line ~594 already selects `description_html`:
```typescript
.select(`id, title, vendor, product_type, tags, status, description_html, ...`)
```
This means either: (a) the column was added via Supabase dashboard without a migration, or (b) the query silently fails. Either way, we must add it via migration with `IF NOT EXISTS`.

`bandcamp_product_mappings` currently has Bandcamp-specific columns:
`bandcamp_url`, `bandcamp_url_source`, `bandcamp_type_name`, `bandcamp_new_date`, `bandcamp_release_date`, `bandcamp_is_preorder`, `bandcamp_art_url` — but no `bandcamp_about` or `bandcamp_credits`.

### 1.5 Idempotency guard (current)

In `triggerScrapeIfNeeded` (line 440 of `bandcamp-sync.ts`):
```typescript
const needsScrape = !mapping.bandcamp_url || !mapping.bandcamp_type_name;
if (!needsScrape) return;
```

This means **45 already-scraped products** (those with `bandcamp_art_url` already set) will NOT be re-scraped unless we extend the condition. They were scraped before these new fields existed.

The end-of-sync sweep (lines 926–955) also only queues items where `bandcamp_type_name IS NULL`.

---

## 2. What We're Adding

| Field | Source | Stored in | Condition |
|-------|--------|-----------|-----------|
| `current.about` | `data-tralbum` | `bandcamp_product_mappings.bandcamp_about` (raw) + `warehouse_products.description_html` (if currently null) | Never overwrites staff edits |
| `current.credits` | `data-tralbum` | `bandcamp_product_mappings.bandcamp_credits` | Always updated from Bandcamp |
| `current.upc` | `data-tralbum` | `warehouse_products.bandcamp_upc` | Set once, not overwritten |

**Design decisions:**
- `about` → two columns: raw in mappings (Bandcamp source of truth), display copy in `warehouse_products.description_html` (editable by staff, only written via single conditional UPDATE when currently null/empty — no separate SELECT needed)
- `credits` → mappings only for now; planned display on admin catalog detail page and client portal product page in a follow-up PR. Zero-cost to capture during the same scrape call; deferred display avoids scope creep.
- `upc` → product-level (album UPC is per-album, not per-format variant); stored as `bandcamp_upc` (separate from `warehouse_product_variants.barcode` which is the physical format barcode, often different)

---

## 3. Data Flow Diagram

```
bandcamp-sync (cron)
    │
    ├── getMerchDetails API → items with url/album_title
    │
    ├── triggerScrapeIfNeeded() per matched variant
    │       │  Condition: !bandcamp_url || !bandcamp_type_name
    │       │  NEW:  || (bandcamp_art_url && !bandcamp_about)   ← backfill trigger
    │       └── bandcampScrapePageTask.trigger({url, mappingId})
    │
    └── End-of-sync sweep
            ├── Group 1: has URL, no type_name → trigger scrape
            ├── Group 2: no URL, no type_name → construct URL, trigger scrape
            └── NEW Group 3: has art_url (scraped), no about → trigger re-scrape (limit 50/run)

bandcamp-scrape-page task
    │
    ├── fetchBandcampPage(url) → HTML
    ├── parseBandcampPage(html) → ScrapedAlbumData
    │       └── NEW: includes .about, .credits, .upc
    │
    ├── UPDATE bandcamp_product_mappings SET
    │       bandcamp_type_name, bandcamp_release_date, bandcamp_art_url,
    │       NEW: bandcamp_about, bandcamp_credits
    │
    ├── UPDATE warehouse_product_variants (street_date, is_preorder if empty)
    │
    ├── storeScrapedImages() → warehouse_product_images + products.images
    │
    └── UPDATE warehouse_products SET (if columns are null)
            NEW: description_html ← about (only if currently null)
            NEW: bandcamp_upc ← upc (only if currently null)
```

---

## 4. File 1 — Migration (NEW)

**Path:** `supabase/migrations/20260331000001_bandcamp_metadata_fields.sql`

```sql
-- ============================================================
-- Bandcamp metadata fields: about, credits, UPC
-- 2026-03-31
--
-- warehouse_products:
--   description_html  — editable product description; populated from
--                        Bandcamp "about" text only when currently NULL.
--                        Staff can override and the scraper will not
--                        overwrite.
--   bandcamp_upc      — album-level UPC/EAN from data-tralbum.current.upc.
--                        Stored separately from warehouse_product_variants.barcode
--                        (which is the per-format physical barcode).
--
-- bandcamp_product_mappings:
--   bandcamp_about    — raw "about" text from data-tralbum.current.about.
--                        Source of truth; always updated on re-scrape.
--   bandcamp_credits  — raw "credits" text from data-tralbum.current.credits.
-- ============================================================

ALTER TABLE warehouse_products
  ADD COLUMN IF NOT EXISTS description_html text,
  ADD COLUMN IF NOT EXISTS bandcamp_upc     text;

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_about   text,
  ADD COLUMN IF NOT EXISTS bandcamp_credits text;
```

**Notes:**
- All four columns use `IF NOT EXISTS` — safe to re-run
- `description_html` uses `IF NOT EXISTS` because `src/actions/catalog.ts` already references it (may exist in live DB from a manual dashboard add)
- No indexes needed at this scale

---

## 5. File 2 — bandcamp-scraper.ts (PATCH)

**Path:** `src/lib/clients/bandcamp-scraper.ts`

### 5a. Extend `tralbumDataSchema` — `current` object

**Current (lines 60–66):**
```typescript
current: z
  .object({
    title:        z.string().nullish(),
    release_date: z.string().nullish(),
    art_id:       z.number().nullish(),
  })
  .nullish(),
```

**After patch:**
```typescript
current: z
  .object({
    title:        z.string().nullish(),
    release_date: z.string().nullish(),
    art_id:       z.number().nullish(),
    // NEW — album description, recording credits, UPC/EAN
    about:        z.string().nullish(),
    credits:      z.string().nullish(),
    upc:          z.string().nullish(),
  })
  .nullish(),
```

### 5b. Extend `ScrapedAlbumData` interface

**Current (lines 103–111):**
```typescript
export interface ScrapedAlbumData {
  releaseDate: Date | null;
  isPreorder: boolean;
  artId: number | null;
  albumArtUrl: string | null;
  title: string | null;
  packages: ScrapedPackage[];
  metadataIncomplete: boolean;
}
```

**After patch:**
```typescript
export interface ScrapedAlbumData {
  releaseDate: Date | null;
  isPreorder: boolean;
  artId: number | null;
  albumArtUrl: string | null;
  title: string | null;
  packages: ScrapedPackage[];
  metadataIncomplete: boolean;
  // NEW
  about: string | null;    // data-tralbum.current.about — album description
  credits: string | null;  // data-tralbum.current.credits — recording credits
  upc: string | null;      // data-tralbum.current.upc — album UPC/EAN
}
```

### 5c. Populate new fields in `parseBandcampPage` return

**Current return (lines 209–218):**
```typescript
return {
  releaseDate,
  isPreorder,
  artId,
  albumArtUrl: bandcampAlbumArtUrl(artId),
  title: data.current?.title ?? null,
  packages,
  metadataIncomplete,
};
```

**After patch:**
```typescript
return {
  releaseDate,
  isPreorder,
  artId,
  albumArtUrl: bandcampAlbumArtUrl(artId),
  title: data.current?.title ?? null,
  packages,
  metadataIncomplete,
  // NEW — trim whitespace; Bandcamp often has leading/trailing newlines
  about:   data.current?.about?.trim()   ?? null,
  credits: data.current?.credits?.trim() ?? null,
  upc:     data.current?.upc?.trim()     ?? null,
};
```

Also update the `parseTralbumData` legacy compat shim (line ~234) to include the new fields:

**Current:**
```typescript
const base = result ?? {
  releaseDate: null,
  isPreorder: false,
  artId: null,
  albumArtUrl: null,
  title: null,
  packages: [],
  metadataIncomplete: true,
};
```

**After patch:**
```typescript
const base = result ?? {
  releaseDate: null,
  isPreorder: false,
  artId: null,
  albumArtUrl: null,
  title: null,
  packages: [],
  metadataIncomplete: true,
  about: null,
  credits: null,
  upc: null,
};
```

---

## 6. File 3 — bandcamp-sync.ts (PATCH)

**Path:** `src/trigger/tasks/bandcamp-sync.ts`

### 6a. Write new fields in `bandcampScrapePageTask` — mapping update

**Current mapping `.update()` block (lines 103–118):**
```typescript
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
```

**After patch — add two lines:**
```typescript
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
    // NEW
    bandcamp_about:        scraped.about,
    bandcamp_credits:      scraped.credits,
    last_synced_at:        new Date().toISOString(),
    updated_at:            new Date().toISOString(),
  })
  .eq("id", payload.mappingId);
```

### 6b. Write product-level fields after image storage

This block goes **after** the `storeScrapedImages()` call and **before** the `metadataIncomplete` check (around line 175).

**Important:** `variant.product_id` is already available here — the existing query at line ~131 already selects `product_id` on the variant:
```typescript
.select("id, street_date, is_preorder, product_id, title")
```
No extra lookup is needed.

**Single conditional UPDATE** — avoids the two-round-trip SELECT-then-UPDATE pattern. Supabase's `.or()` filter makes the description_html guard a DB-side condition:

```typescript
// Write album-level metadata to warehouse_products.
// Uses conditional WHERE clauses so no preliminary SELECT is needed:
//   - bandcamp_upc: set once (WHERE bandcamp_upc IS NULL)
//   - description_html: only if empty — preserves staff edits
//     (WHERE description_html IS NULL OR description_html = '')
if (variant.product_id) {
  if (scraped.upc) {
    await supabase
      .from("warehouse_products")
      .update({ bandcamp_upc: scraped.upc, updated_at: new Date().toISOString() })
      .eq("id", variant.product_id)
      .is("bandcamp_upc", null);  // set-once guard
  }

  if (scraped.about) {
    await supabase
      .from("warehouse_products")
      .update({ description_html: scraped.about, updated_at: new Date().toISOString() })
      .eq("id", variant.product_id)
      .or("description_html.is.null,description_html.eq.");  // null or empty-string guard
  }
}
```

Two UPDATE calls instead of SELECT + conditional UPDATE — same round-trip count but each is a no-op when the guard condition is false (Postgres skips 0-row updates cheaply).
```

**Full updated context block (lines 127–195 after patch):**
```typescript
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
      await supabase.from("warehouse_product_variants")
        .update(updates).eq("id", variant.id);
      if (updates.is_preorder === true) {
        await preorderSetupTask.trigger({
          variant_id: variant.id,
          workspace_id: payload.workspaceId,
        });
      }
    }

    // Store album art + primary merch image
    if (variant.product_id) {
      await storeScrapedImages(
        supabase, variant.product_id, payload.workspaceId,
        scraped, variant.id, variant.title,
      );
    }

    // NEW: Write album-level metadata to warehouse_products.
    // variant.product_id is already available from the SELECT above (line ~131).
    // Conditional WHERE guards prevent overwriting existing data — no pre-SELECT needed.
    if (variant.product_id) {
      if (scraped.upc) {
        await supabase
          .from("warehouse_products")
          .update({ bandcamp_upc: scraped.upc, updated_at: new Date().toISOString() })
          .eq("id", variant.product_id)
          .is("bandcamp_upc", null);
      }
      if (scraped.about) {
        await supabase
          .from("warehouse_products")
          .update({ description_html: scraped.about, updated_at: new Date().toISOString() })
          .eq("id", variant.product_id)
          .or("description_html.is.null,description_html.eq.");
      }
    }
  }
}
```

### 6c. Extend `triggerScrapeIfNeeded` idempotency guard

**Note on the SELECT:** The current query explicitly names columns, so `bandcamp_about` must be added. If the SELECT used `*` it would pick up automatically after migration — it doesn't, so this change is required.

**Current (lines 432–441):**
```typescript
const { data: mapping } = await supabase
  .from("bandcamp_product_mappings")
  .select("id, bandcamp_url, bandcamp_type_name")   // ← does not include bandcamp_about
  .eq("variant_id", variantId)
  .single();

if (!mapping) return;

const needsScrape = !mapping.bandcamp_url || !mapping.bandcamp_type_name;
if (!needsScrape) return;
```

**After patch:**
```typescript
const { data: mapping } = await supabase
  .from("bandcamp_product_mappings")
  // NEW: add bandcamp_art_url and bandcamp_about to the explicit SELECT
  .select("id, bandcamp_url, bandcamp_type_name, bandcamp_art_url, bandcamp_about")
  .eq("variant_id", variantId)
  .single();

if (!mapping) return;

// Trigger if: (a) not yet scraped at all, OR (b) scraped before about/credits/upc
// were added to the scraper (has art_url but no about text yet — backfill window).
// TODO: once backfill is confirmed complete (all 45 items have bandcamp_about set),
// simplify this condition to: !mapping.bandcamp_type_name || !mapping.bandcamp_about
const needsScrape =
  !mapping.bandcamp_url ||
  !mapping.bandcamp_type_name ||
  (mapping.bandcamp_art_url && !mapping.bandcamp_about);  // NEW: backfill condition
if (!needsScrape) return;
```

**Tech debt note:** The `bandcamp_art_url && !bandcamp_about` compound is transitional. After the backfill run completes (all 45 items re-scraped — verifiable via `SELECT COUNT(*) FROM bandcamp_product_mappings WHERE bandcamp_art_url IS NOT NULL AND bandcamp_about IS NULL`), a follow-up PR should simplify the condition to just `!mapping.bandcamp_type_name || !mapping.bandcamp_about`. This reduces future complexity when new fields are added.

### 6d. Extend end-of-sync sweep — add Group 3

Add after the existing Group 2 block (around line 1025):

```typescript
// Group 3: already scraped (has art_url) but missing about/credits/upc
// These were scraped before this feature was added — backfill on subsequent runs.
const { data: scrapedNoAbout } = await supabase
  .from("bandcamp_product_mappings")
  .select("id, bandcamp_url")
  .eq("workspace_id", workspaceId)
  .not("bandcamp_art_url", "is", null)   // already scraped
  .is("bandcamp_about", null)            // but missing about
  .not("bandcamp_url", "is", null)       // must have a URL to scrape
  .limit(50);

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
  }
}
```

**Why limit 50/run:** Matches the existing Group 1/2 pattern. All 45 already-scraped items will be re-queued within 1 sync run (they're under the 50 limit). Future items fall into the normal Groups 1/2.

---

## 7. File 4 — Unit Tests (PATCH)

**Path:** `tests/unit/lib/clients/bandcamp-scraper.test.ts`

Add a new test case to the existing suite:

```typescript
describe("parseBandcampPage — about/credits/upc", () => {
  it("extracts about, credits, and upc from data-tralbum.current", () => {
    const about   = "An incredible debut album.";
    const credits = "Recorded by Jane Smith at Studio A.";
    const upc     = "703610875463";

    const tralbumJson = JSON.stringify({
      art_id: 12345678,
      is_preorder: false,
      album_is_preorder: false,
      current: {
        title: "Test Album",
        release_date: "01 Jan 2025 00:00:00 GMT",
        art_id: 12345678,
        about,
        credits,
        upc,
      },
      packages: [{
        type_name: "Vinyl LP",
        type_id: 15,
        title: "Standard Black LP",
        sku: "LP-TST-001",
        release_date: "01 Jan 2025 00:00:00 GMT",
        new_date: null,
        image_id: null,
        arts: [{ image_id: 87654321 }],
      }],
    });

    // he-encode the JSON as Bandcamp does
    const encoded = tralbumJson
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
    const html = `<html><head></head><body data-tralbum="${encoded}"></body></html>`;

    const result = parseBandcampPage(html);

    expect(result).not.toBeNull();
    expect(result!.about).toBe(about);
    expect(result!.credits).toBe(credits);
    expect(result!.upc).toBe(upc);
  });

  it("returns null for about/credits/upc when not present in data-tralbum", () => {
    const tralbumJson = JSON.stringify({
      art_id: 12345678,
      current: { title: "Minimal Album" },
      packages: [],
    });
    const encoded = tralbumJson.replace(/"/g, "&quot;");
    const html = `<html><body data-tralbum="${encoded}"></body></html>`;

    const result = parseBandcampPage(html);
    expect(result!.about).toBeNull();
    expect(result!.credits).toBeNull();
    expect(result!.upc).toBeNull();
  });

  it("trims whitespace from about and credits", () => {
    const tralbumJson = JSON.stringify({
      art_id: 1,
      current: {
        about:   "\n\nDescription with leading newlines.\n",
        credits: "\nRecorded by someone.\n\n",
        upc:     " 634457226203 ",
      },
      packages: [],
    });
    const encoded = tralbumJson.replace(/"/g, "&quot;");
    const html = `<html><body data-tralbum="${encoded}"></body></html>`;

    const result = parseBandcampPage(html);
    expect(result!.about).toBe("Description with leading newlines.");
    expect(result!.credits).toBe("Recorded by someone.");
    expect(result!.upc).toBe("634457226203");
  });
});
```

---

## 8. Current State Reference

### 8.1 Full current `bandcamp-scraper.ts`

```typescript
// src/lib/clients/bandcamp-scraper.ts (current — before patch)
import he from "he";
import { z } from "zod";

export function buildBandcampAlbumUrl(subdomain: string, albumTitle: string): string | null {
  const trimmed = albumTitle.trim();
  if (!trimmed) return null;
  const slug = trimmed
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return null;
  return `https://${subdomain}.bandcamp.com/album/${slug}`;
}

export class BandcampFetchError extends Error {
  constructor(message: string, public readonly status: number, public readonly url: string) {
    super(message);
    this.name = "BandcampFetchError";
  }
}

const packageArtSchema = z.object({ image_id: z.number().nullish() });

const tralbumDataSchema = z.object({
  art_id:            z.number().nullish(),
  is_preorder:       z.boolean().nullish(),
  album_is_preorder: z.boolean().nullish(),
  current: z.object({
    title:        z.string().nullish(),
    release_date: z.string().nullish(),
    art_id:       z.number().nullish(),
    // MISSING: about, credits, upc
  }).nullish(),
  packages: z.array(z.object({
    type_name:    z.string().nullish(),
    type_id:      z.number().nullish(),
    title:        z.string().nullish(),
    sku:          z.string().nullish(),
    release_date: z.string().nullish(),
    new_date:     z.string().nullish(),
    image_id:     z.number().nullish(),
    arts:         z.array(packageArtSchema).nullish(),
  })).nullish(),
});

export interface ScrapedAlbumData {
  releaseDate: Date | null;
  isPreorder: boolean;
  artId: number | null;
  albumArtUrl: string | null;
  title: string | null;
  packages: ScrapedPackage[];
  metadataIncomplete: boolean;
  // MISSING: about, credits, upc
}
```

### 8.2 Current `triggerScrapeIfNeeded` idempotency check

```typescript
// bandcamp-sync.ts lines 432–441
const { data: mapping } = await supabase
  .from("bandcamp_product_mappings")
  .select("id, bandcamp_url, bandcamp_type_name")    // ← does not select bandcamp_about
  .eq("variant_id", variantId)
  .single();

if (!mapping) return;

const needsScrape = !mapping.bandcamp_url || !mapping.bandcamp_type_name;
if (!needsScrape) return;  // ← 45 already-scraped products never re-trigger
```

### 8.3 Bandcamp product mapping columns (current)

```
bandcamp_product_mappings columns:
  id, workspace_id, variant_id, bandcamp_item_id, bandcamp_item_type,
  bandcamp_member_band_id, bandcamp_type_name, bandcamp_new_date,
  bandcamp_url, last_quantity_sold, last_synced_at, created_at, updated_at,
  bandcamp_image_url, bandcamp_url_source, bandcamp_release_date,
  bandcamp_is_preorder, bandcamp_art_url
  ← MISSING: bandcamp_about, bandcamp_credits
```

---

## 9. Risk & Rollback

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `description_html` already exists in live DB | Likely | `ADD COLUMN IF NOT EXISTS` — safe no-op |
| Staff-edited descriptions overwritten | Possible | Supabase `.or("description_html.is.null,description_html.eq.")` on the UPDATE — DB-side guard, no pre-SELECT needed |
| `about` text is very long (large records) | Low | Bandcamp about text typically < 5,000 chars; `text` type is unbounded in Postgres |
| Group 3 sweep re-scrapes too aggressively | Low | Limited to 50/run, same as Groups 1/2; at 1/sec queue rate that's < 1 min/run |
| UPC is wrong (digital UPC ≠ physical format UPC) | Medium | Stored as `bandcamp_upc` (separate from variant `barcode`) — clearly labeled as Bandcamp source |
| Idempotency guard grows complex over time | Low | Tech debt TODO documented in code; simplification query provided in verification step 6 |
| `bandcamp_about` missing from explicit SELECT in guard | **Fixed** | SELECT in `triggerScrapeIfNeeded` explicitly updated to include `bandcamp_art_url, bandcamp_about` |

**Rollback steps:**
1. Revert `bandcamp-scraper.ts` and `bandcamp-sync.ts` to remove the 3 patches
2. Run: `ALTER TABLE warehouse_products DROP COLUMN IF EXISTS bandcamp_upc;` (keep `description_html` — it's already referenced in code)
3. Run: `ALTER TABLE bandcamp_product_mappings DROP COLUMN IF EXISTS bandcamp_about, DROP COLUMN IF EXISTS bandcamp_credits;`

---

## 10. Verification Checklist

After deploying:

```bash
# 1. TypeScript check
npx tsc --noEmit

# 2. Unit tests (includes new about/credits/upc and whitespace-trim cases)
pnpm test tests/unit/lib/clients/bandcamp-scraper.test.ts

# 3. Confirm migration applied
SELECT column_name FROM information_schema.columns
WHERE table_name = 'warehouse_products'
AND column_name IN ('description_html', 'bandcamp_upc');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'bandcamp_product_mappings'
AND column_name IN ('bandcamp_about', 'bandcamp_credits');

# 4. Trigger one bandcamp-sync run, then check populated data
SELECT bandcamp_about, bandcamp_credits
FROM bandcamp_product_mappings
WHERE bandcamp_about IS NOT NULL
LIMIT 5;

SELECT description_html, bandcamp_upc
FROM warehouse_products
WHERE bandcamp_upc IS NOT NULL
LIMIT 5;

# 5. NEGATIVE TEST — confirm staff edits are not overwritten
# Run BEFORE triggering the backfill sync:
UPDATE warehouse_products
SET description_html = 'STAFF EDIT - DO NOT OVERWRITE'
WHERE id = (
  SELECT p.id FROM warehouse_products p
  JOIN warehouse_product_variants v ON v.product_id = p.id
  JOIN bandcamp_product_mappings m ON m.variant_id = v.id
  WHERE m.bandcamp_art_url IS NOT NULL
  LIMIT 1
);
-- Note the product id returned, then trigger bandcamp-sync.
-- After sync completes:
SELECT description_html FROM warehouse_products
WHERE description_html = 'STAFF EDIT - DO NOT OVERWRITE';
-- Must return 1 row — if it returns 0, the guard is broken.
-- Clean up: UPDATE warehouse_products SET description_html = NULL WHERE description_html = 'STAFF EDIT - DO NOT OVERWRITE';

# 6. Confirm backfill completed for already-scraped products
# Run after sync — should return 0:
SELECT COUNT(*) FROM bandcamp_product_mappings
WHERE bandcamp_art_url IS NOT NULL
AND bandcamp_about IS NULL;
-- When this returns 0: apply the TODO simplification in triggerScrapeIfNeeded
```

---

## 11. Doc Sync Contract

The following docs need updating after implementation:

| Doc | Change needed |
|-----|---------------|
| `docs/system_map/TRIGGER_TASK_CATALOG.md` | Update `bandcamp-scrape-page` description to mention about/credits/upc extraction |
| `docs/system_map/API_CATALOG.md` | No change needed (internal task, no new routes) |
| `TRUTH_LAYER.md` | If it documents `warehouse_products` schema: note `description_html` and `bandcamp_upc` |

---

*Generated: 2026-03-31 | Based on live Bandcamp page test + full codebase audit*
