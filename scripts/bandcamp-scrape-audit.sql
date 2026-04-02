-- Bandcamp scraper audit — Supabase SQL Editor
-- Replace the workspace UUID in the CTE below (one place).

WITH p AS (
  SELECT '00000000-0000-0000-0000-000000000000'::uuid AS workspace_id
)
SELECT 'group1_url_no_type_under_5_failures' AS metric,
  (SELECT count(*)::bigint
   FROM bandcamp_product_mappings m, p
   WHERE m.workspace_id = p.workspace_id
     AND m.bandcamp_url IS NOT NULL
     AND m.bandcamp_type_name IS NULL
     AND (m.scrape_failure_count IS NULL OR m.scrape_failure_count < 5)) AS value
UNION ALL
SELECT 'group1_url_no_type_failures_gte_5_excluded_from_sweep',
  (SELECT count(*)::bigint
   FROM bandcamp_product_mappings m, p
   WHERE m.workspace_id = p.workspace_id
     AND m.bandcamp_url IS NOT NULL
     AND m.bandcamp_type_name IS NULL
     AND m.scrape_failure_count >= 5)
UNION ALL
SELECT 'group2_no_url_no_type',
  (SELECT count(*)::bigint
   FROM bandcamp_product_mappings m, p
   WHERE m.workspace_id = p.workspace_id
     AND m.bandcamp_url IS NULL
     AND m.bandcamp_type_name IS NULL)
UNION ALL
SELECT 'group3_art_no_about',
  (SELECT count(*)::bigint
   FROM bandcamp_product_mappings m, p
   WHERE m.workspace_id = p.workspace_id
     AND m.bandcamp_art_url IS NOT NULL
     AND m.bandcamp_about IS NULL
     AND m.bandcamp_url IS NOT NULL)
UNION ALL
SELECT 'review_queue_bandcamp_scraper_open',
  (SELECT count(*)::bigint
   FROM warehouse_review_queue q, p
   WHERE q.workspace_id = p.workspace_id
     AND q.category = 'bandcamp_scraper'
     AND q.status = 'open');

-- Optional: compare to last sweep logs
-- SELECT sync_type, items_processed, metadata, created_at
-- FROM channel_sync_log
-- WHERE channel = 'bandcamp' AND sync_type IN ('scrape_diag', 'scrape_sweep')
-- ORDER BY created_at DESC LIMIT 15;
