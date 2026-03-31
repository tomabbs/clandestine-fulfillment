-- ============================================================
-- Bandcamp metadata fields: about, credits, UPC, tracks
-- 2026-03-31
--
-- warehouse_products:
--   description_html  — editable product description; populated from
--                        Bandcamp "about" + tracklist + credits only when
--                        currently NULL or empty. Staff edits are preserved
--                        via DB-side WHERE guard.
--   bandcamp_upc      — album-level UPC/EAN from data-tralbum.current.upc.
--                        Stored separately from warehouse_product_variants.barcode
--                        (per-format physical barcode). Also written to
--                        variant.barcode when that field is empty.
--
-- bandcamp_product_mappings:
--   bandcamp_about    — raw "about" text from data-tralbum.current.about.
--                        Source of truth; always updated on re-scrape.
--   bandcamp_credits  — raw "credits" from data-tralbum.current.credits.
--                        Display on admin/portal product detail (future PR).
--   bandcamp_tracks   — JSONB array from data-tralbum.trackinfo.
--                        Each row: {track_num, title, duration (seconds)}.
-- ============================================================

ALTER TABLE warehouse_products
  ADD COLUMN IF NOT EXISTS description_html text,
  ADD COLUMN IF NOT EXISTS bandcamp_upc     text;

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_about   text,
  ADD COLUMN IF NOT EXISTS bandcamp_credits text,
  ADD COLUMN IF NOT EXISTS bandcamp_tracks  jsonb;
