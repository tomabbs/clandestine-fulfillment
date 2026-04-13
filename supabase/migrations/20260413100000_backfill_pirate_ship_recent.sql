-- Backfill warehouse_shipments for Pirate Ship labels from the last 30 days:
--   0) Ensure warehouse_orders.shipping_cost exists (referenced by app + ShipStation poll)
--   1) customer_shipping_charged from linked warehouse_orders.shipping_cost when set
--   2) total_units from SUM(warehouse_shipment_items.quantity)
--
-- Idempotent: only fills NULL/zero where source data exists.
-- Window: ship_date >= today-30d, or if ship_date is null then created_at >= now()-30d.

ALTER TABLE warehouse_orders
  ADD COLUMN IF NOT EXISTS shipping_cost numeric(10, 2);

COMMENT ON COLUMN warehouse_orders.shipping_cost IS
  'Customer-paid shipping amount from channel (e.g. Bandcamp API); used for margin vs label postage.';

-- 1) What the customer paid for shipping (when stored on the order row)
UPDATE warehouse_shipments s
SET customer_shipping_charged = ROUND(o.shipping_cost::numeric, 2)
FROM warehouse_orders o
WHERE s.order_id = o.id
  AND s.label_source = 'pirate_ship'
  AND s.customer_shipping_charged IS NULL
  AND o.shipping_cost IS NOT NULL
  AND (
    (s.ship_date IS NOT NULL AND s.ship_date >= (CURRENT_DATE - INTERVAL '30 days'))
    OR (s.ship_date IS NULL AND s.created_at >= (NOW() - INTERVAL '30 days'))
  );

-- 2) Physical units shipped (line items)
UPDATE warehouse_shipments s
SET total_units = agg.u
FROM (
  SELECT shipment_id, COALESCE(SUM(quantity), 0)::integer AS u
  FROM warehouse_shipment_items
  GROUP BY shipment_id
) agg
WHERE s.id = agg.shipment_id
  AND s.label_source = 'pirate_ship'
  AND COALESCE(s.total_units, 0) = 0
  AND agg.u > 0
  AND (
    (s.ship_date IS NOT NULL AND s.ship_date >= (CURRENT_DATE - INTERVAL '30 days'))
    OR (s.ship_date IS NULL AND s.created_at >= (NOW() - INTERVAL '30 days'))
  );
