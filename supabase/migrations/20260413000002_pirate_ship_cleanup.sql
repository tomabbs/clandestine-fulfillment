-- Phase 1 cleanup: delete stale review queue items + backfill bandcamp_payment_id
-- Run dry-run count first:
-- SELECT count(*) FROM warehouse_shipments s
-- JOIN warehouse_orders o ON s.order_id = o.id
-- WHERE o.bandcamp_payment_id IS NOT NULL AND s.bandcamp_payment_id IS NULL;

-- 1. Delete review queue items from prior broken PS imports
DELETE FROM warehouse_review_queue
WHERE category = 'pirate_ship_unmatched_org';

-- 2. Backfill bandcamp_payment_id on shipments already linked to orders
UPDATE warehouse_shipments s
SET bandcamp_payment_id = o.bandcamp_payment_id
FROM warehouse_orders o
WHERE s.order_id = o.id
  AND o.bandcamp_payment_id IS NOT NULL
  AND s.bandcamp_payment_id IS NULL;
