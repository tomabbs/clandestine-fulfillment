-- Phase 9 — Bulk + workflow operations
--
-- 9.3 Assign-To staff: track who in OUR system owns an order (NOT synced to SS).
-- 9.1 Print batch jobs: backing store for /admin/orders/print-batch/[id] —
--     avoids URL-length issues with 200+ shipment_ids.

BEGIN;

-- ── 9.3 assigned_user_id on shipstation_orders ─────────────────────────────
ALTER TABLE shipstation_orders
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- Sidebar "Assigned to me" bucket queries by (workspace_id, assigned_user_id).
CREATE INDEX IF NOT EXISTS shipstation_orders_assigned_user_idx
  ON shipstation_orders (workspace_id, assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

-- ── 9.1 print_batch_jobs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_batch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Materialized list of warehouse_shipments.id in the batch (set after labels
  -- are bought). On the print page we hydrate from these IDs.
  shipment_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  -- Aggregate progress + outcomes for the modal UI; per-row entries refer to
  -- the originating shipstation_orders.id so the modal can show success/fail
  -- per row even when no warehouse_shipments row was created (purchase failed).
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed')),
  -- Cleanup horizon — daily cron purges past expiry. 24h gives operators
  -- enough headroom to reprint after a paper jam without bloating the table.
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_batch_jobs_workspace_idx
  ON print_batch_jobs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS print_batch_jobs_expiry_idx
  ON print_batch_jobs (expires_at)
  WHERE status != 'pending';

-- RLS: staff full CRUD within their workspace; service_role bypass (for the
-- cleanup cron + the bulk task that mutates progress). No client portal access.
ALTER TABLE print_batch_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all ON print_batch_jobs;
CREATE POLICY staff_all ON print_batch_jobs
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

COMMIT;
