-- Inventory Sync Cutover substrate
-- 2026-05-06
--
-- Adds first-class source values for baseline imports and label orders, plus a
-- per-SKU Redis/Postgres drift observation table used by the cutover breaker.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_inventory_activity_source_check'
  ) THEN
    ALTER TABLE warehouse_inventory_activity
      DROP CONSTRAINT warehouse_inventory_activity_source_check;
  END IF;
END $$;

ALTER TABLE warehouse_inventory_activity
  ADD CONSTRAINT warehouse_inventory_activity_source_check
  CHECK (source IN (
    'shopify','bandcamp','squarespace','woocommerce','shipstation',
    'manual','inbound','preorder','backfill','reconcile',
    'cycle_count','manual_inventory_count',
    'inventory_activate','baseline_import','label_order'
  ));

COMMENT ON CONSTRAINT warehouse_inventory_activity_source_check
  ON warehouse_inventory_activity IS
  'Inventory sync cutover: baseline_import admitted for physical count imports; label_order admitted for staff-created label fulfillment orders.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouse_orders_source_check'
  ) THEN
    ALTER TABLE warehouse_orders
      DROP CONSTRAINT warehouse_orders_source_check;
  END IF;
END $$;

ALTER TABLE warehouse_orders
  ADD CONSTRAINT warehouse_orders_source_check
  CHECK (source IN (
    'shopify','bandcamp','woocommerce','squarespace','discogs','manual','label_order'
  ));

COMMENT ON CONSTRAINT warehouse_orders_source_check
  ON warehouse_orders IS
  'Inventory sync cutover: label_order rows are staff-created fulfillment orders that share the warehouse_orders lifecycle.';

CREATE TABLE IF NOT EXISTS redis_pg_drift_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE SET NULL,
  sku text NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  redis_available integer NOT NULL,
  postgres_available integer NOT NULL,
  max_abs_drift integer NOT NULL DEFAULT 0 CHECK (max_abs_drift >= 0),
  sample_count integer NOT NULL DEFAULT 1 CHECK (sample_count > 0),
  status text NOT NULL DEFAULT 'warning' CHECK (status IN ('warning','critical','resolved')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_redis_pg_drift_observations_status
  ON redis_pg_drift_observations(workspace_id, status, last_observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_redis_pg_drift_observations_variant
  ON redis_pg_drift_observations(variant_id)
  WHERE variant_id IS NOT NULL;

ALTER TABLE redis_pg_drift_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS redis_pg_drift_observations_staff ON redis_pg_drift_observations;

CREATE POLICY redis_pg_drift_observations_staff
  ON redis_pg_drift_observations
  FOR ALL
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

COMMENT ON TABLE redis_pg_drift_observations IS
  'Per-SKU Redis/Postgres drift evidence for inventory sync cutover fanout breaker. Rows are cleared/resolved once Redis and Postgres agree again.';
