-- Phase 1: Pirate Ship tracking dedup + label_source backfill
-- Prerequisite: run the PRE-MIGRATION DIAGNOSTIC query below manually first and
-- capture the output to verify backfill coverage:
--
-- SELECT
--   label_source,
--   label_data->>'source' AS label_data_source,
--   CASE WHEN shipstation_shipment_id IS NOT NULL THEN 'has_ss_id' ELSE 'no_ss_id' END AS ss_id_status,
--   count(*) AS row_count
-- FROM warehouse_shipments
-- GROUP BY 1, 2, 3
-- ORDER BY 4 DESC;

-- 1. Backfill label_source for existing PS rows identified by label_data
UPDATE warehouse_shipments
SET label_source = 'pirate_ship'
WHERE label_data->>'source' = 'pirate_ship'
  AND (label_source IS NULL OR label_source != 'pirate_ship');

-- 2. Dedup existing PS rows (keep most recent by created_at)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY workspace_id, tracking_number
    ORDER BY created_at DESC
  ) AS rn
  FROM warehouse_shipments
  WHERE label_source = 'pirate_ship'
    AND tracking_number IS NOT NULL
)
DELETE FROM warehouse_shipments
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. Partial unique index scoped to Pirate Ship only.
-- Scoped to label_source = 'pirate_ship' to avoid interfering with
-- ShipStation's upsert on (workspace_id, shipstation_shipment_id).
-- PostgREST upsert() cannot use partial unique indexes (PGRST116),
-- so application-level pre-check + 23505 catch is the primary defense.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_ps_tracking
  ON warehouse_shipments(workspace_id, tracking_number)
  WHERE label_source = 'pirate_ship' AND tracking_number IS NOT NULL;
