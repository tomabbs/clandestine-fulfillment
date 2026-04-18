-- Phase 1 — Bandcamp baseline anomaly + multi-origin push_mode infrastructure
--
-- Scope (per plan §7.1.13, Patch A2 narrowed):
--   (a) `bandcamp_baseline_anomalies` table — one row per anomalous package/option,
--       keyed by (workspace_id, band_id, package_id, option_id) for upsert idempotency.
--   (b) `bandcamp_push_mode` enum + four audit columns on `bandcamp_product_mappings`.
--   (c) Partial index on push_mode for fast "blocked" queries.
--
-- Deliberately EXCLUDED (already shipped or owned by other phases):
--   - `bandcamp_origin_quantities` and `raw_api_data` columns: shipped in
--     20260402210000_bandcamp_api_complete.sql.
--   - `sku_sync_conflicts`, `sku_remap_history`, `external_sync_events`: shipped in
--     20260417000001_sku_rectify_infrastructure.sql (Phase 0.5).
--   - `sku_sync_status` view: deferred to Phase 5.
--
-- Rollback note: drop the four columns, drop the table, drop the enum.
-- All operations are IF NOT EXISTS / DO $$ BEGIN ... EXCEPTION duplicate_object guarded
-- so the migration is re-runnable (no-op if already applied).

-- ─── bandcamp_baseline_anomalies ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bandcamp_baseline_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  band_id bigint NOT NULL,
  package_id bigint NOT NULL,
  -- option_id NULL ⇒ package-level (no per-size options) anomaly
  option_id bigint,
  sku text,
  baseline_qty integer NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  notes text
);

-- Idempotency key for upsert — one anomaly row per (workspace, band, package, option).
-- The partial unique indexes split the NULL vs non-NULL option_id cases, because
-- Postgres treats NULL as distinct in a regular UNIQUE constraint, which would
-- allow duplicate package-level rows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_baseline_anomaly_with_option
  ON bandcamp_baseline_anomalies (workspace_id, band_id, package_id, option_id)
  WHERE option_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_baseline_anomaly_package_only
  ON bandcamp_baseline_anomalies (workspace_id, band_id, package_id)
  WHERE option_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_baseline_anomalies_workspace_open
  ON bandcamp_baseline_anomalies (workspace_id, detected_at DESC)
  WHERE resolved_at IS NULL;

-- ─── bandcamp_push_mode enum ────────────────────────────────────────────────
-- Per the second-pass reviewer, replace any earlier `seed_blocked` boolean concept
-- with an enum so the four real operating states are explicit and surfaceable in admin UI.
DO $$ BEGIN
  CREATE TYPE bandcamp_push_mode AS ENUM (
    'normal',                 -- safe to push origin allocations; no known issues
    'blocked_baseline',       -- non-zero merchant baseline detected; pushes are no-ops until merchant zeros it
    'blocked_multi_origin',   -- merchant has multiple shipping origins; need explicit origin_id per push (deferred until per-origin loop)
    'manual_override'         -- staff has flagged this product to skip automated push (e.g. preorder window, recall) — NEVER auto-cleared
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── bandcamp_product_mappings audit columns ────────────────────────────────
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS push_mode bandcamp_push_mode NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS push_mode_reason text,
  ADD COLUMN IF NOT EXISTS push_mode_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_mode_set_by uuid REFERENCES users(id);

-- Partial index — admin pages and the inventory-push task only ever filter for
-- non-`normal` rows; index keeps the common case (`normal`) out of the index
-- for write speed.
CREATE INDEX IF NOT EXISTS idx_bandcamp_mappings_push_mode
  ON bandcamp_product_mappings (workspace_id, push_mode)
  WHERE push_mode <> 'normal';

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE bandcamp_baseline_anomalies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all ON bandcamp_baseline_anomalies;
CREATE POLICY staff_all ON bandcamp_baseline_anomalies
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

-- bandcamp_product_mappings already has RLS from the original migration; the new
-- columns inherit the existing policies. No extra GRANT/POLICY needed.
