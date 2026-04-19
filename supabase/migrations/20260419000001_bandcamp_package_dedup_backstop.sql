-- Backstop against Bandcamp package-level duplicate mappings.
-- Keep newest mapping row per (workspace_id, bandcamp_item_id), then enforce uniqueness.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, bandcamp_item_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC, id DESC
    ) AS rn
  FROM bandcamp_product_mappings
  WHERE bandcamp_item_id IS NOT NULL
)
DELETE FROM bandcamp_product_mappings bpm
USING ranked r
WHERE bpm.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bandcamp_mappings_workspace_item_id
  ON bandcamp_product_mappings (workspace_id, bandcamp_item_id)
  WHERE bandcamp_item_id IS NOT NULL;
