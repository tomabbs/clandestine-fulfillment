-- Phase 12 — Unified branded customer surface (Resend-for-all).
--
-- Adds:
--   1. warehouse_shipments.public_track_token       — opaque random URL-safe
--      token for the public /track/[token] page. UNIQUE.
--   2. warehouse_shipments.public_track_token_generated_at — audit timestamp.
--   3. warehouse_shipments.suppress_emails          — per-shipment kill switch
--      consulted by send-tracking-email.
--   4. notification_sends                           — audit table + dedup
--      contract for the unified send pipeline.
--   5. resend_suppressions                          — recipient-level
--      hard-suppression list (populated by Resend bounce + complaint
--      webhooks). send-tracking-email checks before every send.
--
-- Dedup contract on notification_sends:
--   UNIQUE (shipment_id, trigger_status, status='sent') — partial index.
--   Belt-and-suspenders with the application-layer dedup check in
--   send-tracking-email. The DB UNIQUE constraint guarantees that even if
--   two task runs race, only one notification_sends row with status='sent'
--   can exist per (shipment, trigger).

BEGIN;

-- ── 1+2+3: warehouse_shipments columns ────────────────────────────────────
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS public_track_token text,
  ADD COLUMN IF NOT EXISTS public_track_token_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS suppress_emails boolean NOT NULL DEFAULT false;

-- The token is server-generated random; UNIQUE makes the lookup index +
-- guarantees no collision. NULL allowed during backfill window; the
-- backfill script in scripts/backfill-tracking-tokens.ts fills them in.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_shipments_public_track_token_uq
  ON warehouse_shipments (public_track_token)
  WHERE public_track_token IS NOT NULL;

-- ── 4: notification_sends audit table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL REFERENCES warehouse_shipments(id) ON DELETE CASCADE,
  -- Status that triggered this send. App enum:
  --   'shipped' | 'out_for_delivery' | 'delivered' | 'exception'
  trigger_status text NOT NULL,
  -- 'email' today; future SMS goes here.
  channel text NOT NULL DEFAULT 'email',
  template_id text NOT NULL,
  -- Recipient email (or phone for SMS). Stored verbatim for audit; DO NOT
  -- expose in any non-staff API.
  recipient text NOT NULL,
  -- 'shadow' = strategy was 'shadow', send went to ops allowlist not customer.
  -- 'sent' = real send to real customer succeeded.
  -- 'failed' = Resend returned an error. error column has detail.
  -- 'bounced' = Resend later confirmed bounce via webhook.
  -- 'complained' = recipient hit "spam" button via webhook.
  -- 'suppressed' = blocked at send time because recipient is on resend_suppressions.
  -- 'skipped'  = strategy gate said off; recorded for audit completeness.
  status text NOT NULL,
  resend_message_id text,
  error text,
  -- For 'shadow' rows we record what the REAL recipient WOULD have been so
  -- the shadow-vs-real reconciliation can compare 1:1.
  shadow_intended_recipient text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_sends_status_check CHECK (status IN
    ('sent','failed','bounced','complained','suppressed','skipped','shadow')),
  CONSTRAINT notification_sends_trigger_check CHECK (trigger_status IN
    ('shipped','out_for_delivery','delivered','exception'))
);

-- Hard dedup contract: at most ONE 'sent' row per (shipment, trigger).
-- Race-safe; if two task runs both try to insert the second one fails.
-- Application code catches the unique violation and treats it as success.
CREATE UNIQUE INDEX IF NOT EXISTS notification_sends_dedup_sent
  ON notification_sends (shipment_id, trigger_status)
  WHERE status = 'sent';

-- Same for shadow rows so shadow mode is also exactly-once (avoids spamming
-- the ops inbox on retries).
CREATE UNIQUE INDEX IF NOT EXISTS notification_sends_dedup_shadow
  ON notification_sends (shipment_id, trigger_status)
  WHERE status = 'shadow';

CREATE INDEX IF NOT EXISTS notification_sends_workspace_recent
  ON notification_sends (workspace_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS notification_sends_resend_msg
  ON notification_sends (resend_message_id)
  WHERE resend_message_id IS NOT NULL;

ALTER TABLE notification_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON notification_sends;
CREATE POLICY staff_all ON notification_sends
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

-- ── 5: resend_suppressions ────────────────────────────────────────────────
-- Recipient-level hard suppression. send-tracking-email refuses to send to
-- any recipient on this list. Populated by /api/webhooks/resend on bounce
-- (suppression_type='bounce') and complaint (suppression_type='complaint').
-- Manual entries allowed via admin (suppression_type='manual') for direct
-- ops opt-out requests.
CREATE TABLE IF NOT EXISTS resend_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  suppression_type text NOT NULL,
  reason text,
  source_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resend_suppressions_type_check CHECK (suppression_type IN
    ('bounce','complaint','manual'))
);

-- Lookup is by (workspace, recipient) at send time. Workspace can be NULL
-- for global suppressions (e.g. a known abuse address); the send-time
-- lookup checks BOTH the workspace-scoped row AND the global rows.
CREATE INDEX IF NOT EXISTS resend_suppressions_lookup
  ON resend_suppressions (recipient, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS resend_suppressions_unique
  ON resend_suppressions (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), recipient, suppression_type);

ALTER TABLE resend_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON resend_suppressions;
CREATE POLICY staff_all ON resend_suppressions
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

COMMIT;
