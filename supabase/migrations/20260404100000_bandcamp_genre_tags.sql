-- Genre tags: capture Bandcamp tags from HTML scraping for genre intelligence
-- Plan: genre_tags_+_trending_ed4bd2c7.plan.md (v4)

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_tags text[],
  ADD COLUMN IF NOT EXISTS bandcamp_tag_norms text[],
  ADD COLUMN IF NOT EXISTS bandcamp_primary_genre text,
  ADD COLUMN IF NOT EXISTS bandcamp_tralbum_id bigint,
  ADD COLUMN IF NOT EXISTS bandcamp_tags_fetched_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_bandcamp_mappings_genre
  ON bandcamp_product_mappings (bandcamp_primary_genre)
  WHERE bandcamp_primary_genre IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bandcamp_mappings_tag_norms
  ON bandcamp_product_mappings USING GIN (bandcamp_tag_norms)
  WHERE bandcamp_tag_norms IS NOT NULL;
