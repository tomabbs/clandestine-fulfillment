-- Phase 3 Pass 1 — Direct-Shopify cutover state machine + shadow ledger + echo override.
--
-- Plan reference: bandcamp_shopify_enterprise_sync_a448cf6a.plan.md, §9.4
-- "Phase 3 — Direct-Shopify cutover at scale", deliverables D1, D2, D4.
--
-- This migration is the foundation Pass 1 lands. It is strictly ADDITIVE:
--   * `cutover_state` defaults to 'legacy' for every existing connection
--   * the per-connection echo override table starts empty (zero rows = no
--     behavior change)
--   * the shadow log table starts empty (writes only on shadow-mode push)
-- so applying this migration on production produces ZERO observable change
-- in fanout / echo / push behavior. Pass 2 adds the actual shadow write hook,
-- the diagnostics Server Action, and the cutover wizard.
--
-- Truth-doc invariants this migration enables (cf. TRUTH_LAYER.md "Direct-
-- Shopify cutover finish-line invariants"):
--   * `cutover_state` is ORTHOGONAL to `do_not_fanout` (X-4 audit fix). The
--     two columns interact via the truth table in plan §9.4 D1; the DB
--     CHECK constraint below enforces the invalid combinations at the
--     write boundary so any code-side bug cannot land a row that Pass 2's
--     state machine would interpret incorrectly.
--   * `connection_shadow_log` rows are append-only ledger entries with
--     `match` and `drift_units` columns deliberately nullable so the Pass 2
--     write hook can persist the "would_push" half synchronously, leaving
--     the "actually_pushed" half to a 60s-delayed `shadow-mode-comparison`
--     Trigger task.
--   * `connection_echo_overrides` is a per-connection lookup that the
--     `shouldEchoSkipShipstationV2()` helper consults before falling back
--     to the static SHIPSTATION_V2_ECHO_SOURCES set. A row with
--     `override_type='exclude_from_v2_echo'` removes the connection's
--     storefront events from the echo set — used at cutover-complete time
--     so the connection's webhooks fanout to v2 (since SS Inventory Sync
--     no longer mirrors that connection).
--
-- Idempotent throughout (`IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`).
-- Reversible via `DROP COLUMN` + `DROP TABLE`; no data backfill, no
-- destructive change to existing rows.

-- ─── Section A — client_store_connections cutover columns ───────────────────
--
-- `cutover_state` enum: legacy | shadow | direct
--   * legacy  = pre-cutover state. Either dormant (do_not_fanout=true,
--               Phase 0.8 default for Shopify connections) or active legacy
--               fanout. SS Inventory Sync owns mirroring.
--   * shadow  = we push directly AND SS still mirrors. Every push event
--               also writes to connection_shadow_log for 7-day comparison.
--   * direct  = cutover complete. We push directly; the connection's
--               storefront type is removed from the echo set via a row in
--               connection_echo_overrides; SS becomes label-only for this
--               connection.
--
-- Audit columns:
--   * cutover_started_at      — first transition out of 'legacy'
--   * cutover_completed_at    — transition to 'direct'
--   * shadow_mode_log_id      — pointer to the canonical shadow_log row
--                                that gated the shadow→direct flip (used
--                                by Pass 2 diagnostics to back-link the
--                                7-day window)
--   * shadow_window_tolerance_seconds — per-connection override of the
--     default 60s "wait this long before reading SS state" window. NULL
--     means "use the default". Required by release gate C.2.7 (Pass 2)
--     which asserts the column is bounded if set.

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS cutover_state text NOT NULL DEFAULT 'legacy';

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS cutover_started_at timestamptz;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS cutover_completed_at timestamptz;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS shadow_mode_log_id uuid;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS shadow_window_tolerance_seconds integer;

-- Enum check constraint. Drop-then-add for idempotency on re-runs.
ALTER TABLE client_store_connections
  DROP CONSTRAINT IF EXISTS client_store_connections_cutover_state_check;

ALTER TABLE client_store_connections
  ADD CONSTRAINT client_store_connections_cutover_state_check
  CHECK (cutover_state IN ('legacy', 'shadow', 'direct'));

-- Truth-table invariant (X-4 audit fix). cutover_state IN ('shadow','direct')
-- means we ARE pushing — `do_not_fanout = true` would contradict that and
-- produce silent dormancy in a connection an operator believes is mid-
-- cutover. Reject the combination at the DB boundary so no Server Action
-- bug, hand-fired SQL, or future migration can land it.
ALTER TABLE client_store_connections
  DROP CONSTRAINT IF EXISTS client_store_connections_cutover_dormancy_check;

ALTER TABLE client_store_connections
  ADD CONSTRAINT client_store_connections_cutover_dormancy_check
  CHECK (NOT (cutover_state IN ('shadow', 'direct') AND do_not_fanout = true));

-- shadow_window_tolerance_seconds bounds: 30s minimum (anything shorter
-- and SS Inventory Sync hasn't reliably mirrored yet — see §9.4 D2 60s
-- default rationale), 600s maximum (an operator setting a higher value
-- effectively disables shadow-mode comparison).
ALTER TABLE client_store_connections
  DROP CONSTRAINT IF EXISTS client_store_connections_shadow_window_check;

ALTER TABLE client_store_connections
  ADD CONSTRAINT client_store_connections_shadow_window_check
  CHECK (
    shadow_window_tolerance_seconds IS NULL
    OR (shadow_window_tolerance_seconds BETWEEN 30 AND 600)
  );

COMMENT ON COLUMN client_store_connections.cutover_state IS
  'Phase 3 D1: cutover state machine for direct-Shopify pivot. Values: legacy (pre-cutover, SS-mirror owns inventory), shadow (we push directly AND SS still mirrors; every push also writes to connection_shadow_log), direct (cutover complete; per-connection echo override removes this row from SHIPSTATION_V2_ECHO_SOURCES so webhooks fanout to v2). Default legacy. Orthogonal to do_not_fanout — see truth table in plan §9.4 D1. Invalid combinations rejected by client_store_connections_cutover_dormancy_check.';

COMMENT ON COLUMN client_store_connections.cutover_started_at IS
  'Phase 3 D1: wall-clock of first transition out of cutover_state=legacy (typically into shadow). Drives the 7-day rolling diagnostics window in getCutoverDiagnostics() (Pass 2).';

COMMENT ON COLUMN client_store_connections.cutover_completed_at IS
  'Phase 3 D1: wall-clock of transition to cutover_state=direct. Set by runConnectionCutover() (Pass 2 Server Action) at the same moment the connection_echo_overrides row is inserted.';

COMMENT ON COLUMN client_store_connections.shadow_mode_log_id IS
  'Phase 3 D1: pointer to the canonical connection_shadow_log row that gated the shadow→direct flip. Diagnostic forensics — backlinks "which run satisfied the 99% match gate?" The FK is intentionally NOT enforced because connection_shadow_log rows have a 90-day retention; preserving this column past retention is acceptable as a soft pointer.';

COMMENT ON COLUMN client_store_connections.shadow_window_tolerance_seconds IS
  'Phase 3 D2: per-connection override of the default 60s shadow-mode comparison window (read SS state this many seconds after we push directly). NULL = default. Bounded 30–600s — a connection that needs >600s to mirror is a SS Inventory Sync health problem, not a shadow-window tuning problem.';

-- ─── Section B — connection_shadow_log table ────────────────────────────────
--
-- Shadow-mode comparison ledger. Every direct push from a connection in
-- cutover_state='shadow' inserts a row here at push time (with would_push,
-- correlation_id, leaving actual_pushed/match/drift_units NULL); the
-- 60s-delayed shadow-mode-comparison Trigger task fills in the SS-side
-- columns and computes match.
--
-- Indexed for the diagnostics query (last 7 days for one connection,
-- grouped by match outcome) and for the comparison task's "find unmatched
-- rows older than tolerance" sweep (defense-in-depth for tasks that fail
-- to enqueue their delayed companion).

CREATE TABLE IF NOT EXISTS connection_shadow_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  -- Stable correlation ID from the originating recordInventoryChange call.
  -- Allows back-linking from external_sync_events on the same correlation_id.
  correlation_id text NOT NULL,
  sku text NOT NULL,
  -- What we computed and pushed directly to the storefront.
  pushed_quantity integer NOT NULL,
  -- Wall-clock of the direct push. The comparison task waits
  -- `shadow_window_tolerance_seconds` (default 60) past this before reading
  -- SS state.
  pushed_at timestamptz NOT NULL DEFAULT now(),
  -- What ShipStation v2 holds for this SKU when we read it after the
  -- comparison window. NULL until the comparison task fills it.
  ss_observed_quantity integer,
  -- Wall-clock of the SS read.
  observed_at timestamptz,
  -- TRUE iff pushed_quantity == ss_observed_quantity (v2 lag is zero or v2
  -- silently absorbed our value via SS Inventory Sync mirror). NULL until
  -- the comparison task runs.
  match boolean,
  -- ss_observed_quantity - pushed_quantity. Positive = SS holds more than we
  -- pushed (sale we missed; v2 mirror has a stronger truth). Negative = SS
  -- lag (will catch up). NULL until comparison runs.
  drift_units integer,
  -- The connection's `cutover_state` at push time. Captured here so we can
  -- diagnose "this row was logged in shadow mode then the connection went
  -- to direct mid-window" cases.
  cutover_state_at_push text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connection_shadow_log_diagnostics
  ON connection_shadow_log (connection_id, pushed_at DESC);

CREATE INDEX IF NOT EXISTS idx_connection_shadow_log_unresolved
  ON connection_shadow_log (pushed_at)
  WHERE match IS NULL;

CREATE INDEX IF NOT EXISTS idx_connection_shadow_log_correlation
  ON connection_shadow_log (correlation_id);

COMMENT ON TABLE connection_shadow_log IS
  'Phase 3 D2: shadow-mode comparison ledger. Direct-push half written synchronously; SS-observed half filled in by the 60s-delayed shadow-mode-comparison Trigger task. 90-day retention (TBD: companion retention task in Pass 2 / Phase 7). Drives getCutoverDiagnostics() (Pass 2 D3).';

-- ─── Section C — connection_echo_overrides table ────────────────────────────
--
-- Per-connection override of the static SHIPSTATION_V2_ECHO_SOURCES set
-- in inventory-fanout.ts. A row with override_type='exclude_from_v2_echo'
-- means: when an inventory event from this connection's storefront fires
-- a fanout, do NOT echo-skip the v2 push (because SS Inventory Sync no
-- longer mirrors this connection — operator disabled it at cutover-direct
-- time). The presence of a row is the override; we don't need a "value"
-- column today.
--
-- Future override types (kept open for the schema): NOTE that any new
-- override_type value MUST be added to the CHECK constraint below to be
-- accepted at the DB boundary.

CREATE TABLE IF NOT EXISTS connection_echo_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  -- Discriminator. Today only 'exclude_from_v2_echo' is supported; future
  -- override types (e.g. 'echo_only_for_topics') would land here.
  override_type text NOT NULL,
  -- Operator who created the override (for audit). NULL for migration-time
  -- inserts (none today).
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Allow soft-deactivation without DELETE so we keep the audit history.
  -- Active-only rows are looked up via the partial unique index below.
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT connection_echo_overrides_type_check
    CHECK (override_type IN ('exclude_from_v2_echo'))
);

-- Partial unique index — at most one ACTIVE row per (connection_id,
-- override_type). Idempotent reactivation: deactivate first, then insert
-- new active row, OR flip is_active back to true. The presence-as-override
-- semantics make duplicate active rows meaningless, so the unique index
-- is the source of truth.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_echo_overrides_active
  ON connection_echo_overrides (connection_id, override_type)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_connection_echo_overrides_lookup
  ON connection_echo_overrides (connection_id, override_type, is_active);

COMMENT ON TABLE connection_echo_overrides IS
  'Phase 3 D4: per-connection override of the static SHIPSTATION_V2_ECHO_SOURCES set. A row with override_type=exclude_from_v2_echo removes the connection from the echo set so its storefront-driven fanouts re-enable v2 push. Inserted by runConnectionCutover() (Pass 2 D4) at cutover-direct time. shouldEchoSkipShipstationV2(source, connectionId) consults this table.';

-- ─── Section D — RLS ──────────────────────────────────────────────────────
--
-- Both new tables are operator/staff-facing (no client-portal exposure).
-- service_role writes everything; the staff RLS policy uses is_staff_user()
-- so the admin Channels page can read directly without elevated privileges.

ALTER TABLE connection_shadow_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_connection_shadow_log"
  ON connection_shadow_log;

CREATE POLICY "staff_read_connection_shadow_log"
  ON connection_shadow_log
  FOR SELECT
  TO authenticated
  USING (is_staff_user());

ALTER TABLE connection_echo_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_connection_echo_overrides"
  ON connection_echo_overrides;

CREATE POLICY "staff_read_connection_echo_overrides"
  ON connection_echo_overrides
  FOR SELECT
  TO authenticated
  USING (is_staff_user());

-- ─── Section E — PostgREST schema reload ───────────────────────────────────
NOTIFY pgrst, 'reload schema';
