-- ============================================================
-- Inventory hardening: safety buffer, floor enforcement
-- 2026-04-01
-- ============================================================

-- Per-SKU safety stock override (NULL = use workspace default)
ALTER TABLE warehouse_inventory_levels
  ADD COLUMN IF NOT EXISTS safety_stock integer CHECK (safety_stock >= 0),
  ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT false;

-- Workspace-wide default buffer (default 3 units)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS default_safety_stock integer NOT NULL DEFAULT 3
    CHECK (default_safety_stock >= 0);

-- Replace record_inventory_change_txn with floor-enforcing version.
-- ERRCODE P0001 with message containing "inventory_floor_violation" is catchable
-- in application code to distinguish expected stock-short from system faults.
-- The ON CONFLICT DO NOTHING on the activity insert provides DB-level idempotency.
CREATE OR REPLACE FUNCTION record_inventory_change_txn(
  p_workspace_id uuid,
  p_sku text,
  p_delta integer,
  p_source text,
  p_correlation_id text,
  p_metadata jsonb DEFAULT '{}'
) RETURNS jsonb AS $$
DECLARE
  v_previous integer;
  v_new integer;
  v_allow_neg boolean;
BEGIN
  SELECT allow_negative_stock INTO v_allow_neg
  FROM warehouse_inventory_levels
  WHERE workspace_id = p_workspace_id AND sku = p_sku;

  UPDATE warehouse_inventory_levels
  SET available = available + p_delta,
      updated_at = now(),
      last_redis_write_at = now()
  WHERE workspace_id = p_workspace_id
    AND sku = p_sku
    AND (v_allow_neg = true OR (available + p_delta) >= 0)
  RETURNING available - p_delta, available INTO v_previous, v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory_floor_violation: workspace=% sku=% delta=%',
      p_workspace_id, p_sku, p_delta
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO warehouse_inventory_activity (
    id, workspace_id, sku, delta, source, correlation_id,
    previous_quantity, new_quantity, metadata
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_sku, p_delta, p_source,
    p_correlation_id, v_previous, v_new, p_metadata
  ) ON CONFLICT (sku, correlation_id) DO NOTHING;

  RETURN jsonb_build_object('previous', v_previous, 'new', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
