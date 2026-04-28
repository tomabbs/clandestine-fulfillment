-- WooCommerce connection repair hardening.
--
-- Adds explicit state for:
--   - Woo REST auth transport fallback (Basic Auth vs query params)
--   - Woo webhook secret rotation
--   - poll attempt/success/watermark observability
--   - shared poll/webhook warehouse order idempotency

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS preferred_auth_mode text,
  ADD COLUMN IF NOT EXISTS webhook_secret_previous text,
  ADD COLUMN IF NOT EXISTS webhook_secret_previous_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_poll_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_poll_succeeded_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_poll_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_poll_failures integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'client_store_connections_preferred_auth_mode_check'
      AND conrelid = 'client_store_connections'::regclass
  ) THEN
    ALTER TABLE client_store_connections
      ADD CONSTRAINT client_store_connections_preferred_auth_mode_check
      CHECK (preferred_auth_mode IS NULL OR preferred_auth_mode IN ('basic', 'query_param'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'client_store_connections_poll_failures_nonnegative_check'
      AND conrelid = 'client_store_connections'::regclass
  ) THEN
    ALTER TABLE client_store_connections
      ADD CONSTRAINT client_store_connections_poll_failures_nonnegative_check
      CHECK (consecutive_poll_failures >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_store_connections_poll_health
  ON client_store_connections(platform, connection_status, last_poll_succeeded_at);

ALTER TABLE warehouse_orders
  ADD COLUMN IF NOT EXISTS ingestion_idempotency_key text,
  ADD COLUMN IF NOT EXISTS external_order_modified_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_orders_ingestion_idempotency
  ON warehouse_orders(ingestion_idempotency_key)
  WHERE ingestion_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warehouse_orders_external_modified
  ON warehouse_orders(workspace_id, source, external_order_id, external_order_modified_at DESC)
  WHERE external_order_id IS NOT NULL;
