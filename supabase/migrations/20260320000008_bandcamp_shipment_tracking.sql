-- Bandcamp order + shipment tracking integration
-- bandcamp_payment_id on warehouse_orders: links Bandcamp orders we ingest via get_orders
-- bandcamp_payment_id on warehouse_shipments: used to call update_shipped with carrier + tracking
ALTER TABLE warehouse_orders ADD COLUMN IF NOT EXISTS bandcamp_payment_id bigint;
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS bandcamp_payment_id bigint;
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS bandcamp_synced_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_orders_bandcamp_payment ON warehouse_orders(bandcamp_payment_id) WHERE bandcamp_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_bandcamp_payment ON warehouse_shipments(bandcamp_payment_id) WHERE bandcamp_payment_id IS NOT NULL;
