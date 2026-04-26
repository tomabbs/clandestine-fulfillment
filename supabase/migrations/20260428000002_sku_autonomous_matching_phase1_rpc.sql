-- Autonomous SKU matcher — Phase 1 RPC: apply_sku_outcome_transition.
--
-- Plan: autonomous_sku_matching_da557209.plan.md
--       §"Phase 1 — state machine and dry-run decisions".
--       §"applyOutcomeTransition(opts)" contract.
--       Release gates SKU-AUTO-14 (OCC + reason_code required) and
--       SKU-AUTO-22 (pg_advisory_xact_lock serializes concurrent
--       transitions per identity row).
--
-- Companion to the Phase 0 migration (20260428000001). Purely additive
-- and idempotent (CREATE OR REPLACE). Safe to re-apply.
--
-- Contract:
--   1. Takes pg_advisory_xact_lock(hashtext('sku_transition:' || id))
--      as its FIRST effectful statement so concurrent callers queue
--      per-row. Transaction-scoped: released on commit/rollback.
--   2. Re-reads the identity row FOR UPDATE.
--   3. OCC guard: current state_version must equal p_expected_state_version.
--   4. Drift guard: current outcome_state must equal p_expected_from_state
--      (catches the case where a concurrent session transitioned the row
--      through a state the caller did not observe).
--   5. Defense-in-depth invariants enforced at DB level:
--        (a) terminal states (auto_reject_non_match, auto_skip_non_operational)
--            may egress only via trigger='human_review';
--        (b) the identity table NEVER stores 'auto_live_inventory_alias'
--            (that lives on client_store_sku_mappings and is written by
--            promote_identity_match_to_alias only).
--   6. Atomic UPDATE (new outcome_state, state_version+1, last_evaluated_at,
--      evaluation_count+1, updated_at) + INSERT into sku_outcome_transitions
--      in a single transaction.
--   7. Returns (new_state_version, transition_id) so the TS wrapper can
--      refresh its cached state_version without a follow-up SELECT.
--
-- What this RPC does NOT do (intentionally; scoped elsewhere):
--   * It does not create identity rows. The 'initial' → X case is an
--     INSERT path; it is not a state-machine transition.
--   * It does not promote to alias. promote_identity_match_to_alias()
--     (Phase 0) handles cross-table handoff.
--   * It does not mirror the full JS LEGAL_TRANSITIONS table. The TS
--     wrapper calls validateOutcomeTransition() client-side BEFORE this
--     RPC; this RPC enforces only the DB-critical invariants so an
--     out-of-band caller (e.g., psql, a misbehaving script) cannot skip
--     them.

CREATE OR REPLACE FUNCTION apply_sku_outcome_transition(
  p_identity_match_id uuid,
  p_expected_state_version integer,
  p_expected_from_state text,
  p_to_state text,
  p_trigger text,
  p_reason_code text,
  p_evidence_snapshot jsonb DEFAULT NULL,
  p_triggered_by text DEFAULT NULL
)
RETURNS TABLE (
  new_state_version integer,
  transition_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match client_store_product_identity_matches%rowtype;
  v_new_state_version integer;
  v_transition_id uuid;
BEGIN
  IF p_identity_match_id IS NULL THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: identity_match_id is required';
  END IF;
  IF p_expected_state_version IS NULL THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: expected_state_version is required';
  END IF;
  IF p_expected_from_state IS NULL OR length(p_expected_from_state) = 0 THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: expected_from_state is required';
  END IF;
  IF p_to_state IS NULL OR length(p_to_state) = 0 THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: to_state is required';
  END IF;
  IF p_trigger IS NULL OR length(p_trigger) = 0 THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: trigger is required';
  END IF;
  IF p_reason_code IS NULL OR length(p_reason_code) = 0 THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: reason_code is required';
  END IF;

  -- auto_live_inventory_alias lives on client_store_sku_mappings, not
  -- on client_store_product_identity_matches. promote_identity_match_to_alias()
  -- is the only sanctioned path for that transition. Rejecting here
  -- prevents an out-of-band caller from writing the identity row into a
  -- state that violates the Option B isolation contract (SKU-AUTO-1).
  IF p_to_state = 'auto_live_inventory_alias' THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: to_state=auto_live_inventory_alias must go through promote_identity_match_to_alias()';
  END IF;

  -- Pessimistic per-row serialization. Absorbs the webhook thundering
  -- herd (concurrent inventory_levels + products/update for the same
  -- variant) at the DB so dozens of transactions do not spin on OCC and
  -- retry. OCC below is still the correctness backstop for cross-
  -- session races that the lock cannot cover (e.g., periodic_revaluation
  -- vs. manual admin human_review).
  PERFORM pg_advisory_xact_lock(hashtext('sku_transition:' || p_identity_match_id::text));

  SELECT * INTO v_match
    FROM client_store_product_identity_matches
   WHERE id = p_identity_match_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: identity match % not found', p_identity_match_id;
  END IF;

  IF v_match.is_active = false THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: identity match % is not active', p_identity_match_id;
  END IF;

  IF v_match.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: state_version drift for % (expected %, got %)',
      p_identity_match_id, p_expected_state_version, v_match.state_version;
  END IF;

  IF v_match.outcome_state <> p_expected_from_state THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: from_state drift for % (expected %, got %)',
      p_identity_match_id, p_expected_from_state, v_match.outcome_state;
  END IF;

  IF v_match.outcome_state IN ('auto_reject_non_match', 'auto_skip_non_operational')
     AND p_trigger <> 'human_review' THEN
    RAISE EXCEPTION 'apply_sku_outcome_transition: terminal state % can only egress via human_review (got trigger=%)',
      v_match.outcome_state, p_trigger;
  END IF;

  UPDATE client_store_product_identity_matches
     SET outcome_state = p_to_state,
         state_version = state_version + 1,
         last_evaluated_at = now(),
         evaluation_count = evaluation_count + 1,
         updated_at = now()
   WHERE id = p_identity_match_id
   RETURNING state_version INTO v_new_state_version;

  -- v_match.outcome_state is still the OLD value because v_match was
  -- captured BEFORE the UPDATE. Do not reselect here.
  INSERT INTO sku_outcome_transitions (
    workspace_id,
    connection_id,
    variant_id,
    from_state,
    to_state,
    trigger,
    reason_code,
    evidence_snapshot,
    identity_match_id,
    triggered_by
  ) VALUES (
    v_match.workspace_id,
    v_match.connection_id,
    v_match.variant_id,
    v_match.outcome_state,
    p_to_state,
    p_trigger,
    p_reason_code,
    COALESCE(p_evidence_snapshot, v_match.evidence_snapshot, '{}'::jsonb),
    p_identity_match_id,
    p_triggered_by
  )
  RETURNING id INTO v_transition_id;

  new_state_version := v_new_state_version;
  transition_id := v_transition_id;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_sku_outcome_transition(
  uuid, integer, text, text, text, text, jsonb, text
) TO authenticated, service_role;

COMMENT ON FUNCTION apply_sku_outcome_transition(
  uuid, integer, text, text, text, text, jsonb, text
) IS
  'Phase 1 autonomous SKU matcher RPC. Atomic transition of client_store_product_identity_matches row + sku_outcome_transitions audit. Takes pg_advisory_xact_lock first; enforces OCC via state_version; detects from_state drift; rejects terminal-state egress via non-human triggers; rejects writing auto_live_inventory_alias to identity rows (that state lives on client_store_sku_mappings and is written by promote_identity_match_to_alias). Returns (new_state_version, transition_id). Release gates SKU-AUTO-14 + SKU-AUTO-22.';

NOTIFY pgrst, 'reload schema';
