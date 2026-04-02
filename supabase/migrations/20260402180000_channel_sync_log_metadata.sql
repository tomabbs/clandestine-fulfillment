-- Optional JSON diagnostics for operational visibility (e.g. Bandcamp scrape sweep breakdown).
ALTER TABLE channel_sync_log ADD COLUMN IF NOT EXISTS metadata jsonb;
