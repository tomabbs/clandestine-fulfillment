-- Add product category classification to bandcamp_product_mappings.
-- Separates album formats (vinyl/cd/cassette) from non-album merch
-- (apparel/merch/bundle/other) for accurate scraper coverage metrics.

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS product_category text
  CHECK (product_category IN ('vinyl', 'cd', 'cassette', 'apparel', 'merch', 'bundle', 'other'));

COMMENT ON COLUMN bandcamp_product_mappings.product_category IS
  'Product type: vinyl/cd/cassette (album formats), apparel/merch (non-album), bundle, other';

CREATE INDEX IF NOT EXISTS idx_mappings_product_category
  ON bandcamp_product_mappings(product_category)
  WHERE product_category IS NOT NULL;
