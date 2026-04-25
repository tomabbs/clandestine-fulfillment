-- Slice 1 — Webhook security + provider event ledger.
--
-- Adds notification_provider_events: an APPEND-ONLY ledger of every raw
-- provider event we receive (Resend delivery / bounce / complained / etc.,
-- and any future provider). Existing notification_sends remains the
-- ROLLUP of "where is this notification today" per (shipment, trigger);
-- this table is the immutable history that the rollup is computed from.
--
-- Why a separate table:
--   - notification_sends is a MUTABLE rollup. We need to be able to update
--     status, attempt counts, next_retry_at, etc., on the same row. The
--     provider sometimes fires N events per send (sent → delivered →
--     bounced after a few minutes, or delivered → complained later); each
--     of those events needs its own immutable row for forensics.
--   - We must answer: "show me every event Resend ever sent us about
--     this notification, in order" for ops debugging. That requires an
--     append-only ledger.
--   - We must NOT lose events when the rollup transition is rejected by
--     the state machine (e.g. a late `delivered` event arriving after a
--     `bounced` event — the rollup stays bounced, but the ledger keeps
--     the delivered event for forensics).
--
-- Insertion contract:
--   - The Resend webhook MUST insert the provider_events row BEFORE
--     attempting any rollup status transition. This way an aborted
--     transition still leaves the ledger intact.
--   - Inserts are idempotent on (provider, provider_event_id). The
--     webhook route already dedups via webhook_events on svix-id, but
--     this UNIQUE provides defense-in-depth.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'resend' for outbound email events, 'easypost' for tracking webhook
  -- events. Both providers use the same append-only ledger so the per-
  -- shipment drilldown (Slice 4) can render a single time-ordered timeline
  -- across email and tracking events without UNIONing two tables. Future
  -- providers (postmark, sendgrid, twilio, aftership) reuse the same
  -- table by adding a literal to the CHECK constraint below.
  provider text NOT NULL,
  -- Provider-side event id (Resend: usually svix-id from the webhook
  -- envelope; EasyPost: payload.id, falling back to a stable derivation
  -- of result.id+status+updated_at). Used for idempotent inserts.
  provider_event_id text NOT NULL,
  -- Provider's event type, verbatim. Resend examples:
  --   email.sent, email.delivered, email.delivery_delayed,
  --   email.bounced, email.complained, email.opened, email.clicked,
  --   email.failed, email.suppressed
  -- EasyPost examples: tracker.updated, tracker.created.
  event_type text NOT NULL,
  -- Provider's message id (Resend: data.email_id). Joined to
  -- notification_sends.resend_message_id when present. NULL for EasyPost
  -- tracking events (no per-message identifier; use shipment_id instead).
  provider_message_id text,
  -- Workspace scope. Set at insert time when the route can derive it
  -- (e.g. from the resolved notification_send.workspace_id, or from the
  -- linked shipment.workspace_id for EasyPost events). Nullable for
  -- ledger-only events that arrive before any workspace mapping exists.
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  -- Linked notification_sends row, when one can be matched. Nullable so
  -- we can persist provider events that don't match any send (e.g. a
  -- replayed dev event for a deleted shipment, an event for a send that
  -- was created in a rolled-back transaction). Used by the Slice 4
  -- per-shipment drilldown to merge email events into the timeline.
  notification_send_id uuid REFERENCES notification_sends(id) ON DELETE SET NULL,
  -- Linked warehouse_shipments row. Set for EasyPost tracking events
  -- (always — derived from result.shipment_id) and for Resend events
  -- when the matched notification_send has a shipment_id. Used by the
  -- Slice 4 drilldown query so we don't have to JSON-traverse to find
  -- per-shipment events.
  shipment_id uuid REFERENCES warehouse_shipments(id) ON DELETE SET NULL,
  -- Recipient address from the provider payload, when present. Lower-cased
  -- so post-hoc lookups don't depend on case quirks. Stored verbatim for
  -- audit; never expose in non-staff API. NULL for EasyPost events.
  recipient text,
  -- Original timestamp from the provider event (created_at on the Resend
  -- webhook envelope; result.updated_at on EasyPost). NULL when absent.
  occurred_at timestamptz,
  -- Insertion time on our side.
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Raw event payload (top-level + data{}). Stored unmodified for
  -- forensics. NOT subject to the webhook_body sanitizer because this
  -- ledger is staff-only and the events themselves are short-lived
  -- per-message audit data — pruned by the existing webhook retention
  -- policy that the operator runs on a 90-day cadence.
  payload jsonb NOT NULL,
  CONSTRAINT notification_provider_events_provider_check
    CHECK (provider IN ('resend', 'easypost'))
);

-- Existing remote installs may have the older single-provider CHECK; replace
-- it idempotently so subsequent supabase db push runs don't fail with
-- "constraint already exists".
ALTER TABLE notification_provider_events
  DROP CONSTRAINT IF EXISTS notification_provider_events_provider_check;

ALTER TABLE notification_provider_events
  ADD CONSTRAINT notification_provider_events_provider_check
    CHECK (provider IN ('resend', 'easypost'));

-- Forward-compatible column additions for environments that already applied
-- the older shape of this migration before workspace_id / shipment_id were
-- folded in.
ALTER TABLE notification_provider_events
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;

ALTER TABLE notification_provider_events
  ADD COLUMN IF NOT EXISTS shipment_id uuid REFERENCES warehouse_shipments(id) ON DELETE SET NULL;

-- Idempotent inserts: same (provider, event_id) collapses.
CREATE UNIQUE INDEX IF NOT EXISTS notification_provider_events_provider_event_uq
  ON notification_provider_events (provider, provider_event_id);

-- Lookups by message id (the Resend webhook resolves to notification_sends
-- through this column).
CREATE INDEX IF NOT EXISTS notification_provider_events_provider_message_id_idx
  ON notification_provider_events (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Per-send drilldown: every event for a given notification_sends row, in
-- order. Used by the upcoming Slice 4 audit drilldown.
CREATE INDEX IF NOT EXISTS notification_provider_events_send_received_idx
  ON notification_provider_events (notification_send_id, received_at DESC)
  WHERE notification_send_id IS NOT NULL;

-- Per-shipment drilldown: every email + tracking event for a given
-- shipment, in order. Powers the Slice 4 ShipmentNotificationLog component
-- mounted in the orders cockpit drawer.
CREATE INDEX IF NOT EXISTS notification_provider_events_shipment_received_idx
  ON notification_provider_events (shipment_id, received_at DESC)
  WHERE shipment_id IS NOT NULL;

-- Per-workspace ops scan (event_type breakdown, signature failure
-- correlation, etc.).
CREATE INDEX IF NOT EXISTS notification_provider_events_workspace_received_idx
  ON notification_provider_events (workspace_id, received_at DESC)
  WHERE workspace_id IS NOT NULL;

-- Recent-events scan for ops dashboards.
CREATE INDEX IF NOT EXISTS notification_provider_events_received_idx
  ON notification_provider_events (received_at DESC);

ALTER TABLE notification_provider_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON notification_provider_events;
CREATE POLICY staff_all ON notification_provider_events
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

COMMENT ON TABLE notification_provider_events IS
  'Slice 1 — append-only ledger of every raw provider event (Resend etc.). notification_sends rollup is computed from this history; this table NEVER has rows mutated.';

COMMIT;
