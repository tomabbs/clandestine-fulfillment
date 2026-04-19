-- Phase 2.4 (drift-pulled from Phase 7.3) — Add workspaces.flags JSONB column.
--
-- The unified shipping cockpit (Phase 2.2) renders either the new cockpit
-- (when workspaces.flags.shipstation_unified_shipping = true) or the legacy
-- multi-source view via an import shim. Phase 7.3 was originally going to
-- add the column, but Phase 2.4 needs it earlier — this migration pulls it
-- forward.
--
-- Schema is intentionally a single JSONB blob so additional flags from
-- Phase 0.5.2 / 7.3 / 10.4 (rate_delta_thresholds, email_ownership,
-- shipstation_writeback_enabled, easypost_buy_enabled) can land additively
-- without further migrations.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS flags jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN workspaces.flags IS
  'Phase 2.4 / 7.3 — per-workspace feature flags. Documented keys: shipstation_unified_shipping (bool), rate_delta_thresholds ({warn,halt}), email_ownership (enum), shipstation_writeback_enabled (bool), easypost_buy_enabled (bool). Read via getWorkspaceFlags() helper.';
