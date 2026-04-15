-- Migration: inventory sync pause flag + client activity log access
--
-- 1. Pause audit columns on workspaces
-- 2. is_synthetic column on warehouse_inventory_activity (future-proof filtering)
-- 3. Missing indexes for RLS query performance
-- 4. Client-scoped SELECT policy on warehouse_inventory_activity
-- 5. Composite partial index for activity log filtered queries

-- Pause columns
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS inventory_sync_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_sync_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_sync_paused_by uuid REFERENCES users(id);

-- Synthetic row marker
-- Rows with sku = '__sync_reconciliation__' written by shopify-sync bulk tasks
-- are backfilled to is_synthetic = true so clients never see them in their logs.
ALTER TABLE warehouse_inventory_activity
  ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;

-- Backfill existing synthetic reconciliation rows
UPDATE warehouse_inventory_activity
  SET is_synthetic = true
  WHERE sku = '__sync_reconciliation__';

-- workspace_id index (was missing — needed by the client RLS policy subquery)
CREATE INDEX IF NOT EXISTS idx_inventory_activity_workspace
  ON warehouse_inventory_activity(workspace_id);

-- Leading-edge composite index for the org-scoped, date-sorted activity log query.
-- workspace_id must be first so Postgres jumps to the workspace block before
-- filtering by SKU. Without this, an IN clause across 100-400 SKUs causes a
-- "Late Row Lookup" degradation as the table grows.
-- Partial: excludes synthetic rows to avoid index bloat.
CREATE INDEX IF NOT EXISTS idx_inventory_activity_ws_date_sku
  ON warehouse_inventory_activity(workspace_id, created_at DESC, sku)
  WHERE is_synthetic = false;

-- Composite index for the RLS subquery (org_id + sku lookup on levels)
CREATE INDEX IF NOT EXISTS idx_inventory_levels_org_sku
  ON warehouse_inventory_levels(org_id, sku);

-- Client-scoped activity read policy.
-- Note: getClientInventoryActivity() uses createServiceRoleClient() which bypasses
-- RLS entirely — this policy is pure defense-in-depth. The sku IN (...) subquery
-- executes on each evaluated row; if the session-client path (getInventoryDetail)
-- shows performance issues, simplify to workspace_id-only and rely on action scoping.
CREATE POLICY client_read_own_activity ON warehouse_inventory_activity
  FOR SELECT TO authenticated
  USING (
    NOT is_staff_user()
    AND is_synthetic = false
    AND workspace_id IN (
      SELECT workspace_id FROM users WHERE auth_user_id = auth.uid()
    )
    AND sku IN (
      SELECT sku FROM warehouse_inventory_levels
      WHERE org_id = get_user_org_id()
    )
  );
