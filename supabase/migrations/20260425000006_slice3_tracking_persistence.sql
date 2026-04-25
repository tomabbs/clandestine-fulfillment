-- Slice 3 — tracking persistence + public-page hardening.
--
-- Promotes destination + EasyPost tracker metadata from the catch-all
-- `warehouse_shipments.label_data` JSONB to first-class columns so the
-- public `/track/[token]` page never has to read `label_data` at all.
-- This is the schema half of Slice 3; the application half lives in:
--   - src/trigger/tasks/create-shipping-label.ts (writes destination + tracker)
--   - src/trigger/tasks/easypost-register-tracker.ts (writes tracker columns)
--   - src/app/api/webhooks/easypost/route.ts (uses safe RPC + tracker columns)
--   - src/app/track/[token]/page.tsx (reads ONLY allowlist columns)
--   - src/lib/shared/public-track-token.ts (pickPublicDestination + buildCarrierTrackingUrl)
--
-- All changes are additive + idempotent — re-running on a half-applied
-- environment is safe.

BEGIN;

-- ── 1. Public-safe destination columns ──────────────────────────────────
-- City / state / country only. NEVER street1/street2/zip/email/phone —
-- those are PII and have no public-page use case. zip prefix was
-- considered + rejected per v4 review (PII surface without concrete UX
-- value).
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS destination_city text,
  ADD COLUMN IF NOT EXISTS destination_state text,
  ADD COLUMN IF NOT EXISTS destination_country text;

-- Defense-in-depth: a future writer that smuggles a street address into
-- destination_city ("123 Main St") will be rejected by Postgres. The
-- check is permissive enough to allow real city names ("St. Louis",
-- "Saint Cloud"), but blocks the obvious "<digits> <space> <word>"
-- pattern that street addresses always start with. POSIX bracket
-- classes ([[:space:]] / [[:alnum:]]) are used instead of \s / \w so
-- the regex semantics are stable across string-literal modes.
ALTER TABLE warehouse_shipments
  DROP CONSTRAINT IF EXISTS chk_destination_city_no_street;
ALTER TABLE warehouse_shipments
  ADD CONSTRAINT chk_destination_city_no_street
  CHECK (
    destination_city IS NULL
    OR destination_city !~ '^[0-9]+[[:space:]]+[[:alnum:]]'
  );

-- ── 2. EasyPost tracker columns ─────────────────────────────────────────
-- Promoted from label_data JSONB so the EP webhook + public page don't
-- re-parse JSON on every request. label_data remains as a fallback during
-- the backfill window.
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS easypost_tracker_id text,
  ADD COLUMN IF NOT EXISTS easypost_tracker_public_url text,
  ADD COLUMN IF NOT EXISTS easypost_tracker_status text,
  ADD COLUMN IF NOT EXISTS last_tracking_status_detail text,
  ADD COLUMN IF NOT EXISTS last_tracking_status_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_warehouse_shipments_tracker
  ON warehouse_shipments(easypost_tracker_id)
  WHERE easypost_tracker_id IS NOT NULL;

COMMENT ON COLUMN warehouse_shipments.easypost_tracker_status IS
  'Slice 3 — EasyPost tracker status, updated by update_shipment_tracking_status_safe RPC. Sticky terminals: delivered, return_to_sender, cancelled, failure, error.';

-- ── 3. Tracking-event provider id (Option A — preferred) ────────────────
-- Adds a stable per-event identifier so retries / replay never duplicate
-- a row. Option B (computed dedup key) is the fallback when the provider
-- doesn't supply one, but Option A is simpler + faster.
ALTER TABLE warehouse_tracking_events
  ADD COLUMN IF NOT EXISTS provider_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_events_provider
  ON warehouse_tracking_events(provider_event_id)
  WHERE provider_event_id IS NOT NULL;

COMMENT ON COLUMN warehouse_tracking_events.provider_event_id IS
  'Slice 3 — stable per-event identifier from provider (EasyPost tracking_details[].id). UNIQUE partial index makes idempotent inserts a no-op on retry.';

COMMIT;
