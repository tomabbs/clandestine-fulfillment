-- ============================================================
-- SHIPMENT DEDUPLICATION SCRIPT
-- Run in Supabase SQL Editor BEFORE applying the migration.
-- ============================================================
-- STEP 1a: Preview duplicates and item counts — review before proceeding.
SELECT
  ws.shipstation_shipment_id,
  ws.workspace_id,
  COUNT(DISTINCT ws.id) AS shipment_copies,
  COALESCE(SUM(item_counts.cnt), 0) AS total_item_rows
FROM warehouse_shipments ws
LEFT JOIN (
  SELECT shipment_id, COUNT(*) AS cnt
  FROM warehouse_shipment_items
  GROUP BY shipment_id
) item_counts ON item_counts.shipment_id = ws.id
WHERE ws.shipstation_shipment_id IS NOT NULL
GROUP BY ws.shipstation_shipment_id, ws.workspace_id
HAVING COUNT(DISTINCT ws.id) > 1
ORDER BY total_item_rows DESC
LIMIT 20;

-- ============================================================
-- STEP 1b: Merge + delete duplicates.
-- Uses temp tables so all three statements can reference the same data.
-- (CTEs are only scoped to the single statement they prefix — temp tables persist
-- for the duration of the transaction.)
-- ============================================================
BEGIN;

CREATE TEMP TABLE _ranked AS
SELECT
  ws.id,
  ws.workspace_id,
  ws.shipstation_shipment_id,
  ws.created_at,
  (CASE WHEN ws.order_id IS NOT NULL THEN 100 ELSE 0 END)
  + (CASE WHEN ws.org_id IS NOT NULL THEN 10 ELSE 0 END)
  + (CASE WHEN ws.tracking_number IS NOT NULL THEN 5 ELSE 0 END)
  + (CASE WHEN ws.label_data IS NOT NULL THEN 5 ELSE 0 END)
  + COALESCE((
      SELECT COUNT(*)::int FROM warehouse_shipment_items wsi
      WHERE wsi.shipment_id = ws.id
    ), 0) * 2
  AS richness_score
FROM warehouse_shipments ws
WHERE ws.shipstation_shipment_id IS NOT NULL;

CREATE TEMP TABLE _keepers AS
SELECT DISTINCT ON (workspace_id, shipstation_shipment_id)
  id AS keeper_id, workspace_id, shipstation_shipment_id
FROM _ranked
ORDER BY workspace_id, shipstation_shipment_id, richness_score DESC, created_at DESC;

CREATE TEMP TABLE _duplicates AS
SELECT ws.id AS dup_id, k.keeper_id
FROM warehouse_shipments ws
JOIN _keepers k
  ON ws.workspace_id = k.workspace_id
  AND ws.shipstation_shipment_id = k.shipstation_shipment_id
WHERE ws.id != k.keeper_id;

-- Step A: Merge fields from richest duplicate into keeper (fill nulls only).
-- NOTE: ss_order_number excluded — column doesn't exist until Script 2 migration.
UPDATE warehouse_shipments keeper_row
SET
  order_id        = COALESCE(keeper_row.order_id,        dup_row.order_id),
  org_id          = COALESCE(keeper_row.org_id,          dup_row.org_id),
  tracking_number = COALESCE(keeper_row.tracking_number, dup_row.tracking_number),
  label_data      = COALESCE(keeper_row.label_data,      dup_row.label_data)
FROM (
  SELECT DISTINCT ON (d.keeper_id)
    d.keeper_id, ws.order_id, ws.org_id, ws.tracking_number, ws.label_data
  FROM _duplicates d
  JOIN warehouse_shipments ws ON ws.id = d.dup_id
  JOIN _ranked r ON r.id = d.dup_id
  ORDER BY d.keeper_id, r.richness_score DESC
) dup_row
WHERE keeper_row.id = dup_row.keeper_id;

-- Step B: Move items from duplicates to keeper (dedupes on SKU only —
-- item_index doesn't exist yet; next poll re-ingests with correct item_index).
UPDATE warehouse_shipment_items wsi
SET shipment_id = d.keeper_id
FROM _duplicates d
WHERE wsi.shipment_id = d.dup_id
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_shipment_items existing
    WHERE existing.shipment_id = d.keeper_id
      AND existing.sku = wsi.sku
  );

-- Step C: Delete duplicate rows (remaining orphaned items cascade-delete).
DELETE FROM warehouse_shipments
WHERE id IN (SELECT dup_id FROM _duplicates);

DROP TABLE _ranked, _keepers, _duplicates;

COMMIT;

-- ============================================================
-- STEP 1c: Verify — both should return 0 rows.
-- ============================================================
SELECT shipstation_shipment_id, COUNT(*) AS cnt
FROM warehouse_shipments
WHERE shipstation_shipment_id IS NOT NULL
GROUP BY shipstation_shipment_id, workspace_id
HAVING COUNT(*) > 1;

SELECT COUNT(*) AS total_items FROM warehouse_shipment_items;
