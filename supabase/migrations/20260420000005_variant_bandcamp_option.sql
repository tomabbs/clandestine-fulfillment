-- Phase A (Apparel multi-variant): per-variant Bandcamp option attribution.
--
-- Context:
--   `bandcamp_product_mappings` is keyed by (workspace_id, bandcamp_item_id) UNIQUE
--   (migration 20260419000001), so per-option mappings cannot live there. To support
--   per-size apparel variants flowing through DB + Shopify + downstream sync flows,
--   we attach the Bandcamp option attribution directly to each variant row.
--
-- Forward-only: existing umbrella variants stay NULL on these columns. Path B/C
-- backfill will populate them per product as Shopify option restructure happens.

ALTER TABLE warehouse_product_variants
  ADD COLUMN IF NOT EXISTS bandcamp_option_id bigint,
  ADD COLUMN IF NOT EXISTS bandcamp_option_title text;

-- Lookup index: package + option-id → variant. Partial to avoid bloating with NULLs.
CREATE INDEX IF NOT EXISTS idx_variants_bandcamp_option
  ON warehouse_product_variants (workspace_id, bandcamp_option_id)
  WHERE bandcamp_option_id IS NOT NULL;

COMMENT ON COLUMN warehouse_product_variants.bandcamp_option_id IS
  'Phase A — Bandcamp option_id this variant represents (e.g. one size of a shirt). NULL for non-Bandcamp variants and umbrella variants from before the multi-variant patch.';
COMMENT ON COLUMN warehouse_product_variants.bandcamp_option_title IS
  'Phase A — Bandcamp option title (e.g. "Small", "XL") preserved for fulfillment / sale-poll matching when the warehouse option1_value diverges.';
