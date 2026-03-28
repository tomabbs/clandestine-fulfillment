-- Migration: Bandcamp scraper pre-requisites
-- Must be applied before any scraper code ships.
--
-- Confirmed required by schema audit:
-- 1. warehouse_product_images has only `id uuid PRIMARY KEY` — no uniqueness on (product_id, src)
-- 2. bandcamp_product_mappings missing url_source, release_date, is_preorder, art_url columns

-- 1. Add (product_id, src) unique constraint to warehouse_product_images.
--    Without this, ON CONFLICT DO NOTHING in any image migration is a no-op
--    and concurrent scraper runs can insert duplicate rows.
ALTER TABLE warehouse_product_images
  ADD CONSTRAINT uq_product_images_product_src UNIQUE (product_id, src);

-- 2. Add bandcamp_url_source — tracks confidence so lower-confidence sources
--    never overwrite higher-confidence ones.
--    Confidence order: scraper_verified > orders_api > manual > constructed
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_url_source text
    CHECK (bandcamp_url_source IN ('orders_api', 'constructed', 'manual', 'scraper_verified'));

-- 3. Add bandcamp_image_url if not present (API-fetched thumbnail from get_merch_details,
--    separate from scraped full-res images from data-tralbum).
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_image_url text;

-- 4. New columns populated by the scraper from data-tralbum JSON.
--    Confirmed field names from live page audit (2026-03-29):
--    - bandcamp_release_date: from current.release_date (GMT string parsed to timestamptz)
--    - bandcamp_is_preorder:  from is_preorder || album_is_preorder boolean flags
--    - bandcamp_art_url:      album art at 1200px from https://f4.bcbits.com/img/a{art_id}_10.jpg
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_release_date  timestamptz,
  ADD COLUMN IF NOT EXISTS bandcamp_is_preorder   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS bandcamp_art_url       text;

NOTIFY pgrst, 'reload schema';
