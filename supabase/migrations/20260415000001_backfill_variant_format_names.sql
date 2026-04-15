-- Migration: Backfill warehouse_product_variants.format_name
-- Safe: only touches rows WHERE format_name IS NULL.
--
-- Root cause: shopify-sync writes product.productType to warehouse_products.product_type
-- but does NOT write format_name to warehouse_product_variants. This migration fixes the
-- historical data gap for all existing variants.
--
-- Tier 1 (SKU prefix) runs first — deterministic, prevents a generic product_type like
-- "Merch" from overwriting the correct SKU-derived format.
-- Tier 2 (product_type alias mapping) applies to any remaining NULLs. It uses an explicit
-- CASE map so that Shopify free-text types ("12\" Vinyl", "7\" Vinyl", etc.) are normalized
-- to the keys in warehouse_format_costs. Ambiguous or unknown types are left NULL and will
-- show the amber partial indicator at runtime.
--
-- Aliases determined from live product_type distribution query (2026-04-15):
--   "12\" Vinyl" → LP  (490 products — largest group)
--   "Cassette"   → Cassette (230 — exact match)
--   "CD"         → CD (151 — exact match)
--   "7\" Vinyl"  → 7"  (27)
--   "CDR"        → CD  (19)
--   "2x 12\" Vinyl" → LP (18)
--   "LP"         → LP  (9 — exact match)
--   "Vinyl LP"   → LP  (6)
--   "2x CD"      → CD  (5)
--   "2x Cassette"→ Cassette (3)
--   "T-Shirt/Apparel" → T-Shirt (3)
--   "Magazine"   → Other (2)
--   "2xCD"       → CD  (2)
--   "Cassette,"  → Cassette (2, trailing-comma typo in Shopify)
--   "Shirt"      → T-Shirt (1)
--   "2 x Vinyl LP"→ LP (1)
--   Intentionally left NULL (amber dot): "Merch", "CD, Vinyl", "Flexidisc",
--   "10\" Vinyl", "CDR + Zine", "Bag", "Zine", "Sweater/Hoodie", "Other Apparel",
--   "All Genre Long-Sleeve", "TREE MUSIC TEE", "Tulip or Turnip CD",
--   "12\" Vinyl + 7\" Vinyl", "2x 12\" Vinyl + something" — all genuinely ambiguous.
--
-- Does not touch any inventory write path (Rule #20).

-- Tier 1: SKU-prefix patterns (deterministic, no product_type ambiguity).
-- Mirrors SKU_PREFIX_RULES in src/trigger/lib/format-detection.ts.
UPDATE warehouse_product_variants
SET format_name = CASE
  WHEN sku ILIKE 'LP-%'  OR sku ILIKE '2XLP-%' THEN 'LP'
  WHEN sku ILIKE 'CD-%'                         THEN 'CD'
  WHEN sku ILIKE 'CS-%'  OR sku ILIKE 'TB-%'   THEN 'Cassette'
  WHEN sku ILIKE '7IN-%' OR sku ILIKE 'SI-%'   THEN '7"'
  WHEN sku ILIKE 'TS-%'                         THEN 'T-Shirt'
  WHEN sku ILIKE 'MAG-%' OR sku ILIKE 'EB-%'   THEN 'Other'
END
WHERE format_name IS NULL
  AND (
    sku ILIKE 'LP-%'  OR sku ILIKE '2XLP-%'
    OR sku ILIKE 'CD-%'
    OR sku ILIKE 'CS-%' OR sku ILIKE 'TB-%'
    OR sku ILIKE '7IN-%' OR sku ILIKE 'SI-%'
    OR sku ILIKE 'TS-%'
    OR sku ILIKE 'MAG-%' OR sku ILIKE 'EB-%'
  );

-- Tier 2: product_type alias mapping for remaining NULLs (no SKU-prefix match).
-- Uses an explicit CASE so Shopify free-text types are normalized to valid format cost keys.
-- Values not in the CASE map are left NULL (correctly → amber dot at runtime).
UPDATE warehouse_product_variants wpv
SET format_name = CASE wp.product_type
  -- LP / vinyl formats
  WHEN 'LP'              THEN 'LP'
  WHEN '12" Vinyl'       THEN 'LP'
  WHEN '2x 12" Vinyl'    THEN 'LP'
  WHEN 'Vinyl LP'        THEN 'LP'
  WHEN '2 x Vinyl LP'    THEN 'LP'
  -- CD formats
  WHEN 'CD'              THEN 'CD'
  WHEN 'CDR'             THEN 'CD'
  WHEN '2x CD'           THEN 'CD'
  WHEN '2xCD'            THEN 'CD'
  -- Cassette formats
  WHEN 'Cassette'        THEN 'Cassette'
  WHEN '2x Cassette'     THEN 'Cassette'
  WHEN 'Cassette,'       THEN 'Cassette'
  -- 7" single
  WHEN '7" Vinyl'        THEN '7"'
  -- Apparel
  WHEN 'T-Shirt/Apparel' THEN 'T-Shirt'
  WHEN 'Shirt'           THEN 'T-Shirt'
  -- Other / merch
  WHEN 'Magazine'        THEN 'Other'
  WHEN 'Other'           THEN 'Other'
END
FROM warehouse_products wp
WHERE wpv.product_id = wp.id
  AND wpv.format_name IS NULL
  AND wp.product_type IN (
    'LP', '12" Vinyl', '2x 12" Vinyl', 'Vinyl LP', '2 x Vinyl LP',
    'CD', 'CDR', '2x CD', '2xCD',
    'Cassette', '2x Cassette', 'Cassette,',
    '7" Vinyl',
    'T-Shirt/Apparel', 'Shirt',
    'Magazine', 'Other'
  );
