-- Phase 0.5 — SKU rectify infrastructure
--
-- Plan reference: §7.1.13 (filtered to Phase 0.5 rows only). Phase 1's
-- baseline-anomaly objects, Phase 0.7's distro index, Phase 0.8's dormancy
-- switch, and Phase 5's `sku_sync_status` view are intentionally NOT shipped
-- here — see plan §8 phase table. Each will land in its own migration file
-- alongside the code that consumes it. This keeps blast radius per phase
-- predictable and rollback contained.
--
-- Tables created:
--   - sku_sync_conflicts   (queue surfaced in /admin/catalog/sku-conflicts)
--   - sku_remap_history    (per-rectify audit log; pre_image enables exact rollback)
--   - external_sync_events (plan §1.4.2 ledger; idempotency key for ALL external mutations)
--
-- All three are workspace-scoped + RLS protected. Staff get full CRUD via
-- `is_staff_user()`. Clients get SELECT on `sku_sync_conflicts` rows for
-- their own org via `get_user_org_id()` so the portal "suggest canonical"
-- page can list mismatches without leaking cross-org data.
--
-- Idempotency: every CREATE/CREATE INDEX uses IF NOT EXISTS; ENUM creation
-- (none in this file) and policy creation use DROP IF EXISTS / CREATE pairs.

-- ─── sku_sync_conflicts ──────────────────────────────────────────────────────
-- One row per detected SKU mismatch. group_key dedupes re-detections so the
-- audit cron can re-run safely (it bumps `occurrence_count` instead of
-- inserting duplicates).
CREATE TABLE IF NOT EXISTS sku_sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id),
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE SET NULL,

  -- Type taxonomy lifted from plan §7.1.13:
  --   mismatch              — same product, different SKU per platform
  --   orphan_shipstation    — SKU in ShipStation, not in our DB
  --   orphan_bandcamp       — SKU in Bandcamp, not in our DB
  --   placeholder_squarespace — Squarespace `SQ*` placeholder; needs manual remediation
  --   casing                — case-only difference (LILA-AV1 vs lila-av1)
  --   ambiguous             — multiple plausible canonicals; staff must choose
  conflict_type text NOT NULL CHECK (conflict_type IN
    ('mismatch','orphan_shipstation','orphan_bandcamp','placeholder_squarespace','casing','ambiguous')),

  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),

  our_sku text,
  bandcamp_sku text,
  shipstation_sku text,
  shopify_sku text,
  squarespace_sku text,
  woocommerce_sku text,

  example_product_title text,

  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored','client_suggested')),
  suggested_canonical_sku text,
  -- Resolution method recorded when status flips to 'resolved'. Free-text
  -- intentionally — new resolution flows can land without migrations.
  resolution_method text,

  -- group_key dedupes re-detections across audit runs. Composed by the
  -- audit task as `${workspace_id}:${conflict_type}:${our_sku || ''}:${shipstation_sku || ''}`.
  group_key text UNIQUE,
  occurrence_count integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sku_sync_conflicts_workspace_status
  ON sku_sync_conflicts (workspace_id, status, severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_sku_sync_conflicts_org_status
  ON sku_sync_conflicts (org_id, status)
  WHERE org_id IS NOT NULL;

-- ─── sku_remap_history ───────────────────────────────────────────────────────
-- Per-rectify audit log. `pre_image` is the FULL prior state of the external
-- resource (entire ShipStation product including aliases array, full Bandcamp
-- merch row, etc.) so an aborted rectify can restore byte-for-byte rather
-- than guessing what the prior aliases array contained. Plan §7.1.10 hazard 1.
CREATE TABLE IF NOT EXISTS sku_remap_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE SET NULL,

  from_sku text NOT NULL,
  to_sku text NOT NULL,

  platform text NOT NULL CHECK (platform IN
    ('our_db','bandcamp','shipstation','shipstation_alias','clandestine_shopify',
     'client_shopify','client_woocommerce','client_squarespace')),

  changed_by_user_id uuid REFERENCES users(id),
  -- correlation_id ties one rectify run across multiple `sku_remap_history`
  -- rows (e.g. one rectify that adds a ShipStation alias AND renames the
  -- Bandcamp SKU produces two rows with the same correlation_id).
  correlation_id text,
  conflict_id uuid REFERENCES sku_sync_conflicts(id),

  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','success','error','rolled_back')),
  error_message text,

  -- Plan §7.1.10: pre_image holds the FULL resource snapshot taken before the
  -- mutation; post_image holds the verified resource state after the PUT
  -- (re-GET result). Together they let a future rollback / forensics reproduce
  -- the change exactly without re-reading the live API.
  pre_image jsonb,
  post_image jsonb,

  changed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sku_remap_history_workspace
  ON sku_remap_history (workspace_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sku_remap_history_correlation
  ON sku_remap_history (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sku_remap_history_conflict
  ON sku_remap_history (conflict_id)
  WHERE conflict_id IS NOT NULL;

-- ─── external_sync_events ───────────────────────────────────────────────────
-- Plan §1.4.2. Every external mutation (ShipStation v2 increment/decrement/
-- adjust, Bandcamp updateQuantities, ShipStation v1 alias add/remove, etc.)
-- gets an in-flight row keyed by (system, correlation_id, sku, action). The
-- UNIQUE constraint is the idempotency guarantee — a duplicate task retry
-- collides on insert and the caller knows to skip the network write.
CREATE TABLE IF NOT EXISTS external_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  system text NOT NULL CHECK (system IN
    ('shipstation_v1','shipstation_v2','bandcamp','clandestine_shopify')),

  -- Stable per-logical-operation. For Bandcamp sales: the Bandcamp sale_id.
  -- For ShipStation SHIP_NOTIFY: the shipment_id. For rectify: the
  -- task_run_id of the rectify task. NEVER a random UUID per network call
  -- (per CLAUDE.md Rule #15).
  correlation_id text NOT NULL,

  sku text NOT NULL,

  action text NOT NULL CHECK (action IN
    ('increment','decrement','adjust','modify','alias_add','alias_remove','sku_rename')),

  status text NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','success','error')),

  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  request_body jsonb,
  response_body jsonb,
  retry_count integer NOT NULL DEFAULT 0,

  -- The idempotency contract. A retry of the same logical operation MUST
  -- collide here — caller catches the unique-violation, treats it as "already
  -- in flight or done" and skips the API call.
  UNIQUE (system, correlation_id, sku, action)
);

CREATE INDEX IF NOT EXISTS idx_external_sync_events_in_flight
  ON external_sync_events (status, started_at)
  WHERE status = 'in_flight';
CREATE INDEX IF NOT EXISTS idx_external_sync_events_history
  ON external_sync_events (sku, system, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_sync_events_errors
  ON external_sync_events (sku, system, completed_at DESC)
  WHERE status = 'error';

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE sku_sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_remap_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_sync_events ENABLE ROW LEVEL SECURITY;

-- Staff (admin/super_admin/label_staff/label_management/warehouse_manager)
-- get full CRUD on all three. Idempotent via DROP IF EXISTS.
DROP POLICY IF EXISTS staff_all ON sku_sync_conflicts;
CREATE POLICY staff_all ON sku_sync_conflicts
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS staff_all ON sku_remap_history;
CREATE POLICY staff_all ON sku_remap_history
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS staff_all ON external_sync_events;
CREATE POLICY staff_all ON external_sync_events
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

-- Clients can SELECT their own org's open conflicts (portal suggest UI).
-- They can also UPDATE the suggested_canonical_sku + status='client_suggested'
-- columns on their own rows. Resolution itself is staff-only by virtue of
-- needing to flip status to 'resolved' AND set resolution_method, which the
-- Server Action gates.
DROP POLICY IF EXISTS client_select_own_org ON sku_sync_conflicts;
CREATE POLICY client_select_own_org ON sku_sync_conflicts
  FOR SELECT TO authenticated
  USING (org_id IS NOT NULL AND org_id = get_user_org_id());

-- Note: client UPDATE is NOT a policy — the Server Action `suggestCanonicalSku`
-- runs with service_role to write the suggestion after validating the client's
-- org_id matches the conflict row. This mirrors the
-- `submitClientStoreCredentials` pattern (CLAUDE.md Rule #19).
