-- Migration: Add format_name_override to warehouse_shipment_items
--
-- Purpose: Allow staff to manually assign a format to shipment items whose SKU cannot be
-- resolved automatically (e.g. Squarespace placeholder IDs like SQ6720646 that never exist
-- in warehouse_product_variants). The override is stored per item row so it:
--   1. Never pollutes warehouse_product_variants with fake SKUs.
--   2. Is revocable — clearing the override reverts to automatic resolution.
--   3. Is auditable — tied to a specific shipment item, not a global catalog entry.
--
-- The cost engine (batchBuildFormatCostMaps) reads this column with the highest priority:
-- override → format_name on variant → product_type FK fallback → title keyword extraction
-- → title fuzzy match → unknownSkus (amber dot).

ALTER TABLE warehouse_shipment_items
  ADD COLUMN IF NOT EXISTS format_name_override text;
