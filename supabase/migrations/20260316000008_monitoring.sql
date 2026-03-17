-- Migration 008: Review queue, billing snapshots, webhook dedup, sync log, sensors, RPCs
-- Rule #22: persist_billing_snapshot RPC — billing math in TS, row locking in Postgres
-- Rule #37/#62: webhook_events table with UNIQUE(platform, external_webhook_id) for dedup
-- Rule #64: record_inventory_change_txn RPC — single ACID transaction for inventory mutations

CREATE TABLE warehouse_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid REFERENCES organizations(id),
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title text NOT NULL,
  description text,
  metadata jsonb DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'suppressed')),
  assigned_to uuid REFERENCES users(id),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  sla_due_at timestamptz,
  suppressed_until timestamptz,
  group_key text,
  occurrence_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_queue_status ON warehouse_review_queue(status);
CREATE INDEX idx_review_queue_severity ON warehouse_review_queue(severity);
CREATE INDEX idx_review_queue_group_key ON warehouse_review_queue(group_key);

CREATE TABLE warehouse_billing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  billing_period text NOT NULL,
  snapshot_data jsonb NOT NULL,
  grand_total numeric NOT NULL,
  total_shipping numeric,
  total_pick_pack numeric,
  total_materials numeric,
  total_storage numeric,
  total_adjustments numeric,
  stripe_invoice_id text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, org_id, billing_period)
);

-- Add FK from billing_adjustments to snapshots now that the target table exists
ALTER TABLE warehouse_billing_adjustments
  ADD CONSTRAINT fk_billing_adj_snapshot
  FOREIGN KEY (snapshot_id) REFERENCES warehouse_billing_snapshots(id);

-- Rule #37/#62: Webhook dedup table — atomic INSERT ON CONFLICT for all platforms
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  platform text NOT NULL,
  external_webhook_id text NOT NULL,
  topic text,
  status text DEFAULT 'received',
  processed_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(platform, external_webhook_id)
);
CREATE INDEX idx_webhook_events_platform ON webhook_events(platform, created_at DESC);

CREATE TABLE channel_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel text NOT NULL,
  sync_type text,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'partial', 'failed')),
  items_processed integer DEFAULT 0,
  items_failed integer DEFAULT 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sensor_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sensor_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy', 'warning', 'critical')),
  value jsonb,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sensor_readings_name ON sensor_readings(sensor_name, created_at DESC);

-- Rule #22: persist_billing_snapshot RPC
-- Billing math stays in TypeScript; row locking stays in Postgres.
-- JS keys must EXACTLY match PL/pgSQL argument names (including p_ prefix).
CREATE OR REPLACE FUNCTION persist_billing_snapshot(
  p_workspace_id uuid,
  p_org_id uuid,
  p_billing_period text,
  p_snapshot_data jsonb,
  p_grand_total numeric,
  p_total_shipping numeric,
  p_total_pick_pack numeric,
  p_total_materials numeric,
  p_total_storage numeric,
  p_total_adjustments numeric
) RETURNS uuid AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO warehouse_billing_snapshots (
    id, workspace_id, org_id, billing_period, snapshot_data,
    grand_total, total_shipping, total_pick_pack, total_materials,
    total_storage, total_adjustments, status
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_org_id, p_billing_period, p_snapshot_data,
    p_grand_total, p_total_shipping, p_total_pick_pack, p_total_materials,
    p_total_storage, p_total_adjustments, 'draft'
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Rule #64: record_inventory_change_txn RPC
-- Wraps the inventory level update + activity log insert in a single ACID transaction.
-- Sequential PostgREST calls (.update then .insert) are NOT transactional — this RPC is.
CREATE OR REPLACE FUNCTION record_inventory_change_txn(
  p_workspace_id uuid,
  p_sku text,
  p_delta integer,
  p_source text,
  p_correlation_id text,
  p_metadata jsonb DEFAULT '{}'
) RETURNS jsonb AS $$
DECLARE
  v_previous integer;
  v_new integer;
BEGIN
  UPDATE warehouse_inventory_levels
  SET available = available + p_delta,
      updated_at = now(),
      last_redis_write_at = now()
  WHERE workspace_id = p_workspace_id AND sku = p_sku
  RETURNING available - p_delta, available INTO v_previous, v_new;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No inventory level found for workspace=% sku=%', p_workspace_id, p_sku;
  END IF;

  INSERT INTO warehouse_inventory_activity (
    id, workspace_id, sku, delta, source, correlation_id,
    previous_quantity, new_quantity, metadata
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_sku, p_delta, p_source, p_correlation_id,
    v_previous, v_new, p_metadata
  );

  RETURN jsonb_build_object('previous', v_previous, 'new', v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
