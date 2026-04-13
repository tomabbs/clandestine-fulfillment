-- Scraper Hardening V2: circuit breaker, dead-URL lifecycle, auto-reconciliation
-- Plan: harden_bandcamp_scraper_5cc5b271

-- 1. Domain health table (PK is composite: workspace_id + subdomain)
CREATE TABLE IF NOT EXISTS bandcamp_domain_health (
  workspace_id        uuid NOT NULL REFERENCES workspaces(id),
  subdomain           text NOT NULL,
  state               text NOT NULL DEFAULT 'closed'
                      CHECK (state IN ('closed', 'half_open', 'open')),
  failure_count       int NOT NULL DEFAULT 0,
  success_count       int NOT NULL DEFAULT 0,
  last_failure_at     timestamptz,
  last_success_at     timestamptz,
  opened_at           timestamptz,
  cooldown_until      timestamptz,
  cooldown_seconds    int NOT NULL DEFAULT 900,
  recent_429_count    int NOT NULL DEFAULT 0,
  recent_success_count int NOT NULL DEFAULT 0,
  effective_rps       numeric NOT NULL DEFAULT 1.0,
  metrics_window_start timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  PRIMARY KEY (workspace_id, subdomain)
);

-- 2. Dead URL lifecycle columns on bandcamp_product_mappings
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS scrape_status text NOT NULL DEFAULT 'active'
    CHECK (scrape_status IN ('active', 'probation', 'dead')),
  ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_reason text
    CHECK (last_failure_reason IS NULL OR last_failure_reason IN (
      'rate_limited', 'not_found', 'gone', 'timeout',
      'parse_failure', 'category_mismatch', 'server_error',
      'dead_probe_failed', 'backfill'
    )),
  ADD COLUMN IF NOT EXISTS last_http_status int;

-- 3. Backfill scrape_status from existing failure counts.
-- Historical scrape_failure_count is not truly "consecutive" — this is a bootstrap.
-- First reconciliation cycle will clean up misclassifications.
UPDATE bandcamp_product_mappings
  SET scrape_status = 'dead', consecutive_failures = scrape_failure_count,
      last_failure_reason = 'backfill'
  WHERE scrape_failure_count >= 10;

UPDATE bandcamp_product_mappings
  SET scrape_status = 'probation', consecutive_failures = scrape_failure_count,
      last_failure_reason = 'backfill'
  WHERE scrape_failure_count >= 3 AND scrape_failure_count < 10;

-- 4. Bulk-resolve stale review queue items for mappings that now succeed
UPDATE warehouse_review_queue rq
  SET status = 'resolved', resolved_at = now()
  FROM bandcamp_product_mappings bpm
  WHERE rq.category = 'bandcamp_scraper'
    AND rq.status = 'open'
    AND (rq.metadata->>'mappingId')::uuid = bpm.id
    AND bpm.scrape_failure_count = 0
    AND bpm.last_synced_at > rq.created_at;

-- 5. Resolve merch/apparel items that should never have been flagged for album data
UPDATE warehouse_review_queue rq
  SET status = 'resolved', resolved_at = now()
  FROM bandcamp_product_mappings bpm
  WHERE rq.category = 'bandcamp_scraper'
    AND rq.status = 'open'
    AND (rq.metadata->>'mappingId')::uuid = bpm.id
    AND bpm.product_category IN ('apparel', 'merch');

-- 6. Seed domain health from existing mappings (composite PK isolates per-workspace)
INSERT INTO bandcamp_domain_health (workspace_id, subdomain)
  SELECT DISTINCT
    workspace_id,
    COALESCE(
      bandcamp_subdomain,
      SPLIT_PART(REPLACE(REPLACE(bandcamp_url, 'https://', ''), 'http://', ''), '.', 1)
    ) AS subdomain
  FROM bandcamp_product_mappings
  WHERE bandcamp_subdomain IS NOT NULL
     OR bandcamp_url IS NOT NULL
ON CONFLICT (workspace_id, subdomain) DO NOTHING;

-- 7. Index for sweep queries filtering by scrape_status
CREATE INDEX IF NOT EXISTS idx_bpm_scrape_status
  ON bandcamp_product_mappings (scrape_status)
  WHERE scrape_status IN ('active', 'probation');

-- 8. Index for review queue reconciliation
CREATE INDEX IF NOT EXISTS idx_rq_bandcamp_open
  ON warehouse_review_queue (category, status)
  WHERE category = 'bandcamp_scraper' AND status = 'open';

-- 9. RPC: atomically increment consecutive_failures and return new count + status
CREATE OR REPLACE FUNCTION increment_consecutive_failures(p_mapping_id uuid)
RETURNS TABLE(new_count int, new_status text) AS $$
  UPDATE bandcamp_product_mappings
  SET consecutive_failures = consecutive_failures + 1,
      scrape_status = CASE
        WHEN consecutive_failures + 1 >= 10 THEN 'dead'
        WHEN consecutive_failures + 1 >= 3  THEN 'probation'
        ELSE scrape_status
      END,
      updated_at = now()
  WHERE id = p_mapping_id
  RETURNING consecutive_failures AS new_count, scrape_status AS new_status;
$$ LANGUAGE SQL SECURITY DEFINER;

-- 10. RPC: atomically record circuit breaker success (SQL-native AIMD math)
CREATE OR REPLACE FUNCTION record_domain_success(p_workspace_id uuid, p_subdomain text)
RETURNS TABLE(eff_rps numeric) AS $$
  INSERT INTO bandcamp_domain_health (workspace_id, subdomain, success_count, last_success_at, state, failure_count, updated_at)
  VALUES (p_workspace_id, p_subdomain, 1, now(), 'closed', 0, now())
  ON CONFLICT (workspace_id, subdomain) DO UPDATE SET
    success_count = bandcamp_domain_health.success_count + 1,
    recent_success_count = bandcamp_domain_health.recent_success_count + 1,
    effective_rps = LEAST(2.0, bandcamp_domain_health.effective_rps + 0.1),
    last_success_at = now(),
    state = 'closed',
    failure_count = 0,
    updated_at = now()
  RETURNING effective_rps AS eff_rps;
$$ LANGUAGE SQL SECURITY DEFINER;

-- 11. RPC: atomically record circuit breaker failure (SQL-native AIMD math)
CREATE OR REPLACE FUNCTION record_domain_failure(
  p_workspace_id uuid,
  p_subdomain text,
  p_is_429 boolean DEFAULT false
)
RETURNS TABLE(fail_count int, domain_state text, cooldown timestamptz) AS $$
  INSERT INTO bandcamp_domain_health (workspace_id, subdomain, failure_count, last_failure_at, updated_at)
  VALUES (p_workspace_id, p_subdomain, 1, now(), now())
  ON CONFLICT (workspace_id, subdomain) DO UPDATE SET
    failure_count = bandcamp_domain_health.failure_count + 1,
    recent_429_count = CASE WHEN p_is_429
      THEN bandcamp_domain_health.recent_429_count + 1
      ELSE bandcamp_domain_health.recent_429_count END,
    effective_rps = CASE WHEN p_is_429
      THEN GREATEST(0.1, bandcamp_domain_health.effective_rps * 0.5)
      ELSE bandcamp_domain_health.effective_rps END,
    last_failure_at = now(),
    state = CASE
      WHEN bandcamp_domain_health.failure_count + 1 >= 5 THEN 'open'
      ELSE bandcamp_domain_health.state END,
    opened_at = CASE
      WHEN bandcamp_domain_health.failure_count + 1 >= 5
        AND bandcamp_domain_health.state != 'open' THEN now()
      ELSE bandcamp_domain_health.opened_at END,
    cooldown_until = CASE
      WHEN bandcamp_domain_health.failure_count + 1 >= 5
        AND bandcamp_domain_health.state != 'open'
        THEN now() + (bandcamp_domain_health.cooldown_seconds || ' seconds')::interval
      ELSE bandcamp_domain_health.cooldown_until END,
    updated_at = now()
  RETURNING
    bandcamp_domain_health.failure_count AS fail_count,
    bandcamp_domain_health.state AS domain_state,
    bandcamp_domain_health.cooldown_until AS cooldown;
$$ LANGUAGE SQL SECURITY DEFINER;

-- 12. Enable RLS on new table (matches project convention)
ALTER TABLE bandcamp_domain_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON bandcamp_domain_health
  FOR ALL TO service_role USING (true) WITH CHECK (true);
