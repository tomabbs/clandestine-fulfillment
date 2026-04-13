-- Phase 4: Add JSONB details column to warehouse_billing_adjustments
-- for per-SKU storage breakdown (immutable receipt for dispute resolution).
ALTER TABLE warehouse_billing_adjustments
  ADD COLUMN IF NOT EXISTS details jsonb;
