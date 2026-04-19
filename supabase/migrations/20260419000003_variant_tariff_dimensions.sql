-- Phase 0.5.6 — Per-variant parcel dimensions on warehouse_product_variants.
--
-- Asendia weight tiers cap at 4.4 lbs but rates are also dim-weight sensitive
-- (a wide flat package costs more than a compact box at the same weight).
-- Without per-variant dimensions, the EP shipment falls back to the hardcoded
-- 13×13×2 default in easypost-client.ts which is right for one LP but wrong
-- for a 7" single, a CD, or a multi-LP box set.
--
-- All three are nullable; createShipment falls back to defaults when unset.
--
-- Phase 0.5.5 also covered here: hs_tariff_code already exists (added in
-- 20260325000001_v72_schema_updates.sql line 213) — no schema change needed,
-- just a backfill via scripts/backfill-hs-codes.ts.

ALTER TABLE warehouse_product_variants
  ADD COLUMN IF NOT EXISTS length_in numeric,
  ADD COLUMN IF NOT EXISTS width_in numeric,
  ADD COLUMN IF NOT EXISTS height_in numeric;

COMMENT ON COLUMN warehouse_product_variants.length_in IS
  'Phase 0.5.6 — parcel length in inches. Aggregator takes MAX across items in a shipment when computing the parcel; falls back to 13in default in easypost-client.ts when NULL.';
COMMENT ON COLUMN warehouse_product_variants.width_in IS
  'Phase 0.5.6 — parcel width in inches. Falls back to 13in default when NULL.';
COMMENT ON COLUMN warehouse_product_variants.height_in IS
  'Phase 0.5.6 — parcel height in inches. Falls back to 2in default when NULL.';

-- Optional per-line override for customs descriptions (Phase 0.5.4).
-- Catalog title may not match what customs needs (e.g., title "Solitude in Madrid"
-- needs to be declared as "Vinyl Record - 1 piece").
ALTER TABLE warehouse_shipment_items
  ADD COLUMN IF NOT EXISTS customs_description text;

COMMENT ON COLUMN warehouse_shipment_items.customs_description IS
  'Phase 0.5.4 — optional override for the customs declaration description on this line item. NULL = use product title.';
