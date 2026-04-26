-- Autonomous SKU matcher — Phase 3.B RPC pair:
--   apply_order_fulfillment_hold + release_order_fulfillment_hold.
--
-- Plan: autonomous_sku_matching_da557209.plan.md
--       §"Order hold RPC contract" and
--       §"Shadow-to-live promotion criteria" (for the release side).
--       Release gates SKU-AUTO-15 (apply-hold atomic),
--       SKU-AUTO-17 (release resolution-code whitelist),
--       SKU-AUTO-21 (committable-warehouse lines commit in same
--       transaction as the hold write),
--       SKU-AUTO-22 (pg_advisory_xact_lock per order serializes
--       hold/release races),
--       SKU-AUTO-32 (staff_override requires a note at the RPC level
--       and hold recovery works via typed resolution_codes).
--
-- Companion to the Phase 0 + Phase 1 migrations
-- (20260428000001 + 20260428000002). Purely additive, idempotent
-- (CREATE OR REPLACE), and safe to re-apply.
--
-- Contract — apply_order_fulfillment_hold:
--   1. Takes pg_advisory_xact_lock(hashtextextended(
--        'apply_order_fulfillment_hold:' || order_id::text, 0))
--      as its FIRST effectful statement so concurrent hold/release
--      callers queue per-order. Transaction-scoped: released on
--      commit/rollback (SKU-AUTO-22).
--   2. Validates the hold_reason against the Phase 2 HoldReason
--      taxonomy. Accepted values match the TS
--      `HoldReason` union in `src/lib/server/order-hold-policy.ts`:
--        * unknown_remote_sku
--        * placeholder_remote_sku
--        * non_warehouse_match
--        * fetch_incomplete_at_match
--      Note: `all_lines_warehouse_ready` is a TS-side "no hold"
--      signal and must NEVER reach this RPC — rejection at the
--      RPC layer is defense-in-depth.
--   3. Locks warehouse_orders FOR UPDATE.
--   4. Idempotent retry guard: if the order is already on_hold with
--      the same fulfillment_hold_cycle_id the caller passed, return
--      the existing hold_event_id with commits_inserted=0. This
--      makes webhook retries safe without additional caller logic.
--   5. Rejects transitions from `cancelled` and from a DIFFERENT
--      existing cycle. Both are caller bugs.
--   6. Atomic:
--        (a) UPDATE warehouse_orders.fulfillment_hold='on_hold' +
--            reason + at=now() + cycle_id, clears
--            fulfillment_hold_released_at / released_by,
--        (b) INSERT order_fulfillment_hold_events row
--            (event_type='hold_applied', affected_lines=p_held_lines),
--        (c) For each item in p_commit_lines with qty > 0, INSERT
--            inventory_commitments ON CONFLICT DO NOTHING against
--            the partial unique index. The commitments_sync trigger
--            keeps warehouse_inventory_levels.committed_quantity in
--            lockstep — all in the SAME TRANSACTION as the hold
--            write (SKU-AUTO-21).
--   7. Returns (hold_event_id uuid, commits_inserted integer).
--
-- Contract — release_order_fulfillment_hold:
--   1. Same per-order advisory lock as apply (shared namespace —
--      a release and an apply on the same order must serialize).
--   2. Validates p_resolution_code against the Phase 3 taxonomy:
--        * staff_override (requires p_note)
--        * fetch_recovered_evaluator_passed (hold-recovery task)
--        * alias_learned (Phase 4 webhook rehydrate)
--        * manual_sku_fix (staff UI)
--        * order_cancelled
--   3. staff_override without a note is rejected at the RPC layer
--      (SKU-AUTO-17).
--   4. Locks warehouse_orders FOR UPDATE.
--   5. Idempotent retry on already-released: returns the most
--      recent hold_released event id.
--   6. Rejects release from no_hold / cancelled — those are caller
--      bugs.
--   7. Atomic:
--        (a) UPDATE warehouse_orders.fulfillment_hold='released' +
--            released_at=now() + released_by=p_actor_id,
--        (b) INSERT order_fulfillment_hold_events row
--            (event_type='hold_released', resolution_code, metadata
--             captures actor_kind + note).
--   8. Returns hold_event_id uuid (of the hold_released row).
--
-- Both RPCs are SECURITY DEFINER with search_path pinned to public,
-- pg_temp per Supabase best practice.
--
-- Inventory commitment semantics (SKU-AUTO-21):
--   The same-transaction commit insert is the reason this RPC exists
--   in SQL rather than at the TS layer. PostgREST multi-call chains
--   are NOT transactions per Rule #64; the only way to guarantee the
--   hold write and the inventory_commitments write see each other
--   atomically is a single PL/pgSQL function. On retry the ON
--   CONFLICT clause makes the commit inserts safe no-ops.

BEGIN;

-- ──────────────────────────────────────────────────────────────────
-- apply_order_fulfillment_hold
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION apply_order_fulfillment_hold(
  p_order_id uuid,
  p_connection_id uuid,
  p_reason text,
  p_cycle_id uuid,
  p_held_lines jsonb,
  p_commit_lines jsonb DEFAULT '[]'::jsonb,
  p_actor_kind text DEFAULT 'system',
  p_actor_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  hold_event_id uuid,
  commits_inserted integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order RECORD;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_commit_item jsonb;
  v_commits_inserted integer := 0;
  v_commit_delta integer;
  v_item_sku text;
  v_item_qty integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('apply_order_fulfillment_hold:' || p_order_id::text, 0)
  );

  IF p_reason NOT IN (
    'unknown_remote_sku',
    'placeholder_remote_sku',
    'non_warehouse_match',
    'fetch_incomplete_at_match'
  ) THEN
    RAISE EXCEPTION
      'apply_order_fulfillment_hold: invalid hold reason %', p_reason
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_cycle_id IS NULL THEN
    RAISE EXCEPTION
      'apply_order_fulfillment_hold: p_cycle_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT *
    INTO v_order
    FROM warehouse_orders
    WHERE id = p_order_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'apply_order_fulfillment_hold: order % not found', p_order_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent retry: exact same cycle already on_hold.
  IF v_order.fulfillment_hold = 'on_hold'
     AND v_order.fulfillment_hold_cycle_id = p_cycle_id THEN
    SELECT id
      INTO v_existing_event_id
      FROM order_fulfillment_hold_events
      WHERE order_id = p_order_id
        AND hold_cycle_id = p_cycle_id
        AND event_type = 'hold_applied'
      ORDER BY created_at ASC
      LIMIT 1;
    hold_event_id := v_existing_event_id;
    commits_inserted := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_order.fulfillment_hold = 'cancelled' THEN
    RAISE EXCEPTION
      'apply_order_fulfillment_hold: order % is cancelled; cannot hold', p_order_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_order.fulfillment_hold = 'on_hold'
     AND v_order.fulfillment_hold_cycle_id IS DISTINCT FROM p_cycle_id THEN
    RAISE EXCEPTION
      'apply_order_fulfillment_hold: order % already on_hold with cycle %, caller supplied %',
      p_order_id, v_order.fulfillment_hold_cycle_id, p_cycle_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE warehouse_orders
     SET fulfillment_hold = 'on_hold',
         fulfillment_hold_reason = p_reason,
         fulfillment_hold_at = now(),
         fulfillment_hold_released_at = NULL,
         fulfillment_hold_released_by = NULL,
         fulfillment_hold_cycle_id = p_cycle_id,
         fulfillment_hold_metadata = COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = p_order_id;

  INSERT INTO order_fulfillment_hold_events (
    workspace_id,
    connection_id,
    order_id,
    hold_cycle_id,
    event_type,
    hold_reason,
    affected_lines,
    actor_id,
    metadata
  )
  VALUES (
    v_order.workspace_id,
    p_connection_id,
    p_order_id,
    p_cycle_id,
    'hold_applied',
    p_reason,
    COALESCE(p_held_lines, '[]'::jsonb),
    p_actor_id,
    -- Caller metadata first; system keys override so actor_kind cannot be spoofed.
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('actor_kind', COALESCE(p_actor_kind, 'system'))
  )
  RETURNING id INTO v_event_id;

  -- SKU-AUTO-21: same-transaction inventory commit for committable
  -- lines. ON CONFLICT DO NOTHING against the partial unique index
  -- (workspace_id, source, source_id, sku) WHERE released_at IS NULL.
  IF p_commit_lines IS NOT NULL
     AND jsonb_typeof(p_commit_lines) = 'array'
     AND jsonb_array_length(p_commit_lines) > 0 THEN
    FOR v_commit_item IN
      SELECT jsonb_array_elements(p_commit_lines)
    LOOP
      v_item_sku := v_commit_item->>'sku';
      v_item_qty := NULLIF(v_commit_item->>'qty', '')::integer;
      IF v_item_sku IS NOT NULL
         AND length(v_item_sku) > 0
         AND v_item_qty IS NOT NULL
         AND v_item_qty > 0 THEN
        INSERT INTO inventory_commitments (
          workspace_id,
          sku,
          source,
          source_id,
          qty,
          metadata
        )
        VALUES (
          v_order.workspace_id,
          v_item_sku,
          'order',
          p_order_id::text,
          v_item_qty,
          jsonb_build_object(
            'kind', 'order_items_partial_hold',
            'hold_cycle_id', p_cycle_id
          )
        )
        ON CONFLICT (workspace_id, source, source_id, sku)
          WHERE released_at IS NULL
          DO NOTHING;
        GET DIAGNOSTICS v_commit_delta = ROW_COUNT;
        v_commits_inserted := v_commits_inserted + v_commit_delta;
      END IF;
    END LOOP;
  END IF;

  hold_event_id := v_event_id;
  commits_inserted := v_commits_inserted;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION apply_order_fulfillment_hold IS
  'Phase 3.B Autonomous SKU matcher. Atomic writer for
warehouse_orders.fulfillment_hold=''on_hold'' + the hold_applied
order_fulfillment_hold_events row + inventory_commitments rows for
any committable-warehouse lines on a partial-hold order. Serializes
per order via pg_advisory_xact_lock. Idempotent on retry with the
same (order_id, cycle_id). Release gates SKU-AUTO-15, SKU-AUTO-21,
SKU-AUTO-22. Must be invoked via the
`src/lib/server/order-hold-rpcs.ts` wrapper — direct callers bypass
the bulk-hold suppression in SKU-AUTO-31.';

-- ──────────────────────────────────────────────────────────────────
-- release_order_fulfillment_hold
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION release_order_fulfillment_hold(
  p_order_id uuid,
  p_resolution_code text,
  p_note text DEFAULT NULL,
  p_actor_kind text DEFAULT 'system',
  p_actor_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order RECORD;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_cycle_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('apply_order_fulfillment_hold:' || p_order_id::text, 0)
  );

  IF p_resolution_code NOT IN (
    'staff_override',
    'fetch_recovered_evaluator_passed',
    'alias_learned',
    'manual_sku_fix',
    'order_cancelled'
  ) THEN
    RAISE EXCEPTION
      'release_order_fulfillment_hold: invalid resolution_code %', p_resolution_code
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_resolution_code = 'staff_override'
     AND (p_note IS NULL OR btrim(p_note) = '') THEN
    RAISE EXCEPTION
      'release_order_fulfillment_hold: staff_override requires a note'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_order
    FROM warehouse_orders
    WHERE id = p_order_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'release_order_fulfillment_hold: order % not found', p_order_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent retry on already-released.
  IF v_order.fulfillment_hold = 'released' THEN
    SELECT id
      INTO v_existing_event_id
      FROM order_fulfillment_hold_events
      WHERE order_id = p_order_id
        AND event_type = 'hold_released'
      ORDER BY created_at DESC
      LIMIT 1;
    RETURN v_existing_event_id;
  END IF;

  IF v_order.fulfillment_hold <> 'on_hold' THEN
    RAISE EXCEPTION
      'release_order_fulfillment_hold: order % is in state %, cannot release',
      p_order_id, v_order.fulfillment_hold
      USING ERRCODE = 'check_violation';
  END IF;

  v_cycle_id := v_order.fulfillment_hold_cycle_id;
  IF v_cycle_id IS NULL THEN
    RAISE EXCEPTION
      'release_order_fulfillment_hold: order % is on_hold but cycle_id is NULL (data corruption)',
      p_order_id
      USING ERRCODE = 'data_exception';
  END IF;

  UPDATE warehouse_orders
     SET fulfillment_hold = 'released',
         fulfillment_hold_released_at = now(),
         fulfillment_hold_released_by = p_actor_id,
         updated_at = now()
   WHERE id = p_order_id;

  INSERT INTO order_fulfillment_hold_events (
    workspace_id,
    connection_id,
    order_id,
    hold_cycle_id,
    event_type,
    hold_reason,
    resolution_code,
    affected_lines,
    actor_id,
    metadata
  )
  VALUES (
    v_order.workspace_id,
    NULL,
    p_order_id,
    v_cycle_id,
    'hold_released',
    v_order.fulfillment_hold_reason,
    p_resolution_code,
    '[]'::jsonb,
    p_actor_id,
    -- Caller metadata first; system keys override so actor_kind/note cannot be spoofed.
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object(
           'actor_kind', COALESCE(p_actor_kind, 'system'),
           'note', p_note
         )
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION release_order_fulfillment_hold IS
  'Phase 3.B Autonomous SKU matcher. Atomic writer for
warehouse_orders.fulfillment_hold=''released'' + the hold_released
order_fulfillment_hold_events row. Resolution codes restricted to
{staff_override, fetch_recovered_evaluator_passed, alias_learned,
manual_sku_fix, order_cancelled}. staff_override requires a note.
Serializes per order via pg_advisory_xact_lock (shared namespace
with apply_order_fulfillment_hold). Idempotent on retry. Release
gates SKU-AUTO-17, SKU-AUTO-22, SKU-AUTO-32.';

COMMIT;
