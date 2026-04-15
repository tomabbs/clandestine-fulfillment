-- ============================================================
-- Fix chk_shipment_source: relax XOR → anti-dual
-- 2026-04-15
--
-- Problem:
--   The original constraint required exactly ONE of order_id /
--   mailorder_id to be set (XOR). This blocked three legitimate
--   use-cases that insert with both FK columns NULL:
--     • pirate-ship-import Tier 3 (alias-only matches)
--     • shipstation-poll Step A (order linked in a later step)
--     • future unlinked/manual shipments
--
-- Fix:
--   Replace with an anti-dual constraint that only forbids having
--   BOTH FK columns set simultaneously:
--     NOT (order_id IS NOT NULL AND mailorder_id IS NOT NULL)
--
-- Truth table:
--   order_id=NULL, mailorder_id=NULL → ✅ (allowed — unlinked)
--   order_id=SET,  mailorder_id=NULL → ✅ (fulfillment order)
--   order_id=NULL, mailorder_id=SET  → ✅ (mail order)
--   order_id=SET,  mailorder_id=SET  → ❌ (invalid dual-link)
--
-- Idempotency:
--   DROP CONSTRAINT IF EXISTS handles the case where the old
--   constraint doesn't exist. The DO $$ IF NOT EXISTS $$ block
--   prevents duplicate ADD CONSTRAINT on concurrent runs.
-- ============================================================

BEGIN;

-- Drop old XOR constraint (and any partial new name from prior run)
ALTER TABLE warehouse_shipments
  DROP CONSTRAINT IF EXISTS chk_shipment_source;

ALTER TABLE warehouse_shipments
  DROP CONSTRAINT IF EXISTS chk_shipment_not_both_orders;

-- Add anti-dual constraint idempotently
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_shipment_not_both_orders'
      AND conrelid = 'warehouse_shipments'::regclass
  ) THEN
    ALTER TABLE warehouse_shipments
      ADD CONSTRAINT chk_shipment_not_both_orders CHECK (
        NOT (order_id IS NOT NULL AND mailorder_id IS NOT NULL)
      );
  END IF;
END $$;

COMMIT;
