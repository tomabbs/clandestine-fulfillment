-- Order Pages Transition Phase 1 — Direct Order Identity v2.
--
-- Adds the columns and supporting tables needed to give every direct-order
-- row a deterministic identity scoped by `(workspace_id, connection_id,
-- external_order_id)`. The existing `(workspace_id, source, shopify_order_id)`
-- shape doesn't survive the Northern Spy umbrella connection (one
-- connection across many orgs) and silently leaks duplicates today.
--
-- Idempotent: every column / index / type uses IF NOT EXISTS or a guard
-- block so a partial-applied migration can be safely re-run.

-- ── ENUM types ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'warehouse_order_identity_resolution_status') THEN
    CREATE TYPE warehouse_order_identity_resolution_status AS ENUM (
      'unresolved',
      'deterministic',
      'manual',
      'ambiguous',
      'live_api_verification_failed',
      'bandcamp_legacy_null'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'warehouse_order_identity_backfill_run_status') THEN
    CREATE TYPE warehouse_order_identity_backfill_run_status AS ENUM (
      'pending',
      'running',
      'completed',
      'partial',
      'failed',
      'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'warehouse_order_identity_review_reason') THEN
    CREATE TYPE warehouse_order_identity_review_reason AS ENUM (
      'multiple_candidate_connections',
      'no_candidate_connection',
      'live_api_verification_failed',
      'platform_unsupported',
      'bandcamp_legacy_null'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'warehouse_order_identity_review_status') THEN
    CREATE TYPE warehouse_order_identity_review_status AS ENUM (
      'open',
      'in_progress',
      'resolved_manual',
      'resolved_auto',
      'suppressed'
    );
  END IF;
END$$;

-- ── warehouse_orders — additive identity v2 columns ──────────────────────────

ALTER TABLE warehouse_orders
  ADD COLUMN IF NOT EXISTS connection_id uuid NULL REFERENCES client_store_connections(id),
  ADD COLUMN IF NOT EXISTS external_order_id text NULL,
  ADD COLUMN IF NOT EXISTS ingestion_idempotency_key_v2 text NULL,
  ADD COLUMN IF NOT EXISTS identity_resolution_notes jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'warehouse_orders' AND column_name = 'identity_resolution_status'
  ) THEN
    ALTER TABLE warehouse_orders
      ADD COLUMN identity_resolution_status warehouse_order_identity_resolution_status
        NOT NULL DEFAULT 'unresolved';
  END IF;
END$$;

COMMENT ON COLUMN warehouse_orders.connection_id IS
  'Order Pages Transition Phase 1 — the client_store_connections row this order ingested through. NULL for legacy rows; populated for every new ingest. Identity v2 keys on (workspace_id, connection_id, external_order_id).';
COMMENT ON COLUMN warehouse_orders.external_order_id IS
  'Order Pages Transition Phase 1 — the platform-native order ID (Shopify order GID, Woo order ID, Bandcamp payment ID, etc.). Distinct from order_number which is the human-friendly display string and not unique across platforms.';
COMMENT ON COLUMN warehouse_orders.ingestion_idempotency_key_v2 IS
  'Order Pages Transition Phase 1 — stable idempotency key used by the live ingest path (webhook + poller). Format: "{platform}:{connection_id}:{external_order_id}". Replaces the legacy `(source, shopify_order_id)` dedup which collapsed across Northern Spy umbrella connections.';
COMMENT ON COLUMN warehouse_orders.identity_resolution_status IS
  'Order Pages Transition Phase 1 — state machine for the identity resolution. unresolved (legacy default) → {deterministic | manual | ambiguous | live_api_verification_failed | bandcamp_legacy_null}. Routes the order through the Direct read model (deterministic/manual) vs the identity review queue (everything else).';
COMMENT ON COLUMN warehouse_orders.identity_resolution_notes IS
  'Order Pages Transition Phase 1 — diagnostic JSON the resolver writes when it lands a non-deterministic state (e.g. candidate_connection_ids, live API verification error code). Read by /admin/orders/diagnostics + the identity review queue surface.';

-- ── partial unique indexes for v2 identity ───────────────────────────────────
--
-- IMPORTANT: both indexes filter on the relevant nulls so legacy rows without
-- connection_id / external_order_id don't violate during backfill. The plan's
-- reviewer flagged this explicitly — without the partial filter the backfill
-- migration fails halfway through on production data.

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_orders_idem_v2
  ON warehouse_orders (workspace_id, ingestion_idempotency_key_v2)
  WHERE ingestion_idempotency_key_v2 IS NOT NULL
    AND connection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_orders_canonical_identity
  ON warehouse_orders (workspace_id, connection_id, external_order_id)
  WHERE connection_id IS NOT NULL
    AND external_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warehouse_orders_connection
  ON warehouse_orders (workspace_id, connection_id)
  WHERE connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warehouse_orders_identity_status
  ON warehouse_orders (workspace_id, identity_resolution_status)
  WHERE identity_resolution_status <> 'deterministic';

-- ── search support indexes ──────────────────────────────────────────────────
-- Direct Orders read model needs cheap LIKE search by order_number /
-- customer_email / external_order_id. Trigram indexes give us these.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_warehouse_orders_order_number_trgm
  ON warehouse_orders USING gin (order_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_warehouse_orders_customer_email_trgm
  ON warehouse_orders USING gin (customer_email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_warehouse_orders_external_order_id_trgm
  ON warehouse_orders USING gin (external_order_id gin_trgm_ops);

-- ── warehouse_order_identity_backfill_runs ───────────────────────────────────

CREATE TABLE IF NOT EXISTS warehouse_order_identity_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NULL REFERENCES client_store_connections(id),
  status warehouse_order_identity_backfill_run_status NOT NULL DEFAULT 'pending',
  cursor_order_id uuid NULL REFERENCES warehouse_orders(id),
  scanned integer NOT NULL DEFAULT 0,
  resolved_deterministic integer NOT NULL DEFAULT 0,
  resolved_ambiguous integer NOT NULL DEFAULT 0,
  resolved_unresolved integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warehouse_order_identity_backfill_runs_workspace
  ON warehouse_order_identity_backfill_runs (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_order_identity_backfill_runs_open
  ON warehouse_order_identity_backfill_runs (workspace_id)
  WHERE status IN ('pending', 'running');

COMMENT ON TABLE warehouse_order_identity_backfill_runs IS
  'Order Pages Transition Phase 1 — resumable per-connection identity v2 backfill ledger. cursor_order_id lets a re-run pick up where the previous run halted. Scanned/resolved counters drive the diagnostics surface.';

-- ── warehouse_order_identity_review_queue ────────────────────────────────────

CREATE TABLE IF NOT EXISTS warehouse_order_identity_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  warehouse_order_id uuid NOT NULL REFERENCES warehouse_orders(id) ON DELETE CASCADE,
  reason warehouse_order_identity_review_reason NOT NULL,
  status warehouse_order_identity_review_status NOT NULL DEFAULT 'open',
  candidate_connection_ids uuid[] NOT NULL DEFAULT '{}',
  resolution_notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_connection_id uuid NULL REFERENCES client_store_connections(id),
  resolved_by uuid NULL REFERENCES users(id),
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotent insert: only one OPEN review row per order at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_order_identity_review_open_per_order
  ON warehouse_order_identity_review_queue (warehouse_order_id)
  WHERE status IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_warehouse_order_identity_review_workspace_status
  ON warehouse_order_identity_review_queue (workspace_id, status);

COMMENT ON TABLE warehouse_order_identity_review_queue IS
  'Order Pages Transition Phase 1 — manual-review queue for direct orders the resolver cannot deterministically attribute to a single client_store_connections row. UI surface is /admin/orders/diagnostics → Identity tab; manual resolution writes back into warehouse_orders.connection_id + flips identity_resolution_status to manual.';

-- ── platform_order_ingest_ownership ──────────────────────────────────────────
--
-- Registry that records, per (workspace_id, platform, store_key), whether
-- the live "create" path is owned by the webhook handler or the poller.
-- The webhook pre-check uses this to fail closed when the registry is
-- missing (HTTP 503) and to drop `order.created` events when the poller
-- owns the create path. Update/cancel/refund events are always processed
-- regardless of `update_owner` value (poller may not pick those up on the
-- same cadence).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_order_ingest_owner') THEN
    CREATE TYPE platform_order_ingest_owner AS ENUM ('webhook', 'poller');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS platform_order_ingest_ownership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  platform text NOT NULL,
  store_key text NOT NULL,
  connection_id uuid NULL REFERENCES client_store_connections(id),
  ingest_owner platform_order_ingest_owner NOT NULL,
  update_owner platform_order_ingest_owner NULL,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, store_key)
);
CREATE INDEX IF NOT EXISTS idx_platform_order_ingest_ownership_lookup
  ON platform_order_ingest_ownership (workspace_id, platform, store_key);

COMMENT ON TABLE platform_order_ingest_ownership IS
  'Order Pages Transition Phase 1 — per-(platform, store_key) registry of which path owns "order.created" ingestion. Webhook handlers MUST consult this before processing an order.created event; missing rows return HTTP 503 (fail-closed). update_owner is consulted for update/cancel/refund events; if NULL, those events are always processed regardless of ingest_owner.';

-- ── RLS — staff-only on the new identity tables ──────────────────────────────

ALTER TABLE warehouse_order_identity_backfill_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON warehouse_order_identity_backfill_runs;
CREATE POLICY staff_all ON warehouse_order_identity_backfill_runs
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

ALTER TABLE warehouse_order_identity_review_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON warehouse_order_identity_review_queue;
CREATE POLICY staff_all ON warehouse_order_identity_review_queue
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

ALTER TABLE platform_order_ingest_ownership ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON platform_order_ingest_ownership;
CREATE POLICY staff_all ON platform_order_ingest_ownership
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());
