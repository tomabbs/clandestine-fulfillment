-- Phase 6 (finish-line plan v4) — fanout rollout audit trail.
--
-- Adds an additive JSONB array column `fanout_rollout_audit` to `workspaces`.
-- Each invocation of `setFanoutRolloutPercentInternal` appends an audit row
-- with shape:
--   { ts, percent_before, percent_after, reason, actor: { kind, id }, sensor_run? }
--
-- Idempotent — if the column already exists, this is a no-op. Default '{}'
-- means existing rows stay valid; the column is non-null.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS fanout_rollout_audit jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN workspaces.fanout_rollout_audit IS
  'Phase 6 (finish-line plan v4) — append-only audit trail of every fanout_rollout_percent change. Each element: { ts, percent_before, percent_after, reason, actor:{kind,id}, sensor_run? }. Written by setFanoutRolloutPercentInternal in src/lib/server/admin-rollout-internal.ts. Both the staff Server Action wrapper and the ramp-halt-criteria-sensor write through that single helper to keep the audit shape consistent.';

