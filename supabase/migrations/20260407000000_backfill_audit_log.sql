-- Backfill Audit Log: chunk-level tracking for sales backfill reliability.
-- Every API call writes a row (success or failure). Multiple attempts per chunk
-- are expected (append-only). The "latest attempt" is determined by
-- ORDER BY attempt_number DESC.

CREATE TABLE IF NOT EXISTS bandcamp_sales_backfill_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL REFERENCES bandcamp_connections(id),
  chunk_start date NOT NULL,
  chunk_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('success','failed','skipped')),
  sales_returned integer NOT NULL DEFAULT 0,
  sales_inserted integer NOT NULL DEFAULT 0,
  http_status integer,
  error_message text,
  attempt_number integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bandcamp_sales_backfill_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read backfill log"
  ON bandcamp_sales_backfill_log FOR SELECT USING (true);

CREATE POLICY "Service role manages backfill log"
  ON bandcamp_sales_backfill_log FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_backfill_log_latest ON bandcamp_sales_backfill_log(
  connection_id, chunk_start, attempt_number DESC
);

CREATE INDEX idx_backfill_log_failed ON bandcamp_sales_backfill_log(connection_id)
  WHERE status = 'failed';

CREATE INDEX idx_backfill_log_month_grid ON bandcamp_sales_backfill_log(
  connection_id, chunk_start, status, attempt_number DESC
);

-- Update status CHECK on backfill_state to include 'partial'
DO $c$
BEGIN
  ALTER TABLE bandcamp_sales_backfill_state
    DROP CONSTRAINT IF EXISTS bandcamp_sales_backfill_state_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $c$;

ALTER TABLE bandcamp_sales_backfill_state
  ADD CONSTRAINT bandcamp_sales_backfill_state_status_check
  CHECK (status IN ('pending','running','partial','completed','failed'));

-- coverage_start_date: explicit start of each account's coverage window.
-- Defaults to NULL (script falls back to connection created_at).
ALTER TABLE bandcamp_sales_backfill_state
  ADD COLUMN IF NOT EXISTS coverage_start_date date;

-- Transition existing failed rows that have actual data to partial
UPDATE bandcamp_sales_backfill_state
SET status = 'partial'
WHERE status = 'failed'
  AND total_transactions > 0;
