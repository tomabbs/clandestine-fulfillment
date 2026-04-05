---
name: Genre Tags + Trending
overview: "Add Bandcamp genre tags to the catalog intelligence layer. v2: tags captured from HTML scraping (primary) with optional tralbum_details enhancement. 3 genre filter dropdowns on Sales History, Trending tab via dig_deeper, deterministic alias map for BC-to-DSP matching, resumable backfill with cursor, brief server cache on Trending."
todos:
  - id: p1-migration
    content: "Phase 1: Create migration (bandcamp_tags, bandcamp_genre, raw_tralbum_data columns + indexes) and apply"
    status: completed
  - id: p1-api-client
    content: "Phase 1: Create bandcamp-discover.ts (fetchDigDeeper for trending) + add tag extraction to parseBandcampPage (HTML primary)"
    status: completed
  - id: p1-taxonomy
    content: "Phase 1: Create genre-taxonomy.ts with BC_GENRES, DSP_GENRES, SUB_GENRES constants + alias map + matchTagToTaxonomy using norm_name"
    status: completed
  - id: p1-verify
    content: "Phase 1 checkpoint: pnpm typecheck + supabase db push --yes"
    status: completed
  - id: p2-backfill
    content: "Phase 2: Create bandcamp-tag-backfill.ts task + register in index.ts"
    status: completed
  - id: p2-sync
    content: "Phase 2: Update bandcamp-sync.ts to capture tags on new/updated mappings"
    status: completed
  - id: p2-verify
    content: "Phase 2 checkpoint: Deploy to Trigger.dev, run backfill, verify tags populate"
    status: completed
  - id: p3-action
    content: "Phase 3: Extend getBandcampSalesOverview with tag data + genre matching"
    status: completed
  - id: p3-filters
    content: "Phase 3: Add 3 genre filter dropdowns + summary stats + genre column to Sales History UI"
    status: completed
  - id: p3-verify
    content: "Phase 3 checkpoint: pnpm typecheck + test, verify filters on localhost"
    status: completed
  - id: p4-trending-action
    content: "Phase 4: Create getBandcampTrending action with client-artist cross-ref"
    status: completed
  - id: p4-trending-ui
    content: "Phase 4: Build Trending tab UI with genre/sort/format selectors + card grid + client highlighting"
    status: completed
  - id: p4-verify
    content: "Phase 4 checkpoint: pnpm typecheck, test trending on localhost"
    status: completed
  - id: p5-deploy
    content: "Phase 5: Deploy (git push + trigger deploy), run backfill, update truth docs, final verification"
    status: completed
isProject: false
---

# Bandcamp Genre Tags, Sales Filters, and Trending Intelligence

# Feature
Three interconnected capabilities: (1) genre tag capture from HTML scraping (primary) with optional tralbum_details API enhancement, (2) three-tier genre filtering on Sales History with summary stats and DB-side filtering, (3) a Trending tab showing what is popular on Bandcamp by genre with client-artist highlighting and brief server cache.

# Goal
Enable genre-based sales analysis and market intelligence for the fulfillment catalog. Store 100% of available Bandcamp API data per the project's data capture policy.

# Context
Bandcamp album pages display genre tags as `<a class="tag">` HTML elements. These are the same tags visible to users on every album page. The existing HTML scraper (`parseBandcampPage`) already fetches these pages but does not extract tags -- adding tag extraction is a small patch to existing infrastructure.

Separately, `mobile/25/tralbum_details` returns structured tags with `isloc` (location vs genre flag) and `norm_name` (normalized key). However, live testing confirmed that **`tralbum_id` != `package_id`** -- our stored `bandcamp_item_id` (from merch API `package_id`) CANNOT be used to call `tralbum_details`. The album's `item_id` must be obtained from `band_details` discography or from `data-tralbum.id` during HTML scrape. Also, `data-tralbum` does NOT contain tags (confirmed via live testing).

The `hub/2/dig_deeper` endpoint returns trending albums by genre (20 per page) and is the only way to get trending data. It is undocumented but tied to Bandcamp's public Discover feature.

The user has a DSP genre taxonomy (64 genres + 692 sub-genres from a spreadsheet) that must be cross-referenced against Bandcamp tags for filtering. 18 of 23 BC genres match DSP exactly; 5 need deterministic aliases.

# Requirements

**Functional:**
- Backfill `bandcamp_tags` for all mappings with `bandcamp_url IS NOT NULL`
- Capture tags during ongoing scrape sweeps (added to `parseBandcampPage`)
- Store `tralbum_id` from `data-tralbum.id` during scrape for future `tralbum_details` calls
- Add 3 filter dropdowns to Sales History: "BC Genres" (~23), "DSP Genres" (64), "Sub Genres" (692)
- Filters pushed to SQL using GIN array operators (not JS-side filtering)
- Summary stats row updates with filters: items, units, revenue, % of total
- "Untagged" count visible in the filter area
- Trending tab: browse Bandcamp discover by genre, sort, and format
- Trending tab: highlight client artists (match by `band_id` primarily, `subdomain` secondary)
- Trending tab: brief server cache (1-5 min by {tags, sort, format, page})
- CSV export includes: `bandcamp_tags` (raw comma-separated), `bc_genre`, `dsp_genre`, `sub_genre` (4 new columns after existing ones)

**Non-functional:**
- Tag backfill uses existing scrape infrastructure (HTML fetch, not mobile API)
- Trending tab uses `dig_deeper` API with configurable rate/retry policy
- Genre taxonomy lists are static code constants with deterministic alias map
- Tag matching uses normalized keys (lowercase, stripped punctuation) with alias table for known BC-to-DSP mismatches

# Constraints

**Technical:**
- **CRITICAL ID DISTINCTION**: `bandcamp_item_id` on mappings is `package_id` (merch package). `tralbum_id` (album ID) is a DIFFERENT number. `tralbum_details` requires `tralbum_id`, NOT `package_id`. Live tested: passing `package_id` returns "No such tralbum." The album `tralbum_id` can be extracted from `data-tralbum.id` during HTML scrape.
- **`data-tralbum` does NOT contain tags** (live tested). Tags exist only as `<a class="tag">` HTML elements and in JSON-LD `keywords`. The scraper must parse these from the DOM, not from the JSON blob.
- Supabase default row limit is 1000; use a `fetchAllPages()` helper for every aggregation path.
- Tag backfill must NOT use `bandcampQueue` (concurrency 1). Default queue is fine for standalone tasks. If spawning subtasks, explicitly set their queues too.
- GIN index on tag arrays is only useful if filtering is pushed to SQL (`@>` or `&&` operators). JS-side filtering wastes the index.

**Product:**
- BC Genres are the ~20 standard Bandcamp tags: rock, electronic, metal, hip-hop-rap, ambient, punk, folk, pop, classical, country, soundtrack, world, latin, blues, comedy, spoken-word, jazz, experimental, r-b-soul, funk, reggae, acoustic, alternative, audiobooks, podcasts
- DSP Genres are the 64 from column A of the spreadsheet
- Sub Genres are the 692 from column B of the spreadsheet
- Matching: a Bandcamp tag "Jazz" matches BC genre "jazz" and DSP genre "Jazz" and sub-genre "Jazz" (case-insensitive exact)

**External:**
- `tralbum_details` is undocumented -- no SLA, could break without notice
- `dig_deeper` is undocumented -- same caveat
- Both endpoints are public (no auth token needed)
- Rate limits unknown but assumed generous for read-only public data

# Affected Files

**New files:**
- `supabase/migrations/20260404100000_bandcamp_genre_tags.sql` -- add columns
- `src/trigger/tasks/bandcamp-tag-backfill.ts` -- backfill task
- `src/lib/shared/genre-taxonomy.ts` -- static genre/sub-genre constants
- `src/lib/clients/bandcamp-discover.ts` -- `tralbum_details` and `dig_deeper` API client

**Modified files:**
- [src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts) -- capture tags on new mappings (lines ~1316-1342 and ~898-900)
- [src/trigger/tasks/index.ts](src/trigger/tasks/index.ts) -- export new backfill task
- [src/actions/bandcamp.ts](src/actions/bandcamp.ts) -- add `getBandcampTrending` action + extend `getBandcampSalesOverview` with tag data
- [src/app/admin/settings/bandcamp/page.tsx](src/app/admin/settings/bandcamp/page.tsx) -- add Trending tab + genre filter dropdowns on Sales History
- [docs/system_map/TRIGGER_TASK_CATALOG.md](docs/system_map/TRIGGER_TASK_CATALOG.md) -- add backfill task
- [docs/system_map/API_CATALOG.md](docs/system_map/API_CATALOG.md) -- add `getBandcampTrending`
- [project_state/engineering_map.yaml](project_state/engineering_map.yaml) -- add genre intelligence
- [project_state/journeys.yaml](project_state/journeys.yaml) -- add genre data journey

# Proposed Implementation

## Phase 1: Data Layer (migration + API client + taxonomy)

**Step 1.1: Migration**

New file `supabase/migrations/20260404100000_bandcamp_genre_tags.sql`:
- `ALTER TABLE bandcamp_product_mappings ADD COLUMN IF NOT EXISTS bandcamp_tags text[]` -- display names from HTML (e.g. `{"Jazz","experimental jazz","spiritual","Los Angeles"}`)
- `ALTER TABLE bandcamp_product_mappings ADD COLUMN IF NOT EXISTS bandcamp_tag_norms text[]` -- normalized keys for matching/filtering (e.g. `{"jazz","experimental-jazz","spiritual","los-angeles"}`)
- `ALTER TABLE bandcamp_product_mappings ADD COLUMN IF NOT EXISTS bandcamp_primary_genre text` -- derived: first tag that matches BC_GENRES list, lowercased. Never arbitrary tags like "astral".
- `ALTER TABLE bandcamp_product_mappings ADD COLUMN IF NOT EXISTS bandcamp_tralbum_id bigint` -- album ID from data-tralbum.id (for future tralbum_details calls; != package_id)
- `ALTER TABLE bandcamp_product_mappings ADD COLUMN IF NOT EXISTS bandcamp_tags_fetched_at timestamptz` -- when tags were last captured
- `CREATE INDEX idx_bandcamp_mappings_genre ON bandcamp_product_mappings (bandcamp_primary_genre) WHERE bandcamp_primary_genre IS NOT NULL`
- `CREATE INDEX idx_bandcamp_mappings_tag_norms ON bandcamp_product_mappings USING GIN (bandcamp_tag_norms) WHERE bandcamp_tag_norms IS NOT NULL` -- for SQL-side `@>` and `&&` array operator filtering

Apply: `supabase db push --yes`

**Step 1.2: Tag extraction in scraper + Discover API client**

**A) Add tag extraction to `parseBandcampPage` in `src/lib/clients/bandcamp-scraper.ts`:**

The function already receives the full HTML. Add extraction of `<a class="tag">` links and `data-tralbum.id` (the real tralbum_id):

```typescript
// In parseBandcampPage, after parsing data-tralbum:
const tralbumId = data.id ?? null; // This is the real album ID (NOT package_id)

// Extract tags from HTML DOM (NOT from data-tralbum which doesn't have them)
const tagMatches = html.match(/<a class="tag"[^>]*>([^<]+)<\/a>/g);
const tags = tagMatches
  ?.map(t => t.replace(/<[^>]+>/g, "").trim())
  .filter(Boolean) ?? [];

// Return both in ScrapedAlbumData:
return {
  ...existingFields,
  tralbumId,       // bigint album ID for future tralbum_details calls
  tags,            // string[] display names from HTML
  tagNorms,        // string[] normalized (lowercase, hyphenated) for matching
};
```

**B) New file `src/lib/clients/bandcamp-discover.ts` (for Trending only):**

```typescript
// Only dig_deeper for the Trending tab -- tags come from HTML scraping, not this API
export async function fetchDigDeeper(tags: string[], options?: {
  format?: "all" | "digital" | "vinyl" | "cd" | "cassette";
  sort?: "pop" | "new" | "rec" | "surprise" | "top";
  page?: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch("https://bandcamp.com/api/hub/2/dig_deeper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        filters: { tags, format: options?.format ?? "all", sort: options?.sort ?? "pop", location: 0 },
        page: options?.page ?? 1,
      }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}
```

**Note:** `tralbum_details` is NOT used for primary tag capture. It is available as a future enhancement if isloc (location flag) data becomes needed. The `tralbum_id` is stored during scrape to enable this later.

**Step 1.3: Genre taxonomy constants + alias map**

New file `src/lib/shared/genre-taxonomy.ts` containing:
- `BC_GENRES`: array of ~23 Bandcamp standard genre tag names (with `norm_name` versions)
- `DSP_GENRES`: array of 64 genre names from spreadsheet column A
- `SUB_GENRES`: array of 692 sub-genre names from spreadsheet column B (as `Set<string>` for O(1) lookup)
- `BC_TO_DSP_ALIASES`: deterministic alias map for the 5 known mismatches:
  ```typescript
  const BC_TO_DSP_ALIASES: Record<string, string> = {
    "hip-hop-rap": "Hip-Hop / Rap",
    "r-b-soul": "R&B",
    "spoken-word": "Spoken Word",
    "experimental": "Alternative",  // closest DSP match
    "acoustic": "Folk",             // closest DSP match
  };
  ```
- `normalizeBcTag(tag: string)`: strip punctuation, collapse spaces/hyphens/slashes, lowercase
- `matchTagToTaxonomy(tagNorms: string[])`: returns `{ bcGenre, dspGenre, subGenre }` using:
  1. For `bcGenre`: first `tagNorm` that matches `BC_GENRES_SET` (normalized)
  2. For `dspGenre`: first `tagNorm` that matches `DSP_GENRES_SET`, OR first match via `BC_TO_DSP_ALIASES`
  3. For `subGenre`: first `tagNorm` that matches `SUB_GENRES_SET`
  All matching is on normalized keys, not display names

**Phase 1 Tests:**
- `pnpm typecheck` must pass
- Run migration: `supabase db push --yes`
- Verify columns exist: `SELECT column_name FROM information_schema.columns WHERE table_name = 'bandcamp_product_mappings' AND column_name LIKE 'bandcamp_tag%'`
- Unit test for `normalizeTag()`: verify diacritics stripped (NFD), punctuation removed, spaces -> hyphens, lowercase
- Unit test for `matchTagToTaxonomy()`: verify BC genre match, DSP alias map, sub-genre Set lookup, null when no match
- Unit test for tag extraction regex: verify `<a class="tag">` parsing against fixture HTML
- Preflight query: `SELECT COUNT(*) FROM bandcamp_product_mappings WHERE bandcamp_url IS NOT NULL` (expected: ~211)

**Supabase API note (from Review 3):** For array overlap filtering, use `.overlaps('bandcamp_tag_norms', ['jazz', 'experimental'])` (NOT `.ov()` which does not exist in v2.99.2). The GIN partial index requires `.not('bandcamp_tag_norms', 'is', null)` in the query for the planner to use it.

**Normalization note (from Reviews 1+4):** The `normalizeTag` function must use `tag.normalize("NFD").replace(/[\u0300-\u036f]/g, "")` for diacritics (already used in `buildBandcampAlbumUrl` in the scraper). Full pipeline: trim -> NFD diacritics -> lowercase -> strip non-alphanum except hyphens -> collapse spaces to hyphens.

## Phase 2: Tag Backfill Task

**Step 2.1: Backfill task**

New file `src/trigger/tasks/bandcamp-tag-backfill.ts`:

- On-demand task (NOT cron). Resumable with cursor. Uses `bandcamp-scrape` queue (concurrency 5, shared with normal scrape tasks) to avoid overwhelming Bandcamp with parallel HTML fetches.
- Fetches all `bandcamp_product_mappings` rows where `bandcamp_tags IS NULL AND bandcamp_url IS NOT NULL AND (scrape_failure_count < 5 OR scrape_failure_count IS NULL)`, ordered by `id`
- **Audit note:** 109 mappings have `scrape_failure_count >= 5` (mostly constructed URLs that 404). These are excluded to avoid wasting fetches. Expected backfill candidates: ~200 of 211 URL-bearing mappings.
- For each mapping, fetches the album HTML page (uses existing `fetchBandcampPage` from `bandcamp-scraper.ts`)
- Extracts tags from `<a class="tag">` HTML links (same approach proven in live testing)
- Extracts `tralbum_id` from `data-tralbum.id` in the HTML
- Derives `bandcamp_primary_genre` by matching tags against `BC_GENRES` set (first match wins; never arbitrary tags)
- Stores: `bandcamp_tags` (display names), `bandcamp_tag_norms` (normalized keys), `bandcamp_primary_genre`, `bandcamp_tralbum_id`, `bandcamp_tags_fetched_at`
- **Resumable**: persists cursor (last processed mapping `id`) to `channel_sync_log` metadata every 50 records. On restart, reads cursor and continues from last position.
- Rate-limited: configurable delay (default 500ms between fetches, uses same scrape infrastructure)
- Logs progress to `channel_sync_log` (sync_type: `tag_backfill`)
- Only updates `bandcamp_tags` when tags have actually changed (avoids unnecessary writes)
- Handles errors gracefully: skip failed items, log, continue to next

**Step 2.2: Register in index.ts**

Add export: `export { bandcampTagBackfillTask } from "./bandcamp-tag-backfill";`

**Step 2.3: Update scrape page task for ongoing capture**

In the `bandcampScrapePageTask` (in `bandcamp-sync.ts` lines 253-272), after `parseBandcampPage` returns, write the new tag fields to the mapping along with existing scrape fields:
- `bandcamp_tags`: from `scraped.tags`
- `bandcamp_tag_norms`: from `scraped.tagNorms`
- `bandcamp_primary_genre`: derived via `matchTagToTaxonomy`
- `bandcamp_tralbum_id`: from `scraped.tralbumId`
- `bandcamp_tags_fetched_at`: `new Date().toISOString()`

This means every future scrape automatically captures/updates tags. No separate API call needed.

**Phase 2 Tests:**
- `pnpm typecheck` must pass
- Unit test: `parseBandcampPage` with fixture HTML returns `tags`, `tagNorms`, `tralbumId`
- Unit test: `parseBandcampPage` with HTML that has no tags returns empty arrays (not null)
- Integration test: run backfill against 20 known album URLs, verify `bandcamp_tag_norms` populated and `bandcamp_primary_genre` derived
- Deploy to Trigger.dev: `npx trigger.dev deploy`
- Trigger backfill task manually from dashboard
- Monitor `channel_sync_log` for `sync_type = 'tag_backfill'` progress
- Acceptance queries:
  - `SELECT COUNT(*) FROM bandcamp_product_mappings WHERE bandcamp_tag_norms IS NOT NULL`
  - `SELECT bandcamp_primary_genre, COUNT(*) FROM bandcamp_product_mappings GROUP BY 1 ORDER BY 2 DESC`
  - `SELECT COUNT(*) FROM bandcamp_product_mappings WHERE bandcamp_url IS NOT NULL AND bandcamp_tags IS NULL` (should decrease toward 0)

**Observability (from Review 4):**
- Emit to `channel_sync_log` metadata: `{ items_processed, items_failed, tag_parse_fail_count, cursor_position }`
- Log structured errors for failed parses: `{ mappingId, url, errorType }`
- If 429/403 rate exceeds 1% of fetches, pause backfill and log warning

## Phase 3: Sales History Genre Filters

**Step 3.1: Extend server action**

In `getBandcampSalesOverview` (`src/actions/bandcamp.ts`):
- **Join strategy (Review 1 #8)**: Look up each item's tags from mappings. Prefer join order: (1) SKU match via `warehouse_product_variants`, (2) URL match via `bandcamp_url` == `item_url`, (3) title+artist only as last-resort heuristic. Store `matched_by` provenance on each item.
- Add `tags: string[]`, `tagNorms: string[]`, `bcGenre: string | null`, `dspGenre: string | null`, `subGenre: string | null` to each item using `matchTagToTaxonomy` from `genre-taxonomy.ts`
- Add summary stats to the return: `{ untaggedCount, genreBreakdown: { genre: string, items: number, units: number, revenue: number }[] }`
- **DB-side filtering (Review 1 #4)**: When genre filters are active, push `bandcamp_tag_norms && ARRAY[...]` into the Supabase query instead of loading all rows and filtering in JS. This uses the GIN index.

**Step 3.2: Add 3 filter dropdowns to SalesHistoryTab**

In `src/app/admin/settings/bandcamp/page.tsx`:
- Add state: `bcGenreFilter`, `dspGenreFilter`, `subGenreFilter` (all default "all")
- Add 3 `<select>` dropdowns after the existing Type filter
- Only show genres that have at least 1 matching item (dynamic options from data)
- Update `sortedFiltered` useMemo to apply genre filters (AND with existing filters)
- Add "Untagged" option to the BC Genre dropdown
- Update summary row to show % of total: `"42 items (31%) -- 1,847 units -- $12,340 (28% of revenue)"`
- Add tags to CSV export

**Step 3.3: Add tag column to table**

- New "Genre" column showing `bcGenre` badge
- Sortable like other columns

**Phase 3 Tests:**
- `pnpm typecheck` must pass
- `pnpm test` must pass (no regressions in existing 638 tests)
- Manual test on localhost: select "Jazz" in BC Genres dropdown, verify only jazz-tagged items shown
- Manual test: select a DSP Genre, verify alias mapping works (e.g. "Hip-Hop / Rap" matches BC tag "hip-hop-rap")
- Manual test: verify "Untagged" filter option shows items with no tags
- Manual test: verify summary row shows "X items (Y%) -- Z units -- $W (Q% of revenue)"
- Manual test: export CSV and verify it contains tag/genre columns
- Verify GIN index is being used: items should load fast even with genre filters active

## Phase 4: Trending Tab

**Step 4.1: Server action**

New action `getBandcampTrending` in `src/actions/bandcamp.ts`:
- Accepts `{ tags: string[], sort, format, page }`
- **Brief server cache (Reviews 1+3)**: cache by `{tags, sort, format, page}` key for 3 minutes. Implementation: use Next.js `fetch()` with `{ next: { revalidate: 180 } }` inside the `fetchDigDeeper` call, which natively handles TTL and stale-while-revalidate without a custom cache layer. Timeout budget of 10 seconds on the upstream call (AbortController). If `unstable_cache` is not suitable, fall back to a simple in-memory Map with TTL.
- Calls `fetchDigDeeper` with configurable rate/retry policy
- Cross-references returned `band_id`s against `bandcamp_connections` to flag client artists
- **Enhanced matching (Review 1 #10)**: match primarily on `band_id`, secondarily on `subdomain` and `band_name`. Store `matchedConnectionId` and `matchMethod` for diagnostics.
- Returns items with `isClientArtist: boolean` flag, `connectionBandName` if matched, and full `packages[]` for format intelligence

**Step 4.2: Trending tab UI**

Add new tab to the Bandcamp settings page:
- Tab trigger: `<TabsTrigger value="trending">Trending</TabsTrigger>`
- Genre selector: BC Genres dropdown (the ~20 standard tags)
- Sort selector: Popular / New / Top Selling / Recommended / Surprise
- Format selector: All / Digital / Vinyl / CD / Cassette
- Results grid: card layout with album art (`https://f4.bcbits.com/img/a{art_id}_2.jpg`), artist, title, genre badge, format badges with prices from `packages[]`
- Client artist highlighting: items where `isClientArtist` is true get a distinct border/badge "Your Artist"
- Pagination: "Load More" button (or auto-load) using `more_available` flag
- Link each item title to its `tralbum_url`

**Step 4.3: Format intelligence summary**

At the top of trending results, show: "Of 20 trending items: 14 have vinyl, 8 have CD, 3 have cassette" -- derived from the `packages` array.

**Phase 4 Tests:**
- `pnpm typecheck` must pass
- Manual test on localhost: select "jazz" genre, verify 20 trending items load
- Manual test: change sort to "new", verify different results
- Manual test: change format to "vinyl", verify results have vinyl packages
- Manual test: verify client artist highlighting (items from your 17 connected bands should show "Your Artist" badge)
- Manual test: verify album art images load (`https://f4.bcbits.com/img/a{art_id}_2.jpg`)
- Manual test: verify pagination ("Load More" or next page)
- Manual test: verify format summary shows correctly ("14 vinyl, 8 CD, 3 cassette")
- Error state test: disconnect network temporarily, verify Trending shows cached results or graceful error
- Cache test: load same genre twice within 3 minutes, verify second load is instant (cached)

## Phase 5: Deploy + Truth Docs

**Step 5.1: Deploy**
- `git add -A && git commit && git push` (Vercel auto-deploy)
- `npx trigger.dev deploy` (Trigger.dev deploy for tag backfill task)

**Step 5.2: Run tag backfill**
- Trigger `bandcamp-tag-backfill` from the Trigger.dev dashboard
- Monitor progress in `channel_sync_log`

**Step 5.3: Truth doc updates**
- `TRIGGER_TASK_CATALOG.md`: add `bandcamp-tag-backfill` (on-demand)
- `API_CATALOG.md`: add `getBandcampTrending` under Integrations
- `engineering_map.yaml`: add genre intelligence to integrations responsibilities
- `journeys.yaml`: add `bandcamp_genre_intelligence` journey

**Step 5.4: Final verification**
- `pnpm release:gate`
- Verify tags populated on mappings (query `bandcamp_tags IS NOT NULL` count)
- Verify Sales History genre filters work with real data
- Verify Trending tab loads and highlights client artists
- Verify CSV export includes genre columns

# Assumptions

- **CORRECTED (v2)**: `tralbum_id` != `package_id`. Our `bandcamp_item_id` is a merch package ID, NOT an album ID. The real `tralbum_id` must be extracted from `data-tralbum.id` during HTML scrape. Confirmed via live API testing.
- **CORRECTED (v2)**: `data-tralbum` does NOT contain tags. Tags must be extracted from `<a class="tag">` HTML elements. Confirmed via live testing.
- Tags from HTML scraping are the same tags visible on every Bandcamp album page. These are stable (user-applied, not API-internal).
- 18 of 23 BC genres match DSP genres exactly (case-insensitive). 5 need deterministic aliases. 2 BC genres (`experimental`, `acoustic`) have no exact DSP equivalent and map to closest (`Alternative`, `Folk`).
- The 692 sub-genres and 64 DSP genres are static and will be updated manually in code when the taxonomy changes.
- The `dig_deeper` API returns 20 items per page and supports pagination via the `page` parameter.
- Items without `bandcamp_url` cannot have tags captured. URL coverage is currently 31% (201 of 648 mappings). Tag coverage will be bounded by URL coverage until more URLs are populated via sales backfill.

# Risks

- **`dig_deeper` API breakage**: Undocumented endpoint could change. Mitigated: only used for live Trending tab (no stored data depends on it). Error state shown to user.
- **HTML tag scraping fragility**: `<a class="tag">` DOM structure could change. Mitigated: Bandcamp's tag display is a core product feature tied to their Discover page, unlikely to change structure. If it does, tags already captured are preserved in DB.
- **Tag matching coverage**: Some Bandcamp tags will not match any DSP genre or sub-genre (e.g. "pedal steel", "microtonal"). Items with only non-matching tags show as "Untagged" in DSP/sub filters. Expected and visible via the Untagged count.
- **URL coverage limits tag coverage**: Only items with `bandcamp_url` can have tags. Currently 31% URL coverage. Tag backfill is bounded by this. Improves as sales backfill progresses and `crossReferenceAlbumUrls` runs.
- **Bandcamp rate limiting on HTML fetches**: The tag backfill reuses the scrape infrastructure which already handles 429/Retry-After. Configurable delay prevents hammering.

# Validation Plan

After each phase:
- Phase 1: `pnpm typecheck`, `supabase db push --yes`, verify columns exist
- Phase 2: Deploy to Trigger.dev, run backfill, query `SELECT COUNT(*) FROM bandcamp_product_mappings WHERE bandcamp_tags IS NOT NULL`
- Phase 3: `pnpm typecheck`, `pnpm test`, manual test of 3 filter dropdowns + CSV export on localhost
- Phase 4: `pnpm typecheck`, manual test of Trending tab on localhost
- Phase 5: `pnpm release:gate`, full verification of all features in production

# Rollback Plan

- **Phase 1**: Drop columns via new migration. No data loss (columns are additive).
- **Phase 2**: Delete the task file and remove from index.ts. Tags already written are harmless (unused columns).
- **Phase 3**: Revert the UI changes. Server action changes are additive (extra fields on existing return shape).
- **Phase 4**: Remove the Trending tab. No DB writes to undo. The `getBandcampTrending` action is stateless.

Each phase is independently revertable.

# Rejected Alternatives

- **Use `tralbum_details` API as primary tag source (original v1 plan)**: Rejected in v2 after live testing confirmed `package_id` != `tralbum_id`. Getting the correct album ID requires an extra API call (`band_details`) or HTML parse, adding complexity. HTML `<a class="tag">` extraction is simpler, already integrated with scraper infrastructure, and gives the same tags. `tralbum_details` is preserved as an optional future enhancement for `isloc` flag data, enabled by storing `tralbum_id` from `data-tralbum.id`.
- **Use `dig_deeper` to tag existing catalog**: Rejected. Discovery API returns albums by popularity within a genre -- your albums may not appear. Not a lookup tool.
- **Store genre taxonomy in a database table**: Rejected. The taxonomy is static (64 + 692 entries), rarely changes, and is only used for matching. Code constants with `Set<string>` give O(1) lookup with no migration/RLS overhead.
- **Fuzzy matching for genre taxonomy**: Rejected. A deterministic alias map for the 5 known BC-to-DSP mismatches is more predictable than fuzzy matching. Can revisit if exact+alias coverage proves insufficient.
- **Store trending snapshots in the DB**: Rejected for now. Live fetch with brief server cache (3 min) is simpler. Daily snapshots for email digest deferred to Phase C.
- **Store `bandcamp_genre` as "first non-location tag"**: Rejected (Review 1 #1). Too lossy -- arbitrary tags like "astral" or "pedal steel" would become the primary genre. Instead, `bandcamp_primary_genre` is derived by matching against the curated `BC_GENRES` list. If no tag matches, it stays NULL.
- **JS-side tag filtering only**: Rejected (Review 1 #4). GIN index on `bandcamp_tag_norms` is only useful if filtering is pushed to SQL. Plan now uses `@>` and `&&` array operators in Supabase queries.

# Open Questions

1. **Should the Trending tab have a "Save to Watchlist" feature?** Could store trending items staff want to track. Deferred to Phase C.
2. **Should we build an auto-email when a client artist appears in trending?** High-value feature but requires daily snapshot storage. Deferred to Phase C.
3. **Merch items without album page (t-shirts, tote bags)** -- these have no album URL and no tags. Should they inherit tags from the parent album? Or stay untagged? Current plan: stay untagged, flagged via "Untagged" filter.
4. **Should CSV export include raw + mapped genre fields?** (Review 1 #11) Proposed: export `bandcamp_tags_raw`, `matched_bc_genre`, `matched_dsp_genre`, `matched_sub_genre` for debugging. Adds 4 columns.

# Deferred Items

- **Phase B**: `tralbum_details` enhancement -- use stored `bandcamp_tralbum_id` to call mobile API for structured tags with `isloc` location flags and `norm_name`. Requires solving rate limiting and 403 blocking on mobile API.
- **Phase B**: Daily trending snapshots for historical comparison
- **Phase B**: Genre heatmap / tag cloud on Bandcamp Health tab
- **Phase B**: Format intelligence summary on Trending (aggregate vinyl/CD/cassette availability)
- **Phase C**: Weekly email digest for client-artist trending alerts
- **Phase C**: Tag-to-revenue correlation analysis
- **Phase C**: DSP metadata gap detection (items missing DSP genre mapping)
- **Phase C**: "Save to Watchlist" on trending items
- **Phase C**: Synonym/fuzzy matching layer for genre taxonomy (if exact+alias coverage is too low)
- **Future hardening (from reviews)**: Configurable rate limiting (`BC_DISCOVER_RPS` env var), circuit breaker for repeated 429/403/5xx, raw response versioning (`tralbum_schema_version`), provider abstraction for tag sources (HTML primary, mobile API fallback)

# Revision History

- v1 (2026-04-04): Initial plan using `tralbum_details` as primary tag source
- v2 (2026-04-04): Major architectural change after 2 technical reviews + live verification:
  - **CRITICAL FIX**: `tralbum_id` != `package_id` confirmed via live testing. Changed primary tag source from mobile API to HTML `<a class="tag">` scraping.
  - **CRITICAL FIX**: `data-tralbum` does NOT contain tags. Confirmed via live testing.
  - Added `bandcamp_tag_norms text[]` for normalized matching (Review 1 #2)
  - Changed `bandcamp_genre` to `bandcamp_primary_genre` derived from BC_GENRES match, not "first non-location tag" (Review 1 #1)
  - Added `bandcamp_tralbum_id` column to store real album ID for future `tralbum_details` calls
  - Added deterministic alias map for 5 BC-to-DSP mismatches (Review 1 #3)
  - Added resumable backfill with cursor (Review 1 #5)
  - Added brief server cache for Trending (Review 1 #9)
  - Changed join strategy to prefer SKU > URL > title/artist (Review 1 #8)
  - Push tag filtering to SQL using GIN array operators (Review 1 #4)
  - Enhanced client-artist matching with secondary diagnostics (Review 1 #10)
  - Removed `raw_tralbum_data jsonb` column (mobile API not primary; `tralbum_id` stored instead)
  - Added `bandcamp_tags_fetched_at` for update-only-when-changed logic (Review 1 #14)
- v3 (2026-04-04): Integrated reviews 3-4. No conflicts found between all 4 review rounds. Changes:
  - Corrected Supabase array filter method: `.overlaps()` not `.ov()` (verified in v2.99.2)
  - Added `.not('bandcamp_tag_norms', 'is', null)` requirement for GIN partial index usage
  - Added Next.js `fetch({ next: { revalidate: 180 } })` as preferred cache strategy for Trending
  - Added NFD diacritics normalization detail (already exists in codebase at `buildBandcampAlbumUrl`)
  - Added comprehensive test steps between every phase (unit tests, integration tests, manual tests, acceptance queries)
  - Added observability metrics: `tag_parse_fail_rate`, `http_429_rate`, structured error logs
  - Added defensive parsing with try/catch for tag extraction (log and continue on failure)
  - Confirmed no conflicts between reviews: all 4 agree on HTML-primary approach, GIN index, alias map, resumable backfill, and server cache
  - Verified against live codebase: 211 URLs available for tag backfill, `.overlaps()` confirmed, NFD normalization exists
- v4 (2026-04-04): Added pre-implementation audit findings. Changes:
  - Added live data state table (17 connections, 648 mappings, 211 URLs, 5910 sales, 0% block rate)
  - Added scrape_failure_count filter to backfill query (skip 109 known-bad URLs)
  - Fixed counter drift bug in bandcamp-sales-sync.ts (deployed) -- daily sync now updates backfill state
  - Corrected Trigger touchpoint: tag capture happens in `bandcamp-scrape-page`, not `bandcamp-sync` main task
  - Changed backfill queue from "default" to `bandcamp-scrape` (concurrency 5, shared with scrape tasks)
  - All Trigger tasks verified healthy, all sensors green except scraper_review_open (operational backlog)
  - Confirmed ~200 items ready for immediate tag backfill (211 with URL minus ~11 with failed scrapes)

# Pre-Implementation Audit (2026-04-04T12:30Z)

## Live Data State

| Metric | Value | Implication for Genre Plan |
|---|---|---|
| Active connections | 17 (all syncing within 5 min) | All connections healthy, tags will flow for all |
| Total mappings | 648 | Full catalog size |
| Mappings with URL | 211 (33%) | **This bounds initial tag coverage.** Only items with URLs can be scraped for tags. |
| Mappings with raw_api_data | 98 (15%) | Only SKU-matched items |
| URL source breakdown | 77 orders_api, 70 constructed, 64 scraper_verified | Constructed URLs have high 404 rate (109 failed scrapes); orders_api URLs are reliable |
| Failed scrapes (>=5 attempts) | 109 | Mostly constructed URLs. These items need URLs from sales backfill cross-reference instead. |
| Total sales rows | 5,910 | Growing as backfill progresses |
| Backfill: completed | 4 connections | Lord Spikeheart, Nicole McCabe, Matt McBane, SUSS |
| Backfill: running | 5 connections | Northern Spy, Xol Meissner, Good Neighbor, LEAVING RECORDS, In The Pines |
| Backfill: pending (no state) | 8 connections | Will be created by cron automatically |
| Scrape block rate | 0% (0/148 in 1h) | Safe to proceed with tag backfill scraping |
| Negative inventory | 0 rows | Previous fix holding |
| Counter drift | Fixed (reconciled + daily sync now updates counter) | No longer a concern |

## Audit-Driven Plan Adjustments

1. **Tag backfill will initially cover ~211 items (33%)** -- not the full 648. The plan already accounts for this ("URL coverage bounds tag coverage"). Tag coverage will improve as the sales backfill completes and `crossReferenceAlbumUrls` populates more URLs.

2. **Skip failed-scrape URLs during tag backfill.** 109 mappings have `scrape_failure_count >= 5`. The tag backfill should filter these out (`scrape_failure_count < 5 OR scrape_failure_count IS NULL`) to avoid wasting fetches on known-bad URLs.

3. **Daily sales sync counter drift is now fixed.** The `bandcamp-sales-sync` task now updates `total_transactions` after inserting rows. No further reconciliation needed for ongoing operations. The reconciliation script remains available for one-off corrections.

4. **Scraper infrastructure is healthy.** 0% block rate, sweep running every 10 min, all sensors healthy except `scraper_review_open` (221 items -- operational backlog, not a blocker). Tag extraction can safely be added to the existing scrape pipeline.

5. **`bandcamp-scrape-page` task** (the actual scrape executor) is where tags will be written to mappings. This task is already running reliably (21 scrape_page entries in last 2 hours, all completed). Adding tag extraction here is low-risk.

## Trigger Task Health (verified 2026-04-04)

| Task | Status | Relevant to Genre Plan? |
|---|---|---|
| `bandcamp-sync-cron` (*/30) | Healthy, 4m ago | YES -- ongoing tag capture on new mappings |
| `bandcamp-scrape-sweep` (*/10) | Healthy, 9m ago | YES -- triggers scrapes that will capture tags |
| `bandcamp-scrape-page` (event) | Healthy, 21 runs/2h | YES -- this is where tag extraction code goes |
| `bandcamp-sales-backfill-cron` (*/10) | Healthy, advancing | YES -- populates URLs that enable tag scraping |
| `bandcamp-sales-sync` (daily 5am) | Healthy, fixed counter | YES -- keeps sales data current |
| `bandcamp-sale-poll` (*/5) | Healthy | NO -- real-time sales, not tag-related |
| `bandcamp-inventory-push` (*/5) | Healthy | NO |
| `sensor-check` (*/5) | Healthy | NO |

# Evidence Sources

- `TRUTH_LAYER.md` (read)
- `docs/system_map/API_CATALOG.md` lines 130-158 (read)
- `docs/system_map/TRIGGER_TASK_CATALOG.md` lines 1-30 (read)
- `project_state/engineering_map.yaml` (read in prior session)
- `project_state/journeys.yaml` (read in prior session)
- `src/trigger/tasks/bandcamp-sync.ts` lines 898, 1316-1342 (mapping upsert/insert)
- `src/lib/clients/bandcamp.ts` lines 14-87 (schemas), lines 185-667 (API functions)
- `src/actions/bandcamp.ts` lines 615-764 (getBandcampSalesOverview)
- `src/app/admin/settings/bandcamp/page.tsx` lines 598-663 (SalesHistoryTab), 998-1003 (tabs)
- `supabase/migrations/20260402210000_bandcamp_api_complete.sql` lines 8-34 (existing columns)
- Live API testing: `tralbum_details` returns `tags[]` with `name`, `norm_name`, `isloc`; `dig_deeper` returns 20 items per page with `genre`, `packages[]`, `audio_url`, `tralbum_url`
- Genre spreadsheet: 64 DSP genres (column A), 692 sub-genres (column B) from `/Users/tomabbs/Downloads/genere sub genre.xlsx`

# API Boundaries Impacted

- `src/actions/bandcamp.ts`: new export `getBandcampTrending`, extended `getBandcampSalesOverview` with tag fields
- New client: `src/lib/clients/bandcamp-discover.ts` (dig_deeper for Trending tab only)
- Modified client: `src/lib/clients/bandcamp-scraper.ts` (`parseBandcampPage` adds tag extraction from HTML)
- New constants: `src/lib/shared/genre-taxonomy.ts` (BC_GENRES, DSP_GENRES, SUB_GENRES, alias map)

# Trigger Touchpoint Check

- **New task**: `bandcamp-tag-backfill` (on-demand, `bandcamp-scrape` queue concurrency 5)
- **Modified task**: `bandcamp-scrape-page` in `bandcamp-sync.ts` (adds tag extraction + write to mapping during scrape)
- **NOT modified**: `bandcamp-sync` main task (no tag capture during merch sync -- tags come from HTML scrape, not merch API)
- **NOT modified**: `bandcamp-scrape-sweep` (continues to trigger scrapes; tag capture happens inside `bandcamp-scrape-page`)
- **NOT affected**: `bandcamp-sales-backfill`, `bandcamp-sale-poll`, `sensor-check`, `bandcamp-inventory-push`
- **All tasks verified healthy** in pre-implementation audit (2026-04-04T12:30Z)

# Doc Sync Contract Updates Required

- `TRIGGER_TASK_CATALOG.md`: add `bandcamp-tag-backfill` to Event/On-Demand table
- `API_CATALOG.md`: add `getBandcampTrending` under Integrations section
- `engineering_map.yaml`: update integrations responsibilities
- `journeys.yaml`: add `bandcamp_genre_intelligence` journey

---

# Appendix: Handoff Reference

## All Affected Files (with line counts and key sections)

| # | Path | Lines | Purpose | Key sections for this plan |
|---|---|---|---|---|
| 1 | `src/lib/clients/bandcamp.ts` | 667 | Bandcamp API client | Zod schemas (14-87), token refresh (120-170), SKU matching (430-480), Sales Report API (530-650). **No mobile/tralbum API yet -- `bandcamp-discover.ts` will be new.** |
| 2 | `src/trigger/tasks/bandcamp-sync.ts` | 1753 | Core merch sync task | Matched upsert at line 898 and new mapping insert at 1316-1342 are where `bandcamp_tags`/`bandcamp_genre`/`raw_tralbum_data` writes will be added. `bandcamp_item_id: merchItem.package_id` stored at 874/1319. |
| 3 | `src/trigger/tasks/index.ts` | 93 | Task registry | Bandcamp sales exports at 88-90. `bandcampTagBackfillTask` export will be added here. |
| 4 | `src/trigger/lib/bandcamp-queue.ts` | 4 | Shared queue (concurrency 1) | Tag backfill must NOT use this queue -- runs on default queue. |
| 5 | `src/actions/bandcamp.ts` | 814 | Server actions | `getBandcampSalesOverview` starts at 615. Item aggregation map at 712-760 is where `tags`/`bcGenre`/`dspGenre`/`subGenre` fields will be added. `getBandcampTrending` will be a new function. |
| 6 | `src/app/admin/settings/bandcamp/page.tsx` | 1229 | Settings page UI | Tab triggers at 998-1003. `SalesHistoryTab` at 598. Sort type at 587. `sortedFiltered` useMemo at 632-663. Filter dropdowns at 718-752. Table headers at 790-828. CSV export at 756-785. **Trending tab will be a new component added after SalesHistoryTab.** |
| 7 | `src/trigger/lib/bandcamp-url-crossref.ts` | 70 | URL cross-reference | Matches `subdomain + album_title` from mappings to `item_url` from sales. Not directly modified but useful context. |
| 8 | `src/trigger/tasks/bandcamp-sales-backfill.ts` | 310 | Sales backfill | Counter bug fixed (insert/update split at 132-150). Cron time guard at 275-310. Not modified by this plan. |
| 9 | `src/trigger/tasks/bandcamp-sales-sync.ts` | 142 | Daily sales sync | Cron at 5am UTC. Not modified by this plan. |
| 10 | `src/trigger/tasks/bandcamp-scrape-sweep.ts` | 115 | Scrape sweep | Enrichment-only (about, credits, tracks). Not modified but could also extract tags from HTML as fallback. |
| 11 | `src/lib/clients/bandcamp-scraper.ts` | 482 | HTML scraper | `parseBandcampPage` at 310-400 extracts data-tralbum. Could add `<a class="tag">` extraction as fallback for tag capture. |
| 12 | `supabase/migrations/20260402210000_bandcamp_api_complete.sql` | 159 | Schema | `bandcamp_product_mappings` ALTER TABLE at 8-19. New migration will add `bandcamp_tags text[]`, `bandcamp_genre text`, `raw_tralbum_data jsonb`. |
| 13 | `supabase/migrations/20260403000001_fix_variant_id_unique.sql` | 10 | Schema fix | `UNIQUE (variant_id)` constraint. Context only. |

## Undocumented Bandcamp API Reference

### `GET /api/mobile/25/tralbum_details` -- Tags Per Album

```
URL: https://bandcamp.com/api/mobile/25/tralbum_details?band_id={band_id}&tralbum_type=a&tralbum_id={item_id}
Auth: None (public)
Rate limit: Unknown (assumed generous for read-only)

Response fields:
  id, type, title, bandcamp_url, art_id, band (object with band_id, name, image_id, bio, location),
  tralbum_artist, package_art[], featured_track_id, tracks[] (with streaming URLs),
  credits, about, album_id, album_title, release_date, is_purchasable, free_download,
  is_preorder, tags[], currency, is_set_price, price, require_email, label, label_id,
  package_details_lite[], has_digital_download, num_downloadable_tracks, merch_sold_out,
  streaming_limit

tags[] structure:
  { name: "Jazz", norm_name: "jazz", url: "/discover/jazz", isloc: false, loc_id: null, geoname: null }
  { name: "Los Angeles", norm_name: "los-angeles", url: "/discover/los-angeles", isloc: true,
    loc_id: 2704779256, geoname: { id: 5368361, name: "Los Angeles", fullname: "Los Angeles, California" } }
```

**Tested albums:**
- Aaron Shaw - And So It Is (Leaving Records): tags = Experimental, Jazz, LA, astral, experimental jazz, spiritual, Los Angeles
- Jamie Lidell - A Companion For The Spaces Between Dreams (Northern Spy): tags = Ambient, dark ambient, drone, new age, pedal steel, Nashville
- The Necks - Disquiet: tags = Ambient, ambient, drone, electronic, experimental, jazz, Australia
- SUSS - Counting Sunsets: tags = Ambient, Cosmic American, ambient country, pedal steel, psychedelic, New York
- Kalia Vandever - Another View: tags = Jazz, Brooklyn

### `POST /api/hub/2/dig_deeper` -- Trending Discovery

```
URL: https://bandcamp.com/api/hub/2/dig_deeper
Auth: None (public)
Content-Type: application/json

Request body:
  { filters: { tags: ["jazz"], format: "all", sort: "pop", location: 0 }, page: 1 }

Filter options:
  tags: any Bandcamp tag (see BC_GENRES list)
  format: "all" | "digital" | "vinyl" | "cd" | "cassette"
  sort: "pop" | "new" | "rec" | "surprise" | "top"
  location: 0 (worldwide) or geoname_id
  page: 1-based pagination

Response:
  ok: boolean, more_available: boolean, items: [] (20 per page)
  discover_spec: { genre_id, tag_id, tag_name, tag_pretty_name, format, discover_id }

Per item:
  tralbum_type ("a"), tralbum_id, item_id, title, artist, band_name, band_id, subdomain,
  genre (string), genre_id (number), tralbum_url, band_url, art_id,
  audio_url: { "mp3-128": "https://..." } (preview stream),
  featured_track_title, featured_track_number,
  packages: [{ id, price: { amount, currency, is_money }, type_str, is_vinyl, image }],
  is_preorder, num_comments, custom_domain, slug_text
```

**Image URL pattern:** `https://f4.bcbits.com/img/a{art_id}_2.jpg` (350px), `_5.jpg` (700px), `_10.jpg` (1200px)

### Bandcamp Standard Genre Tags (~25)
rock, electronic, metal, hip-hop-rap, ambient, punk, folk, pop, classical, country, soundtrack, world, latin, blues, comedy, spoken-word, jazz, experimental, r-b-soul, funk, reggae, acoustic, alternative, audiobooks, podcasts

## Genre Taxonomy Data

### DSP Genres (64 entries, from spreadsheet column A)
African, Alternative, Ambient, Arabic, Argentinian, Bluegrass, Blues, Brazilian, Caribbean, Children's, Chinese, Classical, Comedy, Country, Dance, Disco, Electronic, Flamenco, Folk, French, Funk, German, Gospel, Greek, Hip-Hop / Rap, Holiday, Hungarian, Indian, Indie, Israeli, Italian, Japanese, Jazz, J-Tracks, Khaleeji, Korean, Laotian, Latin, Malian, Metal, Musica Mexicana, New Age, Noise & Non-Music Audio, Opera, Polish, Pop, Portuguese, Punk, R&B, Reggae, Regional Roots, Religious, Rock, Romanian, Russian, Singer-Songwriter, Soul, Soundtrack, Spoken Word, Thai, Turkish, Uruguayan, Vietnamese, World

### Sub Genres (692 entries, from spreadsheet column B)
Stored in `src/lib/shared/genre-taxonomy.ts` (to be created). Full list includes: Acid Jazz, Acoustic, Acoustic Blues, Acoustic Country, Acoustic Folk, Acoustic Pop, Acoustic Rock, Acoustic Singer-Songwriter, Acoustic Soul, Adult Alternative, Adult Contemporary, African, African Dancehall, African Reggae, Afrikaans, Afro House, Afro Soul, Afrobeat, Afro-Cuban Jazz, Afro-folk, Afro-fusion, Afropop, Album Rock, Algerian Hip-Hop, Alt-Country, Alte, Alternative, Alternative Country, Alternative Folk, Alternative Hip-Hop, Alternative Metal, Alternative R&B, Alternative Rap, Alternative Rock, Alt-Pop, Amapiano, Ambient, Ambient Drone, Ambient Folk, Ambient House, Ambient Noise, Americana, ... (692 total)
