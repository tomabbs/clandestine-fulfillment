-- Fix: variant_id needs UNIQUE constraint for upsert ON CONFLICT to work.
-- The original migration (20260316000007) only created an INDEX, not UNIQUE.
-- Supabase .upsert({ onConflict: "variant_id" }) silently fails without this.
-- Preflight confirmed 0 duplicate variant_id rows (2026-04-03).

DROP INDEX IF EXISTS idx_bandcamp_mappings_variant;

ALTER TABLE bandcamp_product_mappings
  ADD CONSTRAINT uq_bandcamp_mappings_variant_id UNIQUE (variant_id);
