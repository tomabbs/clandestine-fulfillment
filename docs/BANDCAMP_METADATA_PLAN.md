# Bandcamp About / Credits / UPC — Implementation Plan

**Status:** Reviewed — ready to execute  
**Last updated:** 2026-03-31  
**Effort:** 2–3 hours | 4 files touched | 6 tasks  

Full dev handoff with research, current-state reference, and negative tests:
[`docs/BANDCAMP_METADATA_FIELDS_PLAN.md`](./BANDCAMP_METADATA_FIELDS_PLAN.md)

---

## Scope

Extend the existing Bandcamp album page scraper to capture three fields from
`data-tralbum.current` (confirmed present via live test on
`horselords.bandcamp.com`). These fields are **not** in the Bandcamp merch API —
they are only available by scraping the album page, which the system already does.

| Field | `data-tralbum.current` key | Written to |
|-------|---------------------------|------------|
| Album description | `about` | `bandcamp_product_mappings.bandcamp_about` (raw) + `warehouse_products.description_html` (if currently null) |
| Recording credits | `credits` | `bandcamp_product_mappings.bandcamp_credits` |
| UPC / EAN | `upc` | `warehouse_products.bandcamp_upc` (set-once, not overwritten) |

**Design notes:**
- `description_html` is only written when the column is currently `NULL` or `''` — staff edits are preserved via DB-side WHERE guard (no pre-SELECT needed).
- `bandcamp_upc` is album-level (digital release UPC). Kept separate from `warehouse_product_variants.barcode` (physical format barcode, often different).
- `bandcamp_credits` is captured now (zero extra cost per scrape call); display on admin catalog detail + client portal product page is a follow-up PR.

---

## Files Changed

### 1. Migration (NEW)
**`supabase/migrations/20260331000001_bandcamp_metadata_fields.sql`**

```sql
ALTER TABLE warehouse_products
  ADD COLUMN IF NOT EXISTS description_html text,
  ADD COLUMN IF NOT EXISTS bandcamp_upc     text;

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_about   text,
  ADD COLUMN IF NOT EXISTS bandcamp_credits text;
```

All four use `IF NOT EXISTS` — safe to re-run. `description_html` may already
exist in the live DB (referenced in `src/actions/catalog.ts` but absent from
tracked migrations).

---

### 2. `src/lib/clients/bandcamp-scraper.ts` (PATCH — 3 spots)

**2a. Extend `tralbumDataSchema` `current` object (lines 60–66)**

```typescript
// BEFORE
current: z.object({
  title:        z.string().nullish(),
  release_date: z.string().nullish(),
  art_id:       z.number().nullish(),
}).nullish(),

// AFTER
current: z.object({
  title:        z.string().nullish(),
  release_date: z.string().nullish(),
  art_id:       z.number().nullish(),
  about:        z.string().nullish(),   // NEW
  credits:      z.string().nullish(),   // NEW
  upc:          z.string().nullish(),   // NEW
}).nullish(),
```

**2b. Extend `ScrapedAlbumData` interface (lines 103–111)**

```typescript
export interface ScrapedAlbumData {
  releaseDate: Date | null;
  isPreorder: boolean;
  artId: number | null;
  albumArtUrl: string | null;
  title: string | null;
  packages: ScrapedPackage[];
  metadataIncomplete: boolean;
  about: string | null;    // NEW — data-tralbum.current.about
  credits: string | null;  // NEW — data-tralbum.current.credits
  upc: string | null;      // NEW — data-tralbum.current.upc
}
```

**2c. Populate in `parseBandcampPage` return + legacy shim (lines 209–244)**

```typescript
// Add to parseBandcampPage return object:
about:   data.current?.about?.trim()   ?? null,
credits: data.current?.credits?.trim() ?? null,
upc:     data.current?.upc?.trim()     ?? null,

// Add to parseTralbumData fallback base object:
about: null, credits: null, upc: null,
```

---

### 3. `src/trigger/tasks/bandcamp-sync.ts` (PATCH — 3 spots)

**3a. Mapping update block — add two fields (line ~102)**

```typescript
// Add inside the existing .update({}) call:
bandcamp_about:   scraped.about,
bandcamp_credits: scraped.credits,
```

**3b. Product-level write after `storeScrapedImages()` (after line ~173)**

`variant.product_id` is already available from the existing SELECT at line ~131
(`.select("id, street_date, is_preorder, product_id, title")`). No extra lookup
needed.

Uses DB-side WHERE guards — no preliminary SELECT round-trip required:

```typescript
if (variant.product_id) {
  if (scraped.upc) {
    await supabase
      .from("warehouse_products")
      .update({ bandcamp_upc: scraped.upc, updated_at: new Date().toISOString() })
      .eq("id", variant.product_id)
      .is("bandcamp_upc", null);                             // set-once guard
  }
  if (scraped.about) {
    await supabase
      .from("warehouse_products")
      .update({ description_html: scraped.about, updated_at: new Date().toISOString() })
      .eq("id", variant.product_id)
      .or("description_html.is.null,description_html.eq."); // null or empty guard
  }
}
```

**3c. `triggerScrapeIfNeeded` — extend SELECT + condition (lines 432–441)**

The existing SELECT explicitly names columns — `bandcamp_about` must be added or
it will be undefined even after migration:

```typescript
// BEFORE
.select("id, bandcamp_url, bandcamp_type_name")

// AFTER
.select("id, bandcamp_url, bandcamp_type_name, bandcamp_art_url, bandcamp_about")
```

```typescript
// BEFORE
const needsScrape = !mapping.bandcamp_url || !mapping.bandcamp_type_name;

// AFTER — adds backfill condition for 45 already-scraped products
// TODO: once backfill confirmed complete (step 6 query returns 0), simplify to:
//   !mapping.bandcamp_type_name || !mapping.bandcamp_about
const needsScrape =
  !mapping.bandcamp_url ||
  !mapping.bandcamp_type_name ||
  (mapping.bandcamp_art_url && !mapping.bandcamp_about);
```

**3d. End-of-sync sweep — add Group 3 (after line ~1025)**

```typescript
// Group 3: scraped before about/credits/upc were added — re-queue for backfill
const { data: scrapedNoAbout } = await supabase
  .from("bandcamp_product_mappings")
  .select("id, bandcamp_url")
  .eq("workspace_id", workspaceId)
  .not("bandcamp_art_url", "is", null)
  .is("bandcamp_about", null)
  .not("bandcamp_url", "is", null)
  .limit(50);

if (scrapedNoAbout?.length) {
  logger.info(`Sweep group 3: ${scrapedNoAbout.length} mappings missing about/credits/upc`);
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

---

### 4. `tests/unit/lib/clients/bandcamp-scraper.test.ts` (PATCH — 3 new cases)

Add a new `describe` block to the existing suite:

```typescript
describe("parseBandcampPage — about/credits/upc", () => {
  it("extracts about, credits, and upc from data-tralbum.current", () => {
    const tralbumJson = JSON.stringify({
      art_id: 12345678,
      current: {
        title: "Test Album",
        release_date: "01 Jan 2025 00:00:00 GMT",
        art_id: 12345678,
        about:   "An incredible debut album.",
        credits: "Recorded by Jane Smith at Studio A.",
        upc:     "703610875463",
      },
      packages: [{
        type_name: "Vinyl LP", type_id: 15, title: "Standard Black LP",
        sku: "LP-TST-001", release_date: "01 Jan 2025 00:00:00 GMT",
        new_date: null, image_id: null, arts: [{ image_id: 87654321 }],
      }],
    });
    const encoded = tralbumJson.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const html = `<html><body data-tralbum="${encoded}"></body></html>`;
    const result = parseBandcampPage(html);
    expect(result!.about).toBe("An incredible debut album.");
    expect(result!.credits).toBe("Recorded by Jane Smith at Studio A.");
    expect(result!.upc).toBe("703610875463");
  });

  it("returns null for about/credits/upc when absent", () => {
    const encoded = JSON.stringify({ art_id: 1, current: { title: "Min" }, packages: [] })
      .replace(/"/g, "&quot;");
    const result = parseBandcampPage(`<html><body data-tralbum="${encoded}"></body></html>`);
    expect(result!.about).toBeNull();
    expect(result!.credits).toBeNull();
    expect(result!.upc).toBeNull();
  });

  it("trims whitespace from about, credits, and upc", () => {
    const encoded = JSON.stringify({
      art_id: 1,
      current: {
        about:   "\n\nDescription with leading newlines.\n",
        credits: "\nRecorded by someone.\n\n",
        upc:     " 634457226203 ",
      },
      packages: [],
    }).replace(/"/g, "&quot;");
    const result = parseBandcampPage(`<html><body data-tralbum="${encoded}"></body></html>`);
    expect(result!.about).toBe("Description with leading newlines.");
    expect(result!.credits).toBe("Recorded by someone.");
    expect(result!.upc).toBe("634457226203");
  });
});
```

---

## Task Order

| # | Task | File |
|---|------|------|
| 1 | Run migration | `supabase/migrations/20260331000001_bandcamp_metadata_fields.sql` |
| 2 | Patch Zod schema + interface + return | `src/lib/clients/bandcamp-scraper.ts` |
| 3 | Patch mapping update + product write + guard + sweep | `src/trigger/tasks/bandcamp-sync.ts` |
| 4 | Add unit tests | `tests/unit/lib/clients/bandcamp-scraper.test.ts` |
| 5 | `npx tsc --noEmit` + `pnpm test` | — |
| 6 | Deploy + trigger one `bandcamp-sync` run | — |

---

## Verification

```sql
-- 1. Confirm columns exist
SELECT column_name FROM information_schema.columns
WHERE table_name = 'warehouse_products'
AND column_name IN ('description_html', 'bandcamp_upc');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'bandcamp_product_mappings'
AND column_name IN ('bandcamp_about', 'bandcamp_credits');

-- 2. Confirm data populated after sync
SELECT bandcamp_about, bandcamp_credits
FROM bandcamp_product_mappings
WHERE bandcamp_about IS NOT NULL LIMIT 5;

SELECT description_html, bandcamp_upc
FROM warehouse_products
WHERE bandcamp_upc IS NOT NULL LIMIT 5;

-- 3. NEGATIVE TEST — run before backfill sync
UPDATE warehouse_products
SET description_html = 'STAFF EDIT - DO NOT OVERWRITE'
WHERE id = (
  SELECT p.id FROM warehouse_products p
  JOIN warehouse_product_variants v ON v.product_id = p.id
  JOIN bandcamp_product_mappings m ON m.variant_id = v.id
  WHERE m.bandcamp_art_url IS NOT NULL LIMIT 1
);
-- After sync: must still be 'STAFF EDIT - DO NOT OVERWRITE'
SELECT description_html FROM warehouse_products
WHERE description_html = 'STAFF EDIT - DO NOT OVERWRITE';
-- Clean up after confirming:
UPDATE warehouse_products SET description_html = NULL
WHERE description_html = 'STAFF EDIT - DO NOT OVERWRITE';

-- 4. Confirm backfill complete (run after sync — should return 0)
SELECT COUNT(*) FROM bandcamp_product_mappings
WHERE bandcamp_art_url IS NOT NULL AND bandcamp_about IS NULL;
-- When 0: remove the (bandcamp_art_url && !bandcamp_about) TODO condition
```

---

## Risk & Rollback

| Risk | Mitigation |
|------|------------|
| `description_html` already in live DB | `ADD COLUMN IF NOT EXISTS` — safe no-op |
| Staff edits overwritten | DB-side `.or("description_html.is.null,description_html.eq.")` WHERE guard |
| UPC mismatch (digital ≠ physical) | Stored as `bandcamp_upc`, separate from `barcode` on variants |
| Idempotency guard complexity | `// TODO` comment with simplification path; step 4 query confirms when done |

**Rollback:**
```sql
ALTER TABLE warehouse_products DROP COLUMN IF EXISTS bandcamp_upc;
-- Keep description_html — already referenced in src/actions/catalog.ts
ALTER TABLE bandcamp_product_mappings
  DROP COLUMN IF EXISTS bandcamp_about,
  DROP COLUMN IF EXISTS bandcamp_credits;
```

---

## Doc Sync (after execution)

- `docs/system_map/TRIGGER_TASK_CATALOG.md` — update `bandcamp-scrape-page` to mention about/credits/upc
- `TRUTH_LAYER.md` — note `description_html` and `bandcamp_upc` on `warehouse_products`
