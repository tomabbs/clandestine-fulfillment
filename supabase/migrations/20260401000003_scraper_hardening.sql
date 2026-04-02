-- ============================================================
-- Bandcamp scraper hardening: failure tracking + review queue integrity
-- 2026-04-01
-- ============================================================

-- 1. Scrape failure tracking on bandcamp_product_mappings
--    Enables Group 1 sweep to skip permanently-blocked items (Cloudflare 403/429)
--    and provides visibility into which items are problematic.
ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS scrape_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scrape_attempt_at timestamptz;

-- Partial index for sweep query performance (only unscraped items)
CREATE INDEX IF NOT EXISTS idx_bandcamp_mappings_scrape_state
  ON bandcamp_product_mappings(workspace_id, scrape_failure_count, bandcamp_type_name)
  WHERE bandcamp_type_name IS NULL;

-- 2. Atomic failure count increment — avoids read-modify-write race condition
--    Called from bandcampScrapePageTask catch block on scrape failures.
CREATE OR REPLACE FUNCTION increment_bandcamp_scrape_failures(p_mapping_id uuid)
RETURNS void AS $$
  UPDATE bandcamp_product_mappings
  SET scrape_failure_count = scrape_failure_count + 1,
      updated_at = now()
  WHERE id = p_mapping_id;
$$ LANGUAGE SQL SECURITY DEFINER;

-- 3. UNIQUE constraint on warehouse_review_queue.group_key
--    Required for ON CONFLICT semantics to work correctly.
--    The code uses onConflict: "group_key" but without a unique constraint
--    Postgres cannot enforce it — upserts may silently insert duplicates.
--
--    Check for existing duplicates before applying:
--    SELECT group_key, COUNT(*) FROM warehouse_review_queue
--    WHERE group_key IS NOT NULL GROUP BY group_key HAVING COUNT(*) > 1;
--
--    NOT VALID: validates only new rows; existing rows (if any duplicates)
--    won't block this migration. Run VALIDATE separately if needed.
-- ADD CONSTRAINT doesn't support IF NOT EXISTS — use DO block instead
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_review_queue_group_key'
      AND conrelid = 'warehouse_review_queue'::regclass
  ) THEN
    ALTER TABLE warehouse_review_queue
      ADD CONSTRAINT uq_review_queue_group_key UNIQUE (group_key);
  END IF;
END $$;
