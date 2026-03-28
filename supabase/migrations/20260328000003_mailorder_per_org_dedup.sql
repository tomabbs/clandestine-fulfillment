-- Migration: Fix mailorder_orders dedup key to support one row per org per order.
--
-- Root cause: The original UNIQUE(workspace_id, source, external_order_id) constraint
-- prevented creating multiple rows for the same Shopify/Discogs order. But a single
-- Clandestine Shopify order may contain products from multiple client orgs, each
-- needing their own payout row.
--
-- New model: one mailorder_orders row per (order × org). The sync task now groups
-- line items by org_id and inserts/upserts one row per org.
--
-- Existing data is cleared so the sync can re-import correctly with the new logic.
-- The mailorder-shopify-sync cursor is also reset so it re-processes all paid orders.

-- 1. Drop old constraint
ALTER TABLE mailorder_orders
  DROP CONSTRAINT IF EXISTS mailorder_orders_workspace_id_source_external_order_id_key;

-- 2. Add new composite unique constraint
ALTER TABLE mailorder_orders
  ADD CONSTRAINT mailorder_orders_dedup
  UNIQUE (workspace_id, source, external_order_id, org_id);

-- 3. Clear existing incorrectly-attributed data so the sync re-imports cleanly.
--    The sync cursor reset (step 4) ensures full re-import of all paid orders.
DELETE FROM mailorder_orders;

-- 4. Reset the mailorder sync cursor so the next cron run re-imports all paid orders.
DELETE FROM warehouse_sync_state WHERE sync_type = 'mailorder_shopify';

NOTIFY pgrst, 'reload schema';
