-- Expand bandcamp_url_source check constraint to include 'sales_crossref' and 'manual'.
-- The crossref function now writes 'sales_crossref' instead of 'orders_api',
-- and the new manual URL entry writes 'manual'.

-- Drop the existing constraint
ALTER TABLE bandcamp_product_mappings
  DROP CONSTRAINT IF EXISTS bandcamp_product_mappings_bandcamp_url_source_check;

-- Re-create with expanded values
ALTER TABLE bandcamp_product_mappings
  ADD CONSTRAINT bandcamp_product_mappings_bandcamp_url_source_check
  CHECK (bandcamp_url_source IS NULL OR bandcamp_url_source IN (
    'scraper_verified', 'constructed', 'orders_api', 'sales_crossref', 'manual'
  ));
