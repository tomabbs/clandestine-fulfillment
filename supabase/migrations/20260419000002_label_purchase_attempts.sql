-- Phase 0.3 — Idempotency layer for EasyPost label purchase.
--
-- Wraps Shipment.buy in a stable-key lock so retries (Trigger.dev's automatic
-- 3-attempt policy, manual re-enqueues, or any other re-entry) cannot charge
-- EasyPost twice. Key construction is documented in
-- src/lib/server/label-purchase-idempotency.ts and is computed BEFORE buy is
-- called, so the row exists even if the first attempt charged EP and crashed
-- before our DB commit.
--
-- See plan: Appendix J.3 / J.5 and Phase 0.3.

CREATE TABLE IF NOT EXISTS label_purchase_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  order_external_id text NOT NULL,                 -- warehouse_orders.id, mailorder_orders.id, or shipstation_orders.shipstation_order_id
  order_source text NOT NULL,                      -- 'fulfillment' | 'mailorder' | 'shipstation'
  shipment_id text,                                -- EP shipment id, populated after Shipment.create
  warehouse_shipment_id uuid,                      -- our row id, populated after DB commit
  idempotency_key text NOT NULL,
  rate_signature text NOT NULL,                    -- hash of the chosen rate's stable fields
  attempt_started_at timestamptz NOT NULL DEFAULT now(),
  attempt_finished_at timestamptz,
  succeeded boolean NOT NULL DEFAULT false,
  response_json jsonb,                             -- full EP buy response on success (for replay/audit)
  tracking_number text,                            -- denormalized from response for quick lookup
  error_text text,                                 -- reason on failure
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The idempotency contract: same workspace + same key = same outcome.
CREATE UNIQUE INDEX IF NOT EXISTS uq_label_purchase_attempts_workspace_key
  ON label_purchase_attempts (workspace_id, idempotency_key);

-- Fast lookup by order during retry / drawer status polling.
CREATE INDEX IF NOT EXISTS idx_label_purchase_attempts_workspace_order
  ON label_purchase_attempts (workspace_id, order_source, order_external_id);

-- Fast filter for the "did this label already buy?" check.
CREATE INDEX IF NOT EXISTS idx_label_purchase_attempts_succeeded
  ON label_purchase_attempts (workspace_id, succeeded, attempt_finished_at DESC);

COMMENT ON TABLE label_purchase_attempts IS
  'Phase 0.3 — local outbox for EasyPost label purchases. The (workspace_id, idempotency_key) UNIQUE is the real protection against double-charge. Trigger.dev retries are no-ops once succeeded=true.';

COMMENT ON COLUMN label_purchase_attempts.idempotency_key IS
  'easypost-buy:{workspace_id}:{order_external_id}:{rate_signature}. Computed from STABLE INPUTS only (never from EP response outputs).';

COMMENT ON COLUMN label_purchase_attempts.rate_signature IS
  'hash({carrier, service, rate, currency, carrier_account_id}) — same staff selection produces the same hash even if EP rate IDs change.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Service-role only. Staff never touch this table directly; the idempotency
-- helper runs server-side under the service role.
ALTER TABLE label_purchase_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_only ON label_purchase_attempts;
CREATE POLICY service_role_only ON label_purchase_attempts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
