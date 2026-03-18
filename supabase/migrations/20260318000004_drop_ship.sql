-- Add drop-ship support columns

-- Flag on store mapping to identify drop-ship stores
ALTER TABLE warehouse_shipstation_stores ADD COLUMN IF NOT EXISTS is_drop_ship boolean DEFAULT false;

-- Flag on shipment to indicate drop-ship billing
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS is_drop_ship boolean DEFAULT false;

-- Total units in shipment (for drop-ship per-unit billing)
ALTER TABLE warehouse_shipments ADD COLUMN IF NOT EXISTS total_units integer DEFAULT 0;
