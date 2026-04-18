-- Phase 6 (finish-line plan v4) — ramp-halt-criteria-sensor cross-run state.
--
-- Stores cross-run state for the sensor:
--   { lastSpotCheckTripped: bool, lastEvaluatedAt: iso, lastSensorRun: id }
-- Used for §5.3 two-consecutive-runs persistence on H-3 (spot-check
-- drift_major). The sensor reads + writes this on every run.
--
-- Idempotent — additive `ADD COLUMN IF NOT EXISTS`.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS ramp_sensor_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN workspaces.ramp_sensor_state IS
  'Phase 6 (finish-line plan v4) — cross-run state for ramp-halt-criteria-sensor. Shape: { lastSpotCheckTripped: bool, lastEvaluatedAt: iso, lastSensorRun: id }. Supports §5.3 two-consecutive-runs persistence on H-3.';
