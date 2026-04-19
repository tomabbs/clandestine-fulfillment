-- Phase 1.1 — Persist ShipStation orders.
--
-- Today's flow only fetches SS orders on demand from /admin/shipstation-orders
-- (via fetchOrders); nothing is in our DB. Phase 1+ moves the SS cockpit to
-- /admin/orders and renders from this table instead, with a 15-min cron
-- (Phase 1.2) and ORDER_NOTIFY webhook hook (Phase 1.3) keeping it fresh.
--
-- The schema mirrors what fetchOrders returns + Phase 5 preorder-state derivation
-- + Phase 4 v2-fulfillments shipment_id list.
--
-- Cross-references:
--   - shipstation_shipment_ids text[] — Reviewer 4 / plan §1.1: v2 fulfillments
--     keys on shipment_id (not orderId); array because SS supports multi-package
--     orders even though today's data is mostly 1:1.
--   - reuse warehouse_shipments.shipstation_shipment_id (already present) for
--     per-shipment writeback — no duplicate column added there.
--   - org_id resolved at insert time via warehouse_shipstation_stores
--     (matchShipmentOrg pattern in src/trigger/lib/match-shipment-org.ts).

-- ── shipstation_orders ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shipstation_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),

  -- org resolution: nullable so we can still ingest unmatched orders into a
  -- review queue rather than dropping them on the floor. Phase 2.1 cockpit
  -- shows them under "Unknown" / "Needs assignment".
  org_id uuid REFERENCES organizations(id),

  -- SS keys
  shipstation_order_id bigint NOT NULL,
  shipstation_shipment_ids text[] NOT NULL DEFAULT '{}',
  order_number text NOT NULL,
  order_status text NOT NULL,
  order_date timestamptz,

  -- Customer + addresses
  customer_email text,
  customer_name text,
  ship_to jsonb,
  bill_to jsonb,

  -- Marketplace / store routing
  store_id integer,
  marketplace_name text,

  -- Tags + advanced options (passthrough)
  tags jsonb DEFAULT '[]',
  advanced_options jsonb DEFAULT '{}',

  -- Money / parcel
  amount_paid numeric,
  shipping_paid numeric,
  weight jsonb,
  dimensions jsonb,

  -- SS modify cursor + our last-seen
  last_modified timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),

  -- Phase 5 preorder derivation. Computed by shipstation-orders-poll on each
  -- upsert + by preorder-tab-refresh cron at the day boundary.
  preorder_state text NOT NULL DEFAULT 'none'
    CHECK (preorder_state IN ('none', 'preorder', 'ready')),
  preorder_release_date date,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, shipstation_order_id)
);

CREATE INDEX IF NOT EXISTS idx_shipstation_orders_workspace
  ON shipstation_orders (workspace_id);
CREATE INDEX IF NOT EXISTS idx_shipstation_orders_org
  ON shipstation_orders (org_id);
CREATE INDEX IF NOT EXISTS idx_shipstation_orders_status
  ON shipstation_orders (workspace_id, order_status);
CREATE INDEX IF NOT EXISTS idx_shipstation_orders_preorder
  ON shipstation_orders (workspace_id, preorder_state)
  WHERE preorder_state <> 'none';
CREATE INDEX IF NOT EXISTS idx_shipstation_orders_modified
  ON shipstation_orders (workspace_id, last_modified DESC);
CREATE INDEX IF NOT EXISTS idx_shipstation_orders_order_number
  ON shipstation_orders (workspace_id, order_number);

COMMENT ON TABLE shipstation_orders IS
  'Phase 1.1 — local mirror of ShipStation orders (the source for the new /admin/orders cockpit). Updated by shipstation-orders-poll cron + ORDER_NOTIFY webhook.';
COMMENT ON COLUMN shipstation_orders.shipstation_shipment_ids IS
  'Phase 1.1 + Reviewer 4 — array of SS shipment IDs once the order has shipments. v2 fulfillments path keys on shipment_id, not orderId. Today mostly 1:1, schema accepts multi-package future.';
COMMENT ON COLUMN shipstation_orders.org_id IS
  'Resolved at upsert time via warehouse_shipstation_stores (Tier 1) or SKU matching (Tier 2). Nullable — unmatched orders still ingest and surface in cockpit "Needs assignment" bucket.';

-- ── shipstation_order_items ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shipstation_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  shipstation_order_id uuid NOT NULL REFERENCES shipstation_orders(id) ON DELETE CASCADE,

  sku text,
  name text,
  quantity integer NOT NULL,
  unit_price numeric,
  weight jsonb,
  image_url text,
  item_index integer NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (shipstation_order_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_shipstation_order_items_order
  ON shipstation_order_items (shipstation_order_id);
CREATE INDEX IF NOT EXISTS idx_shipstation_order_items_sku
  ON shipstation_order_items (workspace_id, sku);

COMMENT ON TABLE shipstation_order_items IS
  'Phase 1.1 — per-line items belonging to a shipstation_orders row. Replaced wholesale on each poll upsert (small set per order).';

-- ── warehouse_shipments — additive columns for Phase 3+4 writeback path ─────
-- We do NOT touch shipstation_shipment_id (already present, shipping log uses
-- it). All new columns are additive.

ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS shipstation_order_id text,
  ADD COLUMN IF NOT EXISTS shipstation_marked_shipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipstation_writeback_error text,
  ADD COLUMN IF NOT EXISTS shipstation_writeback_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipstation_writeback_path text,
  ADD COLUMN IF NOT EXISTS selected_rate_signature text,
  ADD COLUMN IF NOT EXISTS easypost_shipment_id text;

CREATE INDEX IF NOT EXISTS idx_warehouse_shipments_ss_order_id
  ON warehouse_shipments (workspace_id, shipstation_order_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_shipments_writeback_pending
  ON warehouse_shipments (workspace_id, shipstation_marked_shipped_at)
  WHERE label_source = 'easypost'
    AND shipstation_order_id IS NOT NULL
    AND shipstation_marked_shipped_at IS NULL;

COMMENT ON COLUMN warehouse_shipments.shipstation_order_id IS
  'Phase 1.1 — the ShipStation order ID this shipment was printed for. NULL for legacy non-SS shipments and for new platforms (Shopify direct). Used by Phase 4 to know whether writeback applies.';
COMMENT ON COLUMN warehouse_shipments.shipstation_marked_shipped_at IS
  'Phase 4 — set when shipstation-mark-shipped successfully writes back via v2 fulfillments OR v1 markasshipped. Local outbox: read-before-write to avoid double-mark.';
COMMENT ON COLUMN warehouse_shipments.shipstation_writeback_path IS
  'Phase 4 / Reviewer 4 — "v2" or "v1" depending on which path succeeded. Analytics + drift tracking.';
COMMENT ON COLUMN warehouse_shipments.selected_rate_signature IS
  'Phase 0.2 / 0.5.2 — hash of the chosen rate fields used at purchase. Lets us reconcile preview-vs-purchase mismatches and supports the Phase 0.3 idempotency key.';
COMMENT ON COLUMN warehouse_shipments.easypost_shipment_id IS
  'Phase 1.1 — pulled out of label_data JSONB into its own column for refund/reconciliation lookups. Existing rows backfilled below.';

-- Backfill the new easypost_shipment_id column from label_data for existing rows.
-- Idempotent: only writes when current value is NULL and JSONB has the key.
UPDATE warehouse_shipments
SET easypost_shipment_id = label_data->>'easypost_shipment_id'
WHERE easypost_shipment_id IS NULL
  AND label_data IS NOT NULL
  AND label_data ? 'easypost_shipment_id';

-- ── RLS — staff full, client SELECT own org ─────────────────────────────────
-- Mirrors policy on warehouse_shipments / warehouse_orders.

ALTER TABLE shipstation_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all ON shipstation_orders;
CREATE POLICY staff_all ON shipstation_orders
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS client_select ON shipstation_orders;
CREATE POLICY client_select ON shipstation_orders
  FOR SELECT TO authenticated
  USING (org_id = get_user_org_id());

ALTER TABLE shipstation_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all ON shipstation_order_items;
CREATE POLICY staff_all ON shipstation_order_items
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

-- Items have no direct org_id — client policy joins via parent.
DROP POLICY IF EXISTS client_select ON shipstation_order_items;
CREATE POLICY client_select ON shipstation_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM shipstation_orders so
    WHERE so.id = shipstation_order_items.shipstation_order_id
      AND so.org_id = get_user_org_id()
  ));
