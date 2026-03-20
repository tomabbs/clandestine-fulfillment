-- Webhook health snapshot for operational validation
-- Run in Supabase SQL Editor.

-- ---------------------------------------------------------------------------
-- A) Recent webhook events by platform and status (last 7 days)
-- ---------------------------------------------------------------------------
SELECT
  platform,
  status,
  COUNT(*) AS event_count
FROM webhook_events
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY platform, status
ORDER BY platform, status;

-- ---------------------------------------------------------------------------
-- B) Most recent webhook event timestamp by platform
-- ---------------------------------------------------------------------------
SELECT
  platform,
  MAX(created_at) AS last_event_at
FROM webhook_events
GROUP BY platform
ORDER BY platform;

-- ---------------------------------------------------------------------------
-- C) Client store webhook/poll recency
-- ---------------------------------------------------------------------------
SELECT
  id,
  platform,
  store_url,
  connection_status,
  last_webhook_at,
  last_poll_at,
  last_error,
  last_error_at
FROM client_store_connections
ORDER BY updated_at DESC;

-- ---------------------------------------------------------------------------
-- D) Potentially stale webhook integrations (no events in 7 days)
-- ---------------------------------------------------------------------------
WITH expected(platform) AS (
  VALUES
    ('shopify'),
    ('shipstation'),
    ('aftership'),
    ('stripe'),
    ('resend')
),
recent AS (
  SELECT platform, COUNT(*) AS c
  FROM webhook_events
  WHERE created_at >= NOW() - INTERVAL '7 days'
  GROUP BY platform
)
SELECT
  e.platform,
  COALESCE(r.c, 0) AS events_last_7_days,
  CASE WHEN COALESCE(r.c, 0) = 0 THEN 'STALE_OR_UNREGISTERED' ELSE 'OK' END AS health_flag
FROM expected e
LEFT JOIN recent r ON r.platform = e.platform
ORDER BY e.platform;
