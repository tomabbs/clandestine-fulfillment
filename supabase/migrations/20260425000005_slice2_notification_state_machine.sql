-- Slice 2 — notification idempotency + status state machine.
--
-- Changes (all idempotent — re-running this migration on a half-applied
-- environment is safe):
--
--   1. Widen notification_sends.status CHECK enum to add lifecycle states:
--        pending, delivered, delivery_delayed, provider_failed,
--        provider_suppressed, cancelled
--      Existing values (sent, failed, bounced, complained, suppressed,
--      skipped, shadow) are kept; `failed` is retained as a legacy alias
--      for `provider_failed` rows that pre-exist this migration.
--   2. Add lifecycle timestamps + retry bookkeeping columns.
--   3. Drop the existing dedup partial unique indexes
--      (notification_sends_dedup_sent + _shadow) and replace with a single
--      WIDER partial unique index covering every "active" status — so a
--      pending row blocks duplicate sends just like a sent row does.
--   4. Add UNIQUE(idempotency_key) for caller-supplied idempotency.
--   5. ALTER notification_sends.sent_at to drop NOT NULL/DEFAULT — the new
--      lifecycle treats sent_at as the moment the provider acknowledged
--      the send, not the row insertion time. Insertion time is `pending_at`
--      (defaulting to now()).
--   6. Create notification_operator_events for ops actions audit.
--   7. PL/pgSQL state-machine RPCs:
--        update_notification_status_safe        — guards rollup transitions
--        update_shipment_tracking_status_safe   — guards tracker transitions
--        apply_operator_notification_action     — atomic operator action +
--                                                 audit row
--
-- See the "drift reconciliation v5" notes in the plan for why both old
-- partial unique indexes are dropped (not one), and why sent_at must lose
-- its NOT NULL.

BEGIN;

-- ── 1. Widened status CHECK constraint ──────────────────────────────────
-- Drop the existing constraint by name (matches the original migration).
ALTER TABLE notification_sends
  DROP CONSTRAINT IF EXISTS notification_sends_status_check;

ALTER TABLE notification_sends
  ADD CONSTRAINT notification_sends_status_check CHECK (status IN (
    'pending',
    'sent',
    'delivered',
    'delivery_delayed',
    'bounced',
    'complained',
    'suppressed',
    'provider_suppressed',
    'provider_failed',
    'failed',
    'skipped',
    'shadow',
    'cancelled'
  ));

-- ── 2. Lifecycle timestamps + retry bookkeeping ─────────────────────────
ALTER TABLE notification_sends
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS pending_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_delayed_at timestamptz,
  ADD COLUMN IF NOT EXISTS bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS complained_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

-- sent_at is retained as the "provider acknowledged the send" timestamp.
-- Drop NOT NULL + DEFAULT so a pending row can exist without a send time.
ALTER TABLE notification_sends ALTER COLUMN sent_at DROP NOT NULL;
ALTER TABLE notification_sends ALTER COLUMN sent_at DROP DEFAULT;

-- ── 3. Pre-flight duplicate-row detector + replace the dedup indexes ────
-- IMPORTANT: drop BOTH the old indexes — _sent and _shadow — before
-- creating the wider one. Leaving the old ones in place would make sending
-- a 'pending' followed by a real 'sent' constraint-collide on the legacy
-- index but not on the wider one, producing inconsistent behavior.
--
-- Pre-flight: BEFORE we drop the existing indexes (which would otherwise
-- silently allow conflicting rows to live unprotected for the brief window
-- between DROP and CREATE UNIQUE), assert that no (shipment_id,
-- trigger_status) pair already has more than one row in the WIDER active
-- status set. If it does, raise an exception that aborts the entire
-- migration — the operator is expected to clean up the duplicates by
-- cancelling all but the most recent row, then re-run `supabase db push`.
--
-- The check is wrapped in a DO block so an exception aborts the migration
-- transaction (vs a SELECT that would just emit a row); that is the
-- "fail loudly" contract called out in the plan's preflight-and-dup-detector
-- todo.
DO $$
DECLARE
  v_dup_count integer;
  v_sample text;
BEGIN
  SELECT count(*), string_agg(format('(%s, %s, n=%s)', shipment_id, trigger_status, n), ', ')
    INTO v_dup_count, v_sample
  FROM (
    SELECT shipment_id, trigger_status, count(*) AS n
    FROM notification_sends
    WHERE status IN (
      'pending',
      'sent',
      'delivered',
      'delivery_delayed',
      'bounced',
      'complained',
      'provider_suppressed',
      'shadow'
    )
    GROUP BY shipment_id, trigger_status
    HAVING count(*) > 1
    LIMIT 25
  ) AS dups;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Slice 2 preflight failed: % duplicate (shipment_id, trigger_status) groups exist in the widened active-status set. Sample: %. Resolve by cancelling all but the most recent row per group (UPDATE notification_sends SET status=''cancelled'', cancelled_at=now() WHERE id IN (...)) and re-run the migration.',
      v_dup_count, v_sample
    USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

DROP INDEX IF EXISTS notification_sends_dedup_sent;
DROP INDEX IF EXISTS notification_sends_dedup_shadow;

-- Wider dedup: at most ONE row per (shipment, trigger) for any "active"
-- status. The cancelled / provider_failed statuses are explicitly OUT of
-- the active set so the operator can retry by cancelling the prior row
-- and creating a new one.
CREATE UNIQUE INDEX IF NOT EXISTS notification_sends_dedup_active
  ON notification_sends (shipment_id, trigger_status)
  WHERE status IN (
    'pending',
    'sent',
    'delivered',
    'delivery_delayed',
    'bounced',
    'complained',
    'provider_suppressed',
    'shadow'
  );

-- ── 4. Idempotency-key uniqueness ───────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS notification_sends_idempotency_key_unique
  ON notification_sends (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── 5. notification_operator_events audit table ─────────────────────────
CREATE TABLE IF NOT EXISTS notification_operator_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_send_id uuid NOT NULL REFERENCES notification_sends(id) ON DELETE CASCADE,
  -- Staff user who performed the action. Nullable so a system-driven
  -- action (sensor-initiated cancel, automated retry) can be recorded
  -- without an owning user.
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- 'retry' | 'cancel' | 'force_resend' | 'mark_delivered_manual' (future)
  action text NOT NULL,
  -- Free-text reason captured from the operator (UI prompt) for audit.
  reason text,
  -- Status transition this action drove (snapshot for forensics).
  previous_status text,
  new_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_operator_events_action_check CHECK (action IN (
    'retry',
    'cancel',
    'force_resend',
    'mark_delivered_manual'
  ))
);

CREATE INDEX IF NOT EXISTS notification_operator_events_send_idx
  ON notification_operator_events (notification_send_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notification_operator_events_actor_idx
  ON notification_operator_events (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

ALTER TABLE notification_operator_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_all ON notification_operator_events;
CREATE POLICY staff_all ON notification_operator_events
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

COMMENT ON TABLE notification_operator_events IS
  'Slice 2 — audit log of operator actions on notification_sends. Every Retry/Cancel/Force-Resend in admin UI writes one row.';

-- ── 6. update_notification_status_safe RPC ──────────────────────────────
-- Sticky terminal-state state machine. Allowed transitions are explicitly
-- enumerated so an out-of-order delivered-after-bounced event can NEVER
-- regress the rollup back to a "good" state.
--
-- Returns ONE row (`applied boolean, previous_status text, new_status text,
-- skipped_reason text`) so callers can react without re-fetching.
CREATE OR REPLACE FUNCTION update_notification_status_safe(
  p_notification_send_id uuid,
  p_new_status text,
  p_error text DEFAULT NULL,
  p_resend_message_id text DEFAULT NULL,
  p_provider_event_type text DEFAULT NULL
)
RETURNS TABLE(
  applied boolean,
  previous_status text,
  new_status text,
  skipped_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row notification_sends%ROWTYPE;
  v_now timestamptz := now();
  v_allowed boolean;
BEGIN
  SELECT * INTO v_row FROM notification_sends WHERE id = p_notification_send_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, p_new_status, 'send_not_found';
    RETURN;
  END IF;

  -- Sticky terminal — never regress out of these.
  IF v_row.status IN ('bounced', 'complained', 'cancelled') THEN
    IF v_row.status = p_new_status THEN
      RETURN QUERY SELECT false, v_row.status, p_new_status, 'no_op_same_status';
    ELSE
      RETURN QUERY SELECT false, v_row.status, p_new_status, 'sticky_terminal';
    END IF;
    RETURN;
  END IF;

  -- Explicit allow-list of (from, to) transitions.
  v_allowed := CASE
    -- pending can move forward to anything except itself
    WHEN v_row.status = 'pending' AND p_new_status IN (
      'sent', 'delivered', 'delivery_delayed',
      'bounced', 'complained', 'provider_failed', 'provider_suppressed',
      'failed', 'cancelled', 'shadow'
    ) THEN true
    -- sent advances to delivered/delayed/bounced/complained/failed
    WHEN v_row.status = 'sent' AND p_new_status IN (
      'delivered', 'delivery_delayed', 'bounced', 'complained',
      'provider_failed', 'failed', 'cancelled'
    ) THEN true
    -- delivered is generally terminal but allow late bounce/complaint
    WHEN v_row.status = 'delivered' AND p_new_status IN (
      'bounced', 'complained'
    ) THEN true
    -- delivery_delayed can resolve to delivered or progress to terminal
    WHEN v_row.status = 'delivery_delayed' AND p_new_status IN (
      'delivered', 'bounced', 'complained', 'provider_failed', 'failed', 'cancelled'
    ) THEN true
    -- shadow is its own terminal (mirror of sent for shadow mode)
    WHEN v_row.status = 'shadow' AND p_new_status IN (
      'delivered', 'bounced', 'complained', 'provider_failed', 'failed', 'cancelled'
    ) THEN true
    -- Operator-initiated cancel from any non-terminal state
    WHEN p_new_status = 'cancelled' AND v_row.status IN (
      'pending', 'sent', 'delivery_delayed', 'shadow', 'failed', 'provider_failed', 'suppressed', 'skipped'
    ) THEN true
    -- failed/provider_failed/suppressed/skipped → cancelled or resurrect
    WHEN v_row.status IN ('failed', 'provider_failed') AND p_new_status IN (
      'pending', 'sent', 'cancelled'
    ) THEN true
    -- suppressed → provider_suppressed audit upgrade or cancel
    WHEN v_row.status = 'suppressed' AND p_new_status IN (
      'provider_suppressed', 'cancelled'
    ) THEN true
    -- provider_suppressed terminal except cancel
    WHEN v_row.status = 'provider_suppressed' AND p_new_status = 'cancelled' THEN true
    -- skipped → cancel only
    WHEN v_row.status = 'skipped' AND p_new_status = 'cancelled' THEN true
    -- self-transition is always a no-op (idempotent)
    WHEN v_row.status = p_new_status THEN false
    ELSE false
  END;

  IF v_row.status = p_new_status THEN
    -- Self-transition: refresh attempt bookkeeping (e.g. webhook arrived
    -- twice for delivered) but otherwise no-op.
    RETURN QUERY SELECT false, v_row.status, p_new_status, 'no_op_same_status';
    RETURN;
  END IF;

  IF NOT v_allowed THEN
    RETURN QUERY SELECT false, v_row.status, p_new_status, 'transition_not_allowed';
    RETURN;
  END IF;

  UPDATE notification_sends
  SET status = p_new_status,
      error = COALESCE(p_error, error),
      resend_message_id = COALESCE(p_resend_message_id, resend_message_id),
      sent_at = CASE WHEN p_new_status = 'sent' AND sent_at IS NULL THEN v_now ELSE sent_at END,
      delivered_at = CASE WHEN p_new_status = 'delivered' AND delivered_at IS NULL THEN v_now ELSE delivered_at END,
      delivery_delayed_at = CASE WHEN p_new_status = 'delivery_delayed' AND delivery_delayed_at IS NULL THEN v_now ELSE delivery_delayed_at END,
      bounced_at = CASE WHEN p_new_status = 'bounced' AND bounced_at IS NULL THEN v_now ELSE bounced_at END,
      complained_at = CASE WHEN p_new_status = 'complained' AND complained_at IS NULL THEN v_now ELSE complained_at END,
      provider_failed_at = CASE WHEN p_new_status = 'provider_failed' AND provider_failed_at IS NULL THEN v_now ELSE provider_failed_at END,
      provider_suppressed_at = CASE WHEN p_new_status = 'provider_suppressed' AND provider_suppressed_at IS NULL THEN v_now ELSE provider_suppressed_at END,
      cancelled_at = CASE WHEN p_new_status = 'cancelled' AND cancelled_at IS NULL THEN v_now ELSE cancelled_at END
  WHERE id = p_notification_send_id;

  RETURN QUERY SELECT true, v_row.status, p_new_status, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION update_notification_status_safe(uuid, text, text, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION update_notification_status_safe IS
  'Slice 2 — sticky terminal-state machine for notification_sends.status. Use the wrapper at src/lib/server/notification-status.ts; never call directly from app code.';

-- ── 7. update_shipment_tracking_status_safe RPC ─────────────────────────
-- Same idea applied to warehouse_shipments.easypost_tracker_status (Slice 3
-- column — see migration 20260425000006). Created here so all status state
-- machines live in one place.
--
-- Sticky terminal states: delivered, return_to_sender, cancelled, failure,
-- error.
CREATE OR REPLACE FUNCTION update_shipment_tracking_status_safe(
  p_shipment_id uuid,
  p_new_status text,
  p_status_detail text DEFAULT NULL,
  p_status_at timestamptz DEFAULT NULL
)
RETURNS TABLE(
  applied boolean,
  previous_status text,
  new_status text,
  skipped_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_status text;
  v_existing_status_at timestamptz;
  v_now timestamptz := now();
  v_status_at timestamptz;
  v_allowed boolean;
BEGIN
  SELECT easypost_tracker_status, last_tracking_status_updated_at
    INTO v_existing_status, v_existing_status_at
  FROM warehouse_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, p_new_status, 'shipment_not_found';
    RETURN;
  END IF;

  v_status_at := COALESCE(p_status_at, v_now);

  IF v_existing_status IS NULL THEN
    UPDATE warehouse_shipments
       SET easypost_tracker_status = p_new_status,
           last_tracking_status_detail = p_status_detail,
           last_tracking_status_updated_at = v_status_at
     WHERE id = p_shipment_id;
    RETURN QUERY SELECT true, NULL::text, p_new_status, NULL::text;
    RETURN;
  END IF;

  -- Sticky terminals.
  IF v_existing_status IN ('delivered', 'return_to_sender', 'cancelled', 'failure', 'error') THEN
    IF v_existing_status = p_new_status THEN
      RETURN QUERY SELECT false, v_existing_status, p_new_status, 'no_op_same_status';
    ELSE
      RETURN QUERY SELECT false, v_existing_status, p_new_status, 'sticky_terminal';
    END IF;
    RETURN;
  END IF;

  -- Out-of-order events: a newer event can't be overwritten by an older one.
  IF v_existing_status_at IS NOT NULL AND v_status_at < v_existing_status_at THEN
    RETURN QUERY SELECT false, v_existing_status, p_new_status, 'older_event_ignored';
    RETURN;
  END IF;

  -- Explicit precedence; lower number = earlier in lifecycle. Forward-only.
  v_allowed := tracking_status_rank(p_new_status) >= tracking_status_rank(v_existing_status);

  IF v_existing_status = p_new_status THEN
    UPDATE warehouse_shipments
       SET last_tracking_status_detail = COALESCE(p_status_detail, last_tracking_status_detail),
           last_tracking_status_updated_at = v_status_at
     WHERE id = p_shipment_id;
    RETURN QUERY SELECT false, v_existing_status, p_new_status, 'no_op_same_status';
    RETURN;
  END IF;

  IF NOT v_allowed THEN
    RETURN QUERY SELECT false, v_existing_status, p_new_status, 'older_status_ignored';
    RETURN;
  END IF;

  UPDATE warehouse_shipments
     SET easypost_tracker_status = p_new_status,
         last_tracking_status_detail = COALESCE(p_status_detail, last_tracking_status_detail),
         last_tracking_status_updated_at = v_status_at
   WHERE id = p_shipment_id;
  RETURN QUERY SELECT true, v_existing_status, p_new_status, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION update_shipment_tracking_status_safe(uuid, text, text, timestamptz)
  TO authenticated, service_role;

COMMENT ON FUNCTION update_shipment_tracking_status_safe IS
  'Slice 2 — sticky terminal-state machine for warehouse_shipments.easypost_tracker_status. Use the wrapper at src/lib/server/notification-status.ts.';

-- Helper used by update_shipment_tracking_status_safe.
CREATE OR REPLACE FUNCTION tracking_status_rank(p_status text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'pre_transit' THEN 10
    WHEN 'unknown' THEN 15
    WHEN 'in_transit' THEN 20
    WHEN 'available_for_pickup' THEN 30
    WHEN 'out_for_delivery' THEN 40
    WHEN 'delivered' THEN 100
    WHEN 'return_to_sender' THEN 100
    WHEN 'cancelled' THEN 100
    WHEN 'failure' THEN 100
    WHEN 'error' THEN 100
    ELSE 0
  END;
$$;

-- ── 8. apply_operator_notification_action RPC ──────────────────────────
-- Atomic operator action: status transition + notification_operator_events
-- audit row in a SINGLE transaction so the audit log can't disagree with
-- the state machine.
CREATE OR REPLACE FUNCTION apply_operator_notification_action(
  p_notification_send_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_new_status text DEFAULT NULL
)
RETURNS TABLE(
  applied boolean,
  previous_status text,
  new_status text,
  skipped_reason text,
  operator_event_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_status text;
  v_state_result record;
  v_event_id uuid;
BEGIN
  IF p_action = 'cancel' THEN
    v_target_status := 'cancelled';
  ELSIF p_action = 'retry' THEN
    v_target_status := 'pending';
  ELSIF p_action = 'force_resend' THEN
    v_target_status := 'pending';
  ELSIF p_action = 'mark_delivered_manual' THEN
    v_target_status := 'delivered';
  ELSE
    v_target_status := COALESCE(p_new_status, 'pending');
  END IF;

  SELECT * INTO v_state_result
  FROM update_notification_status_safe(
    p_notification_send_id,
    v_target_status,
    NULL,
    NULL,
    NULL
  );

  INSERT INTO notification_operator_events (
    notification_send_id,
    actor_user_id,
    action,
    reason,
    previous_status,
    new_status
  ) VALUES (
    p_notification_send_id,
    p_actor_user_id,
    p_action,
    p_reason,
    v_state_result.previous_status,
    CASE WHEN v_state_result.applied THEN v_state_result.new_status ELSE v_state_result.previous_status END
  )
  RETURNING id INTO v_event_id;

  RETURN QUERY SELECT
    v_state_result.applied,
    v_state_result.previous_status,
    v_state_result.new_status,
    v_state_result.skipped_reason,
    v_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_operator_notification_action(uuid, uuid, text, text, text)
  TO authenticated, service_role;

COMMIT;
