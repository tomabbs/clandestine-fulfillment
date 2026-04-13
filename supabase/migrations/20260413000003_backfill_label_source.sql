-- Phase 3: Backfill label_source for all existing shipments
-- This covers ShipStation and EasyPost rows not already handled by the PS-specific
-- migration (20260413000001_pirate_ship_dedup.sql).

UPDATE warehouse_shipments
SET label_source = 'shipstation'
WHERE shipstation_shipment_id IS NOT NULL
  AND (label_source IS NULL OR label_source = '');

UPDATE warehouse_shipments
SET label_source = 'easypost'
WHERE label_data->>'easypost_shipment_id' IS NOT NULL
  AND (label_source IS NULL OR label_source = '');

UPDATE warehouse_shipments
SET label_source = 'manual'
WHERE label_source IS NULL OR label_source = '';
