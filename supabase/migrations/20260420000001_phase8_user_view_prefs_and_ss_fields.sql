-- Phase 8.3 — Per-user saved-view prefs.
--
-- Surface = "orders_cockpit" (initially) — reusable across other lists later
-- (mailorder, billing, shipping log, etc.).
--
-- view_state JSONB shape is consumer-defined; orders_cockpit stores
-- { orderStatus, orgId, tab, search, sort, columnPrefs, groupBy, pageSize }.
--
-- is_default: at most one TRUE per (user_id, surface). Enforced by partial
-- unique index. Saving a view with is_default=true clears the prior default
-- in the same transaction (handled in the action layer).

CREATE TABLE IF NOT EXISTS user_view_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  surface text NOT NULL,
  name text NOT NULL,
  view_state jsonb NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, surface, name)
);

CREATE INDEX IF NOT EXISTS idx_user_view_prefs_user_surface
  ON user_view_prefs (user_id, surface);

-- At most one default per (user, surface). Partial unique index — NULL counts
-- as a value here so we filter on is_default = true.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_view_prefs_default_per_surface
  ON user_view_prefs (user_id, surface)
  WHERE is_default = true;

COMMENT ON TABLE user_view_prefs IS
  'Phase 8.3 — per-user saved views for any list surface. view_state shape is consumer-defined per surface key.';

-- ── RLS — staff and clients can manage their own view prefs only ────────────
-- The action layer always filters by auth.uid() → users.id mapping so the
-- policy here is the safety net.

ALTER TABLE user_view_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_owns_view_prefs ON user_view_prefs;
CREATE POLICY user_owns_view_prefs ON user_view_prefs
  FOR ALL TO authenticated
  USING (
    user_id = (SELECT id FROM users WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    user_id = (SELECT id FROM users WHERE auth_user_id = auth.uid())
  );

-- ── Phase 8.5 + 8.6 + 8.8 — extend shipstation_orders for SS-only fields ────
-- These are display-only (or write-back-via-SS) fields that the poll task
-- will start capturing. All nullable + additive.

ALTER TABLE shipstation_orders
  ADD COLUMN IF NOT EXISTS hold_until_date date,
  ADD COLUMN IF NOT EXISTS ship_by_date date,
  ADD COLUMN IF NOT EXISTS deliver_by_date date,
  ADD COLUMN IF NOT EXISTS payment_date timestamptz,
  ADD COLUMN IF NOT EXISTS assignee_user_id text,
  ADD COLUMN IF NOT EXISTS assignee_username text,
  -- SS exposes order tags as { tagId, name, color } objects on order responses;
  -- already captured into the `tags` JSONB column. New `tag_ids` int[] gives
  -- a cheap server-side filter when staff filters by tag without loading the JSONB.
  ADD COLUMN IF NOT EXISTS tag_ids integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allocation_status text;

CREATE INDEX IF NOT EXISTS idx_shipstation_orders_hold_until
  ON shipstation_orders (workspace_id, hold_until_date)
  WHERE hold_until_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipstation_orders_tag_ids
  ON shipstation_orders USING GIN (tag_ids)
  WHERE array_length(tag_ids, 1) > 0;

COMMENT ON COLUMN shipstation_orders.hold_until_date IS
  'Phase 8.6 — SS holdUntilDate. When set + status="on_hold", row sits in the On Hold sidebar bucket until the date passes.';
COMMENT ON COLUMN shipstation_orders.ship_by_date IS
  'Phase 8.8 — SS advancedOptions.shipByDate (display-only).';
COMMENT ON COLUMN shipstation_orders.deliver_by_date IS
  'Phase 8.8 — SS advancedOptions.deliveryDate (display-only).';
COMMENT ON COLUMN shipstation_orders.payment_date IS
  'Phase 8.8 — SS paymentDate (display-only).';
COMMENT ON COLUMN shipstation_orders.assignee_user_id IS
  'Phase 8.8 — SS userId for the staff member assigned to this order. Display-only with deep link.';
COMMENT ON COLUMN shipstation_orders.tag_ids IS
  'Phase 8.5 — denormalized array of SS tag IDs for cheap filter queries. The full {id,name,color} structure stays in the tags JSONB column.';
COMMENT ON COLUMN shipstation_orders.allocation_status IS
  'Phase 8.8 — SS advancedOptions.allocationStatus (display-only).';

-- ── Phase 8 polish — extend warehouse_shipments index for "Retry write-back" ─
-- The retry button looks up the most recent shipment for an order with a
-- writeback error. Already indexed by (workspace_id, shipstation_order_id);
-- this adds a partial index on the error-present rows for fast filter.

CREATE INDEX IF NOT EXISTS idx_warehouse_shipments_writeback_error_open
  ON warehouse_shipments (workspace_id, shipstation_order_id)
  WHERE shipstation_writeback_error IS NOT NULL
    AND shipstation_marked_shipped_at IS NULL;
