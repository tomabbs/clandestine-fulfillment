-- Order Pages Transition Phase 2 — order_mirror_links bridge + source-aware
-- tracking events.
--
-- Bridge table:
--   `order_mirror_links` is a diagnostic-first relation between
--   `warehouse_orders` (Direct) and `shipstation_orders` (Mirror). Phase 6
--   uses it to render "View Mirror" / "View Direct" deep links. Phase 5b
--   uses it to drive parity diagnostics. We DELIBERATELY do NOT
--   denormalize `shipstation_order_external_id` into the link table —
--   parent-side updates would silently make link rows stale (the
--   plan's mirror-link drift fix). UI joins through `shipstation_orders`
--   for the bigint external id.
--
-- Source-aware tracking:
--   Existing `warehouse_tracking_events.source` is a free-text column
--   used inconsistently. Phase 2 introduces a strict `tracking_source`
--   ENUM column on the same table and asks call sites to populate it
--   alongside `source` (legacy column kept for one release while writers
--   migrate). The Direct Orders detail UI uses `tracking_source` to
--   distinguish EasyPost / ShipStation / Pirate Ship / imported events
--   so staff don't conflate evidence streams.

-- ── ENUMs ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_mirror_link_confidence') THEN
    CREATE TYPE order_mirror_link_confidence AS ENUM (
      'deterministic',
      'probable',
      'manual',
      'rejected'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tracking_event_source') THEN
    CREATE TYPE tracking_event_source AS ENUM (
      'easypost',
      'shipstation',
      'pirate_ship',
      'aftership',
      'manual',
      'unknown'
    );
  END IF;
END$$;

-- ── order_mirror_links ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_mirror_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  warehouse_order_id uuid NOT NULL REFERENCES warehouse_orders(id) ON DELETE CASCADE,
  shipstation_order_id uuid NOT NULL REFERENCES shipstation_orders(id) ON DELETE CASCADE,
  confidence order_mirror_link_confidence NOT NULL DEFAULT 'probable',
  match_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_by uuid NULL REFERENCES users(id),
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, warehouse_order_id, shipstation_order_id)
);

-- One Mirror order should normally bridge to exactly one Direct order; the
-- inverse can be many (split shipments). Partial unique guards against
-- accidental fan-out from the bridge worker.
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_mirror_links_one_direct_per_mirror
  ON order_mirror_links (workspace_id, shipstation_order_id)
  WHERE confidence IN ('deterministic', 'manual');

CREATE INDEX IF NOT EXISTS idx_order_mirror_links_by_direct
  ON order_mirror_links (workspace_id, warehouse_order_id);
CREATE INDEX IF NOT EXISTS idx_order_mirror_links_by_mirror
  ON order_mirror_links (workspace_id, shipstation_order_id);
CREATE INDEX IF NOT EXISTS idx_order_mirror_links_confidence
  ON order_mirror_links (workspace_id, confidence)
  WHERE confidence <> 'rejected';

COMMENT ON TABLE order_mirror_links IS
  'Order Pages Transition Phase 2 — diagnostic-first bridge between warehouse_orders (Direct) and shipstation_orders (ShipStation Mirror). Populated by the bridge worker (deterministic + probable matches) and a manual-resolution Server Action (manual / rejected). The link table intentionally does NOT denormalize shipstation_orders.shipstation_order_id (bigint) — UI joins through shipstation_orders for that value to prevent two-way drift.';

-- ── warehouse_tracking_events.tracking_source ────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'warehouse_tracking_events' AND column_name = 'tracking_source'
  ) THEN
    ALTER TABLE warehouse_tracking_events
      ADD COLUMN tracking_source tracking_event_source NOT NULL DEFAULT 'unknown';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_tracking_events_source
  ON warehouse_tracking_events (shipment_id, tracking_source);

-- Best-effort backfill from the legacy free-text `source` column. We keep
-- the legacy column in place during the migration window so writers
-- continue to compile; Phase 5 retires the legacy column once all writers
-- have been switched to populate `tracking_source`.
UPDATE warehouse_tracking_events
SET tracking_source = CASE
  WHEN lower(source) LIKE '%easypost%' THEN 'easypost'::tracking_event_source
  WHEN lower(source) LIKE '%shipstation%' OR lower(source) = 'ss' THEN 'shipstation'::tracking_event_source
  WHEN lower(source) LIKE '%pirate%' THEN 'pirate_ship'::tracking_event_source
  WHEN lower(source) LIKE '%aftership%' THEN 'aftership'::tracking_event_source
  WHEN lower(source) = 'manual' THEN 'manual'::tracking_event_source
  ELSE 'unknown'::tracking_event_source
END
WHERE tracking_source = 'unknown' AND source IS NOT NULL;

COMMENT ON COLUMN warehouse_tracking_events.tracking_source IS
  'Order Pages Transition Phase 2 — strict ENUM source for the tracking event. Replaces the free-text `source` column, which is kept for one release while writers migrate. The Direct Orders detail UI uses this to distinguish EasyPost / ShipStation / Pirate Ship / imported events without re-parsing `description` strings.';

-- ── RLS — staff full, client read via parent join ───────────────────────────

ALTER TABLE order_mirror_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all ON order_mirror_links;
CREATE POLICY staff_all ON order_mirror_links
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

-- No client policy — link rows are diagnostic-only, not exposed to portals.
