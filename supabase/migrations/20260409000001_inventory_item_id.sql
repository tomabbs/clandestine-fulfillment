-- Add shopify_inventory_item_id column if it doesn't already exist (may have been added manually).
-- This normalizes the schema so the column is tracked in migrations.
ALTER TABLE warehouse_product_variants
  ADD COLUMN IF NOT EXISTS shopify_inventory_item_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_inventory_item_id
  ON warehouse_product_variants(shopify_inventory_item_id)
  WHERE shopify_inventory_item_id IS NOT NULL;

-- Index for seed script Package ID lookups
CREATE INDEX IF NOT EXISTS idx_bandcamp_mappings_item_id
  ON bandcamp_product_mappings(workspace_id, bandcamp_item_id);
