-- ============================================================
-- Shipping log hardening: dedup prevention + field capture + label source
-- Run AFTER scripts/dedup-shipments.sql or the UNIQUE constraint will fail.
-- 2026-04-02
-- ============================================================

-- 1. Standard UNIQUE constraint — prevents future duplicates.
--    Using a standard constraint (not a partial index) because Supabase's
--    .upsert() targets the constraint via ON CONFLICT (...); PostgREST cannot
--    append a WHERE predicate for a partial index, causing PGRST116 errors.
--    Postgres allows multiple NULLs under UNIQUE, so non-ShipStation rows
--    (shipstation_shipment_id IS NULL) coexist safely.
DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_shipments_ss_id'
  ) THEN
    ALTER TABLE warehouse_shipments
      ADD CONSTRAINT uq_shipments_ss_id
      UNIQUE (workspace_id, shipstation_shipment_id);
  END IF;
END $c$;

-- 2. Store ShipStation's original order number for display and auto-linking.
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS ss_order_number text;

CREATE INDEX IF NOT EXISTS idx_shipments_ss_order_number
  ON warehouse_shipments(ss_order_number)
  WHERE ss_order_number IS NOT NULL;

-- 3. Store when the ShipStation label was created (distinct from ship_date).
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS ss_create_date timestamptz;

-- 4. item_index on warehouse_shipment_items for safe idempotent upsert.
--    Allows same SKU to appear twice in one shipment (different variants/options).
ALTER TABLE warehouse_shipment_items
  ADD COLUMN IF NOT EXISTS item_index integer NOT NULL DEFAULT 0;

DO $c$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_shipment_items_idx'
  ) THEN
    ALTER TABLE warehouse_shipment_items
      ADD CONSTRAINT uq_shipment_items_idx
      UNIQUE (shipment_id, sku, item_index);
  END IF;
END $c$;

-- 5. customer_shipping_charged — what the customer paid for shipping.
--    Enables margin analysis: charged vs. shipping_cost (what we paid for postage).
--    Sources (priority order):
--      1. warehouse_orders.shipping_cost (Bandcamp, from Bandcamp API, most authoritative)
--      2. ShipStation /orders shippingAmount (bulk pre-fetched at poll start)
--      3. Future: platform API at label creation time
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS customer_shipping_charged numeric(10, 2);

-- 6. label_source — tracks how each shipping label was created.
--    Enables routing follow-up questions to the right system and billing audits.
--    Add nullable first, backfill, then enforce NOT NULL.
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS label_source text
  CHECK (label_source IN ('shipstation', 'easypost', 'pirate_ship', 'manual'));

UPDATE warehouse_shipments
  SET label_source = 'shipstation'
  WHERE shipstation_shipment_id IS NOT NULL AND label_source IS NULL;

UPDATE warehouse_shipments
  SET label_source = 'manual'
  WHERE label_source IS NULL;

ALTER TABLE warehouse_shipments
  ALTER COLUMN label_source SET NOT NULL;

ALTER TABLE warehouse_shipments
  ALTER COLUMN label_source SET DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_shipments_label_source
  ON warehouse_shipments(label_source);
