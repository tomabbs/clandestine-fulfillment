-- Allow DELETE on client_store_connections: order identity v2 FKs defaulted to
-- NO ACTION and blocked removal when warehouse_orders.connection_id pointed at
-- the row. Cascade children already use ON DELETE CASCADE; these nullable refs
-- should null out instead.

DO $$
DECLARE
  conname_ident text;
BEGIN
  SELECT c.conname INTO conname_ident
  FROM pg_constraint c
  INNER JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.confrelid = 'client_store_connections'::regclass
    AND c.conrelid = 'warehouse_orders'::regclass
    AND c.contype = 'f'
    AND array_length(c.conkey, 1) = 1
    AND a.attname = 'connection_id';

  IF conname_ident IS NOT NULL THEN
    EXECUTE format('ALTER TABLE warehouse_orders DROP CONSTRAINT %I', conname_ident);
  END IF;
END
$$;

ALTER TABLE warehouse_orders
  ADD CONSTRAINT warehouse_orders_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES client_store_connections(id)
    ON DELETE SET NULL;

DO $$
DECLARE
  conname_ident text;
BEGIN
  SELECT c.conname INTO conname_ident
  FROM pg_constraint c
  INNER JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.confrelid = 'client_store_connections'::regclass
    AND c.conrelid = 'warehouse_order_identity_backfill_runs'::regclass
    AND c.contype = 'f'
    AND array_length(c.conkey, 1) = 1
    AND a.attname = 'connection_id';

  IF conname_ident IS NOT NULL THEN
    EXECUTE format('ALTER TABLE warehouse_order_identity_backfill_runs DROP CONSTRAINT %I', conname_ident);
  END IF;
END
$$;

ALTER TABLE warehouse_order_identity_backfill_runs
  ADD CONSTRAINT warehouse_order_identity_backfill_runs_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES client_store_connections(id)
    ON DELETE SET NULL;

DO $$
DECLARE
  conname_ident text;
BEGIN
  SELECT c.conname INTO conname_ident
  FROM pg_constraint c
  INNER JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.confrelid = 'client_store_connections'::regclass
    AND c.conrelid = 'warehouse_order_identity_review_queue'::regclass
    AND c.contype = 'f'
    AND array_length(c.conkey, 1) = 1
    AND a.attname = 'resolved_connection_id';

  IF conname_ident IS NOT NULL THEN
    EXECUTE format('ALTER TABLE warehouse_order_identity_review_queue DROP CONSTRAINT %I', conname_ident);
  END IF;
END
$$;

ALTER TABLE warehouse_order_identity_review_queue
  ADD CONSTRAINT warehouse_order_identity_review_queue_resolved_connection_id_fkey
    FOREIGN KEY (resolved_connection_id)
    REFERENCES client_store_connections(id)
    ON DELETE SET NULL;

DO $$
DECLARE
  conname_ident text;
BEGIN
  SELECT c.conname INTO conname_ident
  FROM pg_constraint c
  INNER JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.confrelid = 'client_store_connections'::regclass
    AND c.conrelid = 'platform_order_ingest_ownership'::regclass
    AND c.contype = 'f'
    AND array_length(c.conkey, 1) = 1
    AND a.attname = 'connection_id';

  IF conname_ident IS NOT NULL THEN
    EXECUTE format('ALTER TABLE platform_order_ingest_ownership DROP CONSTRAINT %I', conname_ident);
  END IF;
END
$$;

ALTER TABLE platform_order_ingest_ownership
  ADD CONSTRAINT platform_order_ingest_ownership_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES client_store_connections(id)
    ON DELETE SET NULL;
