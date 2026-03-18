-- Step 4: Add bandcamp_image_url column
ALTER TABLE bandcamp_product_mappings ADD COLUMN IF NOT EXISTS bandcamp_image_url text;

-- Step 5: Unique index for image upsert on shopify_image_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_wpi_shopify_image_id
  ON warehouse_product_images(shopify_image_id)
  WHERE shopify_image_id IS NOT NULL;
