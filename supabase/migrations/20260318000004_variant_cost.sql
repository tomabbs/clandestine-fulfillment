-- Add cost column to warehouse_product_variants.
-- Stores the wholesale/production cost per unit (for margin calculations).
ALTER TABLE warehouse_product_variants ADD COLUMN IF NOT EXISTS cost numeric;
