-- Scraper observability: sensor index, catalog stats snapshot, scraper settings
-- Part of: scraper_status_and_self-heal plan §8 Phase A

-- 1. Partial index for sensor queries on channel_sync_log
--    Covers pattern: latest completed row per workspace + sync_type
--    status has a NOT NULL CHECK constraint, so WHERE status IS NOT NULL is useless;
--    WHERE status = 'completed' is a meaningful partial filter.
CREATE INDEX IF NOT EXISTS idx_channel_sync_log_sensor
  ON channel_sync_log (workspace_id, sync_type, created_at DESC)
  WHERE status = 'completed';

-- 2. Snapshot table for catalog completeness aggregates (§1b.E)
--    Avoids expensive live joins across mappings × products × variants × images.
--    Refreshed by scheduled Trigger task (default nightly) + on-demand staff action.
CREATE TABLE IF NOT EXISTS workspace_catalog_stats (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stats        jsonb NOT NULL DEFAULT '{}',
  computed_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspace_catalog_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read catalog stats"
  ON workspace_catalog_stats FOR SELECT
  USING (true);

CREATE POLICY "Service role can upsert catalog stats"
  ON workspace_catalog_stats FOR ALL
  USING (true)
  WITH CHECK (true);

-- 3. Scraper settings jsonb on workspaces (§8 Phase B field toggles)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workspaces' AND column_name = 'bandcamp_scraper_settings'
  ) THEN
    ALTER TABLE workspaces
      ADD COLUMN bandcamp_scraper_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;
