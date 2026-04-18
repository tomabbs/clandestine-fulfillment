-- Tier 1 hardening (Part 14.7) — items 1, 13, 14
--
-- 1. Per-integration kill switches: granular pause flags per fanout target.
--    `workspaces.inventory_sync_paused` (added 2026-04-14) is global; once
--    Phase 4 wires the bidirectional bridge, operators need to pause a
--    single integration without disabling everything else (e.g. pause
--    Bandcamp pushes after a baseline-anomaly incident while ShipStation
--    fanout keeps working).
--
-- 13. Percentage rollouts: `fanout_rollout_percent` (0-100) lets us ramp
--     the Bandcamp ↔ ShipStation fanout from 0% → 10% → 50% → 100% per
--     workspace. The fanout helper hashes the correlation_id and skips if
--     hash%100 >= rollout_percent. Default 100 preserves current behaviour
--     for workspaces that exist before Phase 4 ships; new workspaces start
--     at 0 and graduate explicitly.
--
-- 14. external_sync_events retention support: index on
--     (status, completed_at) so the daily retention sweep does not table
--     scan. The sweep deletes status='success' rows older than 7 days and
--     status='error' rows older than 30 days.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS shipstation_sync_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bandcamp_sync_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS clandestine_shopify_sync_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_store_sync_paused boolean NOT NULL DEFAULT false;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS shipstation_sync_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipstation_sync_paused_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS bandcamp_sync_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS bandcamp_sync_paused_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS clandestine_shopify_sync_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS clandestine_shopify_sync_paused_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS client_store_sync_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_store_sync_paused_by uuid REFERENCES users(id);

COMMENT ON COLUMN workspaces.shipstation_sync_paused IS
  'Tier 1 hardening #1 — per-integration kill switch. When true, ShipStation v2 fanout (decrements + pushes) short-circuits at the fanout helper.';
COMMENT ON COLUMN workspaces.bandcamp_sync_paused IS
  'Tier 1 hardening #1 — per-integration kill switch for Bandcamp update_quantities pushes.';
COMMENT ON COLUMN workspaces.clandestine_shopify_sync_paused IS
  'Tier 1 hardening #1 — per-integration kill switch for Clandestine Shopify product writes.';
COMMENT ON COLUMN workspaces.client_store_sync_paused IS
  'Tier 1 hardening #1 — per-integration kill switch for the legacy first-party client-store fanout (Phase 0.8 dormancy lives on the connection row; this is the workspace-level override).';

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS fanout_rollout_percent smallint NOT NULL DEFAULT 100
    CHECK (fanout_rollout_percent BETWEEN 0 AND 100);

COMMENT ON COLUMN workspaces.fanout_rollout_percent IS
  'Tier 1 hardening #13 — percentage rollout for Phase 4 bidirectional fanout. Helper hashes correlation_id and skips when hash%100 >= percent. Default 100 (no gate) keeps existing workspaces unchanged; Phase 4 turn-on flips new workspaces to 0 and graduates them via 10 → 50 → 100.';

CREATE INDEX IF NOT EXISTS idx_external_sync_events_completed_status
  ON external_sync_events (status, completed_at)
  WHERE completed_at IS NOT NULL;

COMMENT ON INDEX idx_external_sync_events_completed_status IS
  'Tier 1 hardening #14 — supports the daily retention sweep. Partial on completed_at NOT NULL avoids indexing in_flight rows that get updated frequently.';
