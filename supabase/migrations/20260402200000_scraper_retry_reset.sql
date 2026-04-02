-- Reset stuck scraper items for retry with improved URL construction logic.
--
-- Root cause: buildBandcampAlbumUrl was fed format names ("CD", "12\" Vinyl",
-- "Limited Edition Colored Cassette") instead of album titles, producing 404s.
-- 423 items hit the failure cap (5) and are permanently excluded from sweep.
--
-- This migration:
-- 1. Clears bad constructed URLs so the improved extractAlbumTitle can retry
-- 2. Resets failure counts
-- 3. Bulk-suppresses the duplicate 404-constructed review queue items
-- 4. Resets items that were scraped before metadata fields were added

-- 1. Clear constructed URLs that 404'd (all 423 stuck items have url_source='constructed')
--    Setting bandcamp_url back to NULL puts them back into Group 2 sweep scope
--    where the new extractAlbumTitle logic will either construct a better URL or skip gracefully.
UPDATE bandcamp_product_mappings
SET bandcamp_url = NULL,
    bandcamp_url_source = NULL,
    scrape_failure_count = 0,
    updated_at = now()
WHERE bandcamp_url_source = 'constructed'
  AND bandcamp_type_name IS NULL
  AND scrape_failure_count >= 5;

-- 2. Reset failure counts for any remaining items with low failure counts
--    (in case some were partially stuck)
UPDATE bandcamp_product_mappings
SET scrape_failure_count = 0,
    updated_at = now()
WHERE scrape_failure_count > 0
  AND scrape_failure_count < 5
  AND bandcamp_type_name IS NULL;

-- 3. Items with type_name but missing about/credits (scraped before metadata fields added)
--    Reset failure count so Group 3 sweep picks them up for re-scrape
UPDATE bandcamp_product_mappings
SET scrape_failure_count = 0,
    updated_at = now()
WHERE bandcamp_type_name IS NOT NULL
  AND bandcamp_about IS NULL
  AND bandcamp_url IS NOT NULL;

-- 4. Bulk-suppress the duplicate "Constructed Bandcamp URL returned 404" review queue items
--    These are all the same root cause (bad slug construction); keeping them open
--    just creates noise. The sweep will generate new, accurate review items if needed.
UPDATE warehouse_review_queue
SET status = 'suppressed',
    resolved_at = now(),
    updated_at = now()
WHERE category = 'bandcamp_scraper'
  AND status = 'open'
  AND (
    title LIKE 'Constructed Bandcamp URL returned 404%'
    OR title LIKE 'Bandcamp fetch error HTTP 404%'
  );

-- 5. Also suppress the "no subdomain" items — these will be re-created by the sweep
--    with fresh occurrence counts if still unresolvable.
UPDATE warehouse_review_queue
SET status = 'suppressed',
    resolved_at = now(),
    updated_at = now()
WHERE category = 'bandcamp_scraper'
  AND status = 'open'
  AND title LIKE 'Cannot construct Bandcamp URL%';
