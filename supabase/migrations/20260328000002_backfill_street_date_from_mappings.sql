-- Migration: Backfill street_date on warehouse_product_variants from bandcamp_product_mappings
--
-- The bandcamp-scrape-page task writes releaseDate to bandcamp_product_mappings.bandcamp_new_date
-- and then propagates it to warehouse_product_variants.street_date, but only for variants
-- that had no street_date at the time the scrape ran. Over time, 182 variants have a mapping
-- with bandcamp_new_date but no corresponding street_date on the variant.
--
-- This migration does a one-time backfill. Safe to re-run (WHERE clause is idempotent).

UPDATE warehouse_product_variants wpv
SET
  street_date = bpm.bandcamp_new_date,
  updated_at  = now()
FROM bandcamp_product_mappings bpm
WHERE bpm.variant_id     = wpv.id
  AND bpm.bandcamp_new_date IS NOT NULL
  AND wpv.street_date    IS NULL;

-- Also mark is_preorder=true for any variant whose newly-set street_date is in the future.
UPDATE warehouse_product_variants
SET
  is_preorder = true,
  updated_at  = now()
WHERE street_date > now()
  AND is_preorder = false;
