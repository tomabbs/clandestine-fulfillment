-- Autonomous SKU matcher — Phase 0 foundation.
--
-- Plan: autonomous_sku_matching_da557209.plan.md
--       §"Phase 0 — schema foundation (no behavior change)".
--
-- Ships the schema + RPCs only. NO automation is wired. All feature flags
-- (sku_identity_autonomy_enabled, sku_live_alias_autonomy_enabled,
-- non_warehouse_order_hold_enabled, non_warehouse_order_client_alerts_enabled,
-- client_stock_exception_reports_enabled) stay OFF / unset in
-- workspaces.flags; the autonomous code paths introduced in Phase 1+ read
-- them through the existing getWorkspaceFlags() helper.
--
-- Purely additive and idempotent (IF NOT EXISTS everywhere, DO $$ …
-- create-if-missing blocks for policies, `drop trigger if exists … create
-- trigger` for triggers, `create or replace function …` for functions).
-- Applying to a cluster that already has the phase-0 tables must be a
-- no-op; re-applying after partial failure must converge without manual
-- DDL cleanup (per Rules #… idempotent-migration contract, mirrored in
-- scripts/cloud-agent-verify.sh).

-- ══════════════════════════════════════════════════════════════════════════
-- Section A — workspaces emergency-pause columns
-- ══════════════════════════════════════════════════════════════════════════
--
-- Emergency pause is a HARD signal that bypasses the flag cache. A paused
-- workspace short-circuits every autonomous write path (`sku-shadow-promotion`,
-- `stock-stability-sampler`, `sku-hold-recovery-recheck`, matching-monitor
-- runs, and the webhook-ingress rehydrate path that would otherwise call
-- `promote_identity_match_to_alias`). The order-hold evaluator continues to
-- run so in-flight holds are not silently dropped.
--
-- Semantics:
--   * sku_autonomous_emergency_paused = false → normal operation.
--   * true → checkEmergencyPause()/isWorkspaceEmergencyPaused() returns
--     the set reason; every autonomous task must call one of these before
--     its first write. No bypass env var is permitted.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS sku_autonomous_emergency_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sku_autonomous_emergency_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS sku_autonomous_emergency_paused_by text,
  ADD COLUMN IF NOT EXISTS sku_autonomous_emergency_paused_reason text;

COMMENT ON COLUMN workspaces.sku_autonomous_emergency_paused IS
  'Autonomous SKU matcher kill switch. When true, every autonomous write path and the webhook-ingress rehydrate path exit cleanly. Order-hold evaluation is NOT blocked. Set via the admin settings action (Phase 1+); cleared by the same action. No env-var bypass.';

-- ══════════════════════════════════════════════════════════════════════════
-- Section B — client_store_product_identity_matches
-- ══════════════════════════════════════════════════════════════════════════
--
-- Identity-only matches. variant_id is NULLABLE so remote-only rows,
-- non-operational rows, and fetch-incomplete rows can exist without a
-- canonical. Live aliases continue to live in `client_store_sku_mappings`;
-- rows here never participate in fanout. See the plan's "Identity rows
-- MUST NEVER be read by inventory-fanout.ts" note and the CI grep guard
-- `scripts/lint/sku-identity-no-fanout.sh`.

CREATE TABLE IF NOT EXISTS client_store_product_identity_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('shopify', 'woocommerce', 'squarespace')),

  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE SET NULL,

  remote_product_id text,
  remote_variant_id text,
  remote_inventory_item_id text,
  remote_sku text,
  remote_fingerprint text,

  outcome_state text NOT NULL CHECK (outcome_state IN (
    'auto_database_identity_match',
    'auto_shadow_identity_match',
    'auto_holdout_for_evidence',
    'auto_reject_non_match',
    'auto_skip_non_operational',
    'fetch_incomplete_holdout',
    'client_stock_exception'
  )),

  canonical_resolution_state text NOT NULL DEFAULT 'unresolved'
    CHECK (canonical_resolution_state IN (
      'resolved_to_variant',
      'remote_only_unresolved',
      'non_operational',
      'rejected_non_match',
      'unresolved'
    )),

  remote_listing_state text
    CHECK (remote_listing_state IN (
      'sellable_product',
      'remote_only',
      'non_operational',
      'placeholder_sku',
      'fetch_incomplete',
      'duplicate_remote',
      'archived_remote'
    )),

  match_method text NOT NULL,
  match_confidence text NOT NULL,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text NOT NULL,

  warehouse_stock_at_match integer,
  remote_stock_at_match integer,
  remote_stock_listed_at_match boolean,

  state_version integer NOT NULL DEFAULT 1,

  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluation_count integer NOT NULL DEFAULT 1,

  promoted_to_alias_at timestamptz,
  promoted_alias_id uuid REFERENCES client_store_sku_mappings(id) ON DELETE SET NULL,

  created_by_method text CHECK (created_by_method IN (
    'autonomous_initial',
    'autonomous_periodic',
    'human'
  )),

  CONSTRAINT ck_identity_variant_required_for_identity_match CHECK (
    outcome_state NOT IN ('auto_database_identity_match', 'auto_shadow_identity_match')
    OR (variant_id IS NOT NULL AND canonical_resolution_state = 'resolved_to_variant')
  )
);

-- Partial UNIQUE indexes enforce identity uniqueness per connection across
-- four possible remote-listing identifier shapes. Each index is PARTIAL on
-- `is_active = true` so soft-deactivated rows do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_matches_active_variant_connection
  ON client_store_product_identity_matches(connection_id, variant_id)
  WHERE is_active = true
    AND variant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_active_remote_variant
  ON client_store_product_identity_matches(
    connection_id,
    remote_product_id,
    remote_variant_id
  )
  WHERE is_active = true
    AND remote_product_id IS NOT NULL
    AND remote_variant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_active_remote_inventory_item
  ON client_store_product_identity_matches(
    connection_id,
    remote_inventory_item_id
  )
  WHERE is_active = true
    AND remote_inventory_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_active_remote_fingerprint
  ON client_store_product_identity_matches(
    connection_id,
    remote_fingerprint
  )
  WHERE is_active = true
    AND remote_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_identity_matches_evaluation
  ON client_store_product_identity_matches(last_evaluated_at, outcome_state)
  WHERE is_active = true;

-- Promotion candidate hot-path index: auto_database_identity_match rows
-- with positive warehouse stock-at-match are what `sku-shadow-promotion`
-- scans on every run. Partial so it stays small.
CREATE INDEX IF NOT EXISTS idx_identity_matches_promotion_candidates
  ON client_store_product_identity_matches(workspace_id, outcome_state, warehouse_stock_at_match)
  WHERE outcome_state = 'auto_database_identity_match'
    AND is_active = true
    AND warehouse_stock_at_match IS NOT NULL
    AND warehouse_stock_at_match > 0;

CREATE INDEX IF NOT EXISTS idx_identity_matches_org_listing
  ON client_store_product_identity_matches(org_id, remote_listing_state)
  WHERE is_active = true;

ALTER TABLE client_store_product_identity_matches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'client_store_product_identity_matches'
      AND policyname = 'staff_all'
  ) THEN
    CREATE POLICY staff_all ON client_store_product_identity_matches
      FOR ALL TO authenticated
      USING (is_staff_user())
      WITH CHECK (is_staff_user());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'client_store_product_identity_matches'
      AND policyname = 'client_select_identity_matches'
  ) THEN
    CREATE POLICY client_select_identity_matches ON client_store_product_identity_matches
      FOR SELECT TO authenticated
      USING (org_id = get_user_org_id());
  END IF;
END
$$;

COMMENT ON TABLE client_store_product_identity_matches IS
  'Autonomous SKU matcher identity layer. Never consulted by inventory-fanout.ts, client-store-fanout-gate.ts, multi-store-inventory-push, or webhook body handlers (see lint guard scripts/lint/sku-identity-no-fanout.sh). Promotion to live alias goes through promote_identity_match_to_alias(), which delegates the actual alias write to persist_sku_match().';

-- ══════════════════════════════════════════════════════════════════════════
-- Section C — cross-workspace tenancy enforcement trigger
-- ══════════════════════════════════════════════════════════════════════════
--
-- Defense-in-depth for multi-tenancy. An application-layer bug in batch
-- iteration (iterating workspace A's connections while passing workspace B's
-- variant set) would produce rows that are individually valid but
-- catastrophically wrong in aggregate — invisible until a customer notices.
-- Cost ~1ms per INSERT for a hard DB-backed tenancy guarantee.
--
-- Attached to BOTH identity_matches (new) and sku_mappings (existing) so the
-- alias write path inherits the same guard. The trigger is tolerant of the
-- org_id column being absent on legacy sku_mappings rows.

CREATE OR REPLACE FUNCTION enforce_identity_match_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_connection_workspace uuid;
  v_connection_org uuid;
  v_variant_workspace uuid;
BEGIN
  SELECT workspace_id, org_id
    INTO v_connection_workspace, v_connection_org
    FROM client_store_connections
   WHERE id = NEW.connection_id;

  IF v_connection_workspace IS NULL THEN
    RAISE EXCEPTION 'enforce_identity_match_scope: connection % not found', NEW.connection_id;
  END IF;

  IF NEW.workspace_id <> v_connection_workspace THEN
    RAISE EXCEPTION 'enforce_identity_match_scope: workspace mismatch (row=%, connection=%)',
      NEW.workspace_id, v_connection_workspace;
  END IF;

  -- Only validate org when the row exposes org_id. client_store_sku_mappings
  -- legacy rows may be NULL on that column, in which case we cannot compare.
  IF to_jsonb(NEW) ? 'org_id'
     AND NEW.org_id IS NOT NULL
     AND NEW.org_id <> v_connection_org THEN
    RAISE EXCEPTION 'enforce_identity_match_scope: org mismatch (row=%, connection=%)',
      NEW.org_id, v_connection_org;
  END IF;

  IF NEW.variant_id IS NOT NULL THEN
    SELECT workspace_id INTO v_variant_workspace
      FROM warehouse_product_variants
     WHERE id = NEW.variant_id;

    IF v_variant_workspace IS NULL THEN
      RAISE EXCEPTION 'enforce_identity_match_scope: variant % not found', NEW.variant_id;
    END IF;

    IF v_variant_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION 'enforce_identity_match_scope: variant workspace mismatch (variant=%, row=%)',
        v_variant_workspace, NEW.workspace_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_identity_match_scope_trg ON client_store_product_identity_matches;
CREATE TRIGGER enforce_identity_match_scope_trg
  BEFORE INSERT OR UPDATE ON client_store_product_identity_matches
  FOR EACH ROW EXECUTE FUNCTION enforce_identity_match_scope();

DROP TRIGGER IF EXISTS enforce_alias_scope_trg ON client_store_sku_mappings;
CREATE TRIGGER enforce_alias_scope_trg
  BEFORE INSERT OR UPDATE ON client_store_sku_mappings
  FOR EACH ROW EXECUTE FUNCTION enforce_identity_match_scope();

COMMENT ON FUNCTION enforce_identity_match_scope() IS
  'Defense-in-depth tenancy guard. Attached to client_store_product_identity_matches AND client_store_sku_mappings so any application bug that tries to write a row whose workspace_id / org_id does not match its connection_id, or whose variant_id does not live in the same workspace, aborts at the DB boundary. Release gate SKU-AUTO-26.';

-- ══════════════════════════════════════════════════════════════════════════
-- Section D — sku_outcome_transitions (append-only audit)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Narrower, typed companion to sku_mapping_events. Captures every state
-- change of an identity row (including promotion → alias and cross-storage
-- demotion). Append-only; `applyOutcomeTransition` is the only writer.

CREATE TABLE IF NOT EXISTS sku_outcome_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE SET NULL,

  from_state text,
  to_state text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN (
    'evidence_gate',
    'stock_change',
    'human_review',
    'fetch_recovery',
    'periodic_revaluation'
  )),
  reason_code text NOT NULL,

  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  identity_match_id uuid REFERENCES client_store_product_identity_matches(id) ON DELETE SET NULL,
  alias_id uuid REFERENCES client_store_sku_mappings(id) ON DELETE SET NULL,

  triggered_by text,
  triggered_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outcome_transitions_variant
  ON sku_outcome_transitions(variant_id, connection_id, triggered_at DESC);

ALTER TABLE sku_outcome_transitions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sku_outcome_transitions'
      AND policyname = 'staff_all'
  ) THEN
    CREATE POLICY staff_all ON sku_outcome_transitions
      FOR ALL TO authenticated
      USING (is_staff_user())
      WITH CHECK (is_staff_user());
  END IF;
END
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- Section E — sku_autonomous_runs + sku_autonomous_decisions
-- ══════════════════════════════════════════════════════════════════════════
--
-- Every autonomous matching pass produces one run row + one decision row
-- per evaluated variant. These support replay for customer disputes
-- ("wrong vinyl color shipped" → query the decision row 6 months later).
-- In Phase 1 decisions are dry-run only; Phase 2+ flips the flag to write
-- identity matches.

CREATE TABLE IF NOT EXISTS sku_autonomous_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES client_store_connections(id) ON DELETE SET NULL,

  trigger_source text NOT NULL CHECK (trigger_source IN (
    'scheduled_periodic',
    'connection_added',
    'manual_admin',
    'evidence_change_trigger',
    'stock_change_trigger'
  )),
  dry_run boolean NOT NULL DEFAULT true,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),

  variants_evaluated integer NOT NULL DEFAULT 0,
  outcomes_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates_with_no_match integer NOT NULL DEFAULT 0,
  candidates_held_for_evidence integer NOT NULL DEFAULT 0,
  candidates_with_disqualifiers integer NOT NULL DEFAULT 0,

  total_duration_ms integer,
  avg_per_variant_ms integer,
  error_count integer NOT NULL DEFAULT 0,
  error_log jsonb NOT NULL DEFAULT '[]'::jsonb,

  cancellation_requested_at timestamptz,
  cancellation_requested_by text,
  cancellation_reason text,

  triggered_by text
);

CREATE INDEX IF NOT EXISTS idx_autonomous_runs_workspace
  ON sku_autonomous_runs(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomous_runs_connection
  ON sku_autonomous_runs(connection_id, started_at DESC)
  WHERE connection_id IS NOT NULL;
-- Fast lookup for the in-loop cancellation poll (every 25 variants the
-- loop queries `SELECT 1 FROM sku_autonomous_runs WHERE id = ... AND
-- cancellation_requested_at IS NOT NULL`).
CREATE INDEX IF NOT EXISTS idx_autonomous_runs_active_cancel
  ON sku_autonomous_runs(id)
  WHERE status = 'running' AND cancellation_requested_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sku_autonomous_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES sku_autonomous_runs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE SET NULL,

  outcome_state text NOT NULL,
  previous_outcome_state text,
  outcome_changed boolean NOT NULL,

  match_method text,
  match_confidence text,
  reason_code text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text,
  disqualifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,

  fetch_status text CHECK (fetch_status IN (
    'ok', 'timeout', 'auth_error', 'unavailable', 'unsupported', 'partial'
  )),
  fetch_completed_at timestamptz,
  fetch_duration_ms integer,

  alias_id uuid REFERENCES client_store_sku_mappings(id) ON DELETE SET NULL,
  identity_match_id uuid REFERENCES client_store_product_identity_matches(id) ON DELETE SET NULL,
  transition_id uuid REFERENCES sku_outcome_transitions(id) ON DELETE SET NULL,

  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autonomous_decisions_run
  ON sku_autonomous_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_autonomous_decisions_variant
  ON sku_autonomous_decisions(variant_id, decided_at DESC);

ALTER TABLE sku_autonomous_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_autonomous_decisions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sku_autonomous_runs'
      AND policyname = 'staff_all'
  ) THEN
    CREATE POLICY staff_all ON sku_autonomous_runs
      FOR ALL TO authenticated
      USING (is_staff_user())
      WITH CHECK (is_staff_user());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sku_autonomous_decisions'
      AND policyname = 'staff_all'
  ) THEN
    CREATE POLICY staff_all ON sku_autonomous_decisions
      FOR ALL TO authenticated
      USING (is_staff_user())
      WITH CHECK (is_staff_user());
  END IF;
END
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- Section F — warehouse_orders.fulfillment_hold columns
-- ══════════════════════════════════════════════════════════════════════════
--
-- Clandestine-initiated hold state, DISTINCT from
-- shipstation_orders.order_status='on_hold' (the ShipStation-side value).
-- fulfillment_hold_cycle_id exists so a released-then-reheld sequence
-- counts as two events for alerting; cycle id survives release and a
-- fresh cycle id is assigned on rehold.

ALTER TABLE warehouse_orders
  ADD COLUMN IF NOT EXISTS fulfillment_hold text NOT NULL DEFAULT 'no_hold'
    CHECK (fulfillment_hold IN ('no_hold','on_hold','released','cancelled')),
  ADD COLUMN IF NOT EXISTS fulfillment_hold_reason text,
  ADD COLUMN IF NOT EXISTS fulfillment_hold_at timestamptz,
  ADD COLUMN IF NOT EXISTS fulfillment_hold_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS fulfillment_hold_released_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS fulfillment_hold_client_alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS fulfillment_hold_cycle_id uuid,
  ADD COLUMN IF NOT EXISTS fulfillment_hold_metadata jsonb;

CREATE INDEX IF NOT EXISTS idx_warehouse_orders_fulfillment_hold
  ON warehouse_orders(workspace_id, fulfillment_hold, fulfillment_hold_at DESC)
  WHERE fulfillment_hold = 'on_hold';

COMMENT ON COLUMN warehouse_orders.fulfillment_hold IS
  'Clandestine-initiated dispatch hold. DISTINCT from shipstation_orders.order_status. Values: no_hold | on_hold | released | cancelled. Set via evaluateOrderForHold() and releaseFulfillmentHold() (Phase 1+). Rule: a held order may still have its committable lines written to inventory_commitments immediately — hold blocks pick/pack + ShipStation export, not commitment.';

COMMENT ON COLUMN warehouse_orders.fulfillment_hold_cycle_id IS
  'New UUID assigned on every on_hold entry. Stays set across release so hold_alert_resent references the original cycle; rehold inserts a fresh cycle id. Required for alert idempotency: `(alert_type, workspace_id, order_id, hold_cycle_id)` is the notification uniqueness key.';

-- ══════════════════════════════════════════════════════════════════════════
-- Section G — order_fulfillment_hold_events
-- ══════════════════════════════════════════════════════════════════════════
--
-- Full timeline of every state change on warehouse_orders.fulfillment_hold.
-- connection_id is denormalized so shouldSuppressBulkHold() can scope its
-- per-connection count window query without joining warehouse_orders.
-- hold_reason (not `reason`) avoids a name collision with other audit
-- tables; round-5 audit fix.

CREATE TABLE IF NOT EXISTS order_fulfillment_hold_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES client_store_connections(id) ON DELETE SET NULL,
  order_id uuid NOT NULL REFERENCES warehouse_orders(id) ON DELETE CASCADE,
  hold_cycle_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'hold_applied',
    'hold_alert_sent',
    'hold_released',
    'hold_cancelled',
    'hold_alert_resent'
  )),
  hold_reason text,
  resolution_code text,
  affected_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_id uuid REFERENCES users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_fulfillment_hold_events_order
  ON order_fulfillment_hold_events(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_fulfillment_hold_events_cycle
  ON order_fulfillment_hold_events(hold_cycle_id);

-- Drives shouldSuppressBulkHold()'s per-connection count window query;
-- keep in sync with BULK_HOLD_THRESHOLD.window_minutes in
-- src/lib/server/order-hold-bulk-suppression.ts (Phase 1+).
CREATE INDEX IF NOT EXISTS idx_order_fulfillment_hold_events_bulk_window
  ON order_fulfillment_hold_events(
    workspace_id,
    connection_id,
    event_type,
    hold_reason,
    created_at DESC
  );

ALTER TABLE order_fulfillment_hold_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'order_fulfillment_hold_events'
      AND policyname = 'staff_all'
  ) THEN
    CREATE POLICY staff_all ON order_fulfillment_hold_events
      FOR ALL TO authenticated
      USING (is_staff_user())
      WITH CHECK (is_staff_user());
  END IF;
END
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- Section H — stock_stability_readings
-- ══════════════════════════════════════════════════════════════════════════
--
-- Rolling sample of warehouse + remote stock readings, keyed by
-- (workspace_id, variant_id, source, observed_at). Populated by the
-- `stock-stability-sampler` task (15-minute cadence, Phase 1+) using
-- `INSERT ... ON CONFLICT DO NOTHING` so Trigger.dev occasional
-- double-deliveries are silent no-ops. A 30-day retention purge runs
-- nightly (follow-up task).
--
-- Sources (non-exhaustive; the TS helper classifies):
--   * warehouse   — warehouse_inventory_levels authoritative
--   * shopify     — webhook / API reading
--   * woocommerce
--   * squarespace
--   * bandcamp

CREATE TABLE IF NOT EXISTS stock_stability_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  observed_at_local timestamptz NOT NULL DEFAULT now(),
  available integer,
  committed integer,
  atp integer,
  remote_stock_listed boolean,
  clock_skew_ms integer,
  sampler_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, variant_id, source, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_stock_stability_readings_lookup
  ON stock_stability_readings(workspace_id, variant_id, source, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_stability_readings_purge
  ON stock_stability_readings(created_at);

ALTER TABLE stock_stability_readings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stock_stability_readings'
      AND policyname = 'staff_all'
  ) THEN
    CREATE POLICY staff_all ON stock_stability_readings
      FOR ALL TO authenticated
      USING (is_staff_user())
      WITH CHECK (is_staff_user());
  END IF;
END
$$;

COMMENT ON TABLE stock_stability_readings IS
  'Rolling stock readings for the stability gate (rankSkuCandidates tiebreak + hold-queue severity upgrade). UNIQUE(workspace_id, variant_id, source, observed_at) + ON CONFLICT DO NOTHING makes the sampler idempotent across Trigger.dev double-deliveries. Retain 30d; older rows purged nightly.';

-- ══════════════════════════════════════════════════════════════════════════
-- Section I — promote_identity_match_to_alias RPC
-- ══════════════════════════════════════════════════════════════════════════
--
-- Identity-only rows become live aliases only through this function. It
-- delegates the live alias write to the existing persist_sku_match RPC
-- so Rule #20 / #22 / #33 invariants + fingerprint protection stay
-- intact.
--
-- Pre-promotion gate contract (each raises if it fails):
--   * identity row is active and in `auto_database_identity_match`
--   * variant_id resolved; workspace + org scope aligned
--   * connection active, not do_not_fanout, cutover ∈ {legacy,shadow,direct},
--     connection_status ∈ {pending?, active, ...} — must match
--     shouldFanoutToConnection() preconditions at DB boundary
--   * expected_state_version matches current (OCC)
--   * current ATP (available − committed) > 0, read live from
--     warehouse_inventory_levels (not the stored warehouse_stock_at_match)
--   * Shopify platform → remote_inventory_item_id not null
--
-- Also takes pg_advisory_xact_lock('sku_transition:' || id) FIRST so the
-- webhook thundering herd queues at the row level instead of 100
-- concurrent transactions all aborting on OCC and retrying.
--
-- Feature-flag checks (sku_live_alias_autonomy_enabled) live in the TS
-- wrapper, because flags read through the cached getWorkspaceFlags().

CREATE OR REPLACE FUNCTION promote_identity_match_to_alias(
  p_identity_match_id uuid,
  p_expected_state_version integer,
  p_reason_code text,
  p_triggered_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match client_store_product_identity_matches%rowtype;
  v_connection client_store_connections%rowtype;
  v_variant warehouse_product_variants%rowtype;
  v_current_available integer;
  v_current_committed integer;
  v_current_atp integer;
  v_alias_id uuid;
BEGIN
  -- Pessimistic per-row lock. Transaction-scoped; released on commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('sku_transition:' || p_identity_match_id::text));

  SELECT * INTO v_match
    FROM client_store_product_identity_matches
   WHERE id = p_identity_match_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: identity match % not found', p_identity_match_id;
  END IF;

  IF v_match.is_active = false
     OR v_match.outcome_state <> 'auto_database_identity_match' THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: identity match % not in promotable state (state=%, active=%)',
      p_identity_match_id, v_match.outcome_state, v_match.is_active;
  END IF;

  IF v_match.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: state_version drift for % (expected %, got %)',
      p_identity_match_id, p_expected_state_version, v_match.state_version;
  END IF;

  IF v_match.variant_id IS NULL
     OR v_match.canonical_resolution_state <> 'resolved_to_variant' THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: identity match % has no canonical variant', p_identity_match_id;
  END IF;

  SELECT * INTO v_connection
    FROM client_store_connections
   WHERE id = v_match.connection_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: connection % missing', v_match.connection_id;
  END IF;

  IF v_connection.do_not_fanout = true
     OR v_connection.connection_status IN ('disabled_auth_failure', 'error', 'pending')
     OR v_connection.cutover_state NOT IN ('legacy', 'shadow', 'direct') THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: connection % not eligible (status=%, do_not_fanout=%, cutover=%)',
      v_match.connection_id, v_connection.connection_status, v_connection.do_not_fanout, v_connection.cutover_state;
  END IF;

  SELECT * INTO v_variant
    FROM warehouse_product_variants
   WHERE id = v_match.variant_id;

  IF NOT FOUND
     OR v_variant.workspace_id <> v_match.workspace_id
     OR v_variant.workspace_id <> v_connection.workspace_id
     OR v_match.org_id <> v_connection.org_id THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: scope mismatch for match %', p_identity_match_id;
  END IF;

  -- Live ATP re-check. The stored warehouse_stock_at_match is EVIDENCE,
  -- not authority. Uses (available − committed) mirroring
  -- computeEffectiveSellable(). Safety stock is applied by the TS caller,
  -- not in this function (the RPC does not know the per-channel safety
  -- stock row to apply).
  SELECT
      COALESCE(sum(available), 0),
      COALESCE(sum(committed_quantity), 0)
    INTO v_current_available, v_current_committed
    FROM warehouse_inventory_levels
   WHERE variant_id = v_match.variant_id
     AND workspace_id = v_match.workspace_id;

  v_current_atp := GREATEST(0, v_current_available - v_current_committed);

  IF v_current_atp IS NULL OR v_current_atp <= 0 THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: current warehouse ATP not positive for variant % (available=%, committed=%)',
      v_match.variant_id, v_current_available, v_current_committed;
  END IF;

  IF v_match.platform = 'shopify' AND v_match.remote_inventory_item_id IS NULL THEN
    RAISE EXCEPTION 'promote_identity_match_to_alias: Shopify match % missing remote_inventory_item_id', p_identity_match_id;
  END IF;

  -- Delegate to the existing alias write path. actor_id is NULL because
  -- this is an autonomous system promotion. match_reasons is an empty
  -- array; the real reasoning lives in evidence_snapshot (persisted as
  -- candidate_snapshot in the sku_mapping_events row).
  v_alias_id := persist_sku_match(
    v_match.workspace_id,
    v_match.connection_id,
    v_match.variant_id,
    v_match.remote_product_id,
    v_match.remote_variant_id,
    v_match.remote_inventory_item_id,
    v_match.remote_sku,
    NULL,
    v_match.match_method,
    v_match.match_confidence,
    '[]'::jsonb,
    COALESCE(v_match.evidence_snapshot, '{}'::jsonb),
    NULL,
    'promoted_from_identity_match'
  );

  UPDATE client_store_product_identity_matches
     SET promoted_to_alias_at = now(),
         promoted_alias_id = v_alias_id,
         is_active = false,
         state_version = state_version + 1,
         updated_at = now()
   WHERE id = p_identity_match_id;

  INSERT INTO sku_outcome_transitions (
    workspace_id,
    connection_id,
    variant_id,
    from_state,
    to_state,
    trigger,
    reason_code,
    evidence_snapshot,
    identity_match_id,
    alias_id,
    triggered_by
  ) VALUES (
    v_match.workspace_id,
    v_match.connection_id,
    v_match.variant_id,
    'auto_database_identity_match',
    'auto_live_inventory_alias',
    'stock_change',
    COALESCE(p_reason_code, 'stock_positive_promotion'),
    COALESCE(v_match.evidence_snapshot, '{}'::jsonb),
    p_identity_match_id,
    v_alias_id,
    p_triggered_by
  );

  RETURN v_alias_id;
END;
$$;

GRANT EXECUTE ON FUNCTION promote_identity_match_to_alias(uuid, integer, text, text) TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- Section J — compute_bandcamp_linkage_metrics RPC
-- ══════════════════════════════════════════════════════════════════════════
--
-- Phase advancement check source of truth. Mirrored by the read-only
-- baseline script in scripts/_sku-matcher-linkage-baseline.ts so the
-- baseline can be measured before this migration lands.
--
-- Reads verified URLs from bandcamp_product_mappings.bandcamp_url (the
-- authoritative scraper/API link column), NOT warehouse_products (which
-- has no bandcamp_url) or warehouse_product_variants (legacy free-form).
-- bandcamp_product_mappings has no soft-delete; row existence implies a
-- current link.

CREATE OR REPLACE FUNCTION compute_bandcamp_linkage_metrics(
  p_workspace_id uuid,
  p_org_id uuid
) RETURNS TABLE (
  total_canonical_variants bigint,
  variants_with_bandcamp_mapping bigint,
  variants_with_verified_bandcamp_url bigint,
  variants_with_option_evidence bigint,
  linkage_rate numeric,
  verified_rate numeric,
  option_rate numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pool AS (
    SELECT v.id
      FROM warehouse_product_variants v
      JOIN warehouse_products p ON p.id = v.product_id
     WHERE v.workspace_id = p_workspace_id
       AND p.org_id = p_org_id
  ),
  totals AS (SELECT count(*)::bigint AS total FROM pool),
  mapped AS (
    SELECT count(DISTINCT m.variant_id)::bigint AS n
      FROM bandcamp_product_mappings m
     WHERE m.variant_id IN (SELECT id FROM pool)
  ),
  verified AS (
    SELECT count(DISTINCT m.variant_id)::bigint AS n
      FROM bandcamp_product_mappings m
     WHERE m.variant_id IN (SELECT id FROM pool)
       AND m.bandcamp_url IS NOT NULL
  ),
  optioned AS (
    SELECT count(DISTINCT v.id)::bigint AS n
      FROM warehouse_product_variants v
     WHERE v.id IN (SELECT id FROM pool)
       AND v.bandcamp_option_id IS NOT NULL
  )
  SELECT
    totals.total,
    mapped.n,
    verified.n,
    optioned.n,
    CASE WHEN totals.total = 0 THEN 0 ELSE (mapped.n::numeric / totals.total) END,
    CASE WHEN totals.total = 0 THEN 0 ELSE (verified.n::numeric / totals.total) END,
    CASE WHEN totals.total = 0 THEN 0 ELSE (optioned.n::numeric / totals.total) END
  FROM totals, mapped, verified, optioned;
$$;

GRANT EXECUTE ON FUNCTION compute_bandcamp_linkage_metrics(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
