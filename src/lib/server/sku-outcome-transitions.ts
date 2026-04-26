/**
 * Autonomous SKU matcher — outcome state machine for
 * `client_store_product_identity_matches`.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Outcome state machine" + §"Enforcement contract — three
 *       modules, one truth each" + release gates SKU-AUTO-6 / SKU-AUTO-11
 *       / SKU-AUTO-14 / SKU-AUTO-22.
 *
 * Scope:
 *   * Owns the state machine for IDENTITY rows only. Live aliases live
 *     on `client_store_sku_mappings` and are governed by the (to be
 *     added in Phase 1+) `src/lib/server/sku-alias-promotion.ts`. Order
 *     hold state is governed by (to be added) `order-hold-policy.ts`.
 *     No module here writes another module's table.
 *   * Exports TWO state sets:
 *       1. `STORED_IDENTITY_OUTCOME_STATES` — exactly equals the DB
 *          CHECK constraint on
 *          `client_store_product_identity_matches.outcome_state`.
 *       2. `FULL_OUTCOME_STATES` — adds `auto_live_inventory_alias`,
 *          which is stored on `client_store_sku_mappings` (not the
 *          identity table). The state machine's alphabet is this
 *          superset.
 *     The CI drift guard in
 *     `tests/unit/lib/server/sku-outcome-transitions.test.ts` asserts
 *     both sets match their respective DB surfaces (release gate
 *     SKU-AUTO-6).
 *
 * This module does NOT perform any DB writes in Phase 1. The DB RPC
 * that actually applies the transition (pessimistic lock + OCC +
 * `sku_outcome_transitions` row) is Phase 2+. Phase 1 lands the types,
 * the legal-transition table, and pure `isLegalTransition()` so the
 * ranker / shadow-promotion loop can be unit-tested before the RPC
 * exists.
 */

/**
 * States stored on `client_store_product_identity_matches`. This list
 * MUST equal the DB CHECK constraint (migration
 * `20260428000001_sku_autonomous_matching_phase0.sql` §"Section B").
 * CI drift guard SKU-AUTO-6 enforces equality.
 */
export const STORED_IDENTITY_OUTCOME_STATES = [
  "auto_database_identity_match",
  "auto_shadow_identity_match",
  "auto_holdout_for_evidence",
  "auto_reject_non_match",
  "auto_skip_non_operational",
  "fetch_incomplete_holdout",
  "client_stock_exception",
] as const;

export type StoredIdentityOutcomeState = (typeof STORED_IDENTITY_OUTCOME_STATES)[number];

/**
 * Full alphabet of the state machine. Includes the one state that lives
 * on `client_store_sku_mappings` (the live-alias table).
 */
export const FULL_OUTCOME_STATES = [
  ...STORED_IDENTITY_OUTCOME_STATES,
  "auto_live_inventory_alias",
] as const;

export type OutcomeState = (typeof FULL_OUTCOME_STATES)[number];

export type TransitionTrigger =
  | "evidence_gate"
  | "stock_change"
  | "human_review"
  | "fetch_recovery"
  | "periodic_revaluation";

/**
 * Canonical reason codes. Each codifies why a transition happened. The
 * DB requires a non-null `reason_code` on every `sku_outcome_transitions`
 * row, so callers MUST supply one.
 */
export type ReasonCode =
  | "exact_barcode_match"
  | "exact_sku_match"
  | "verified_bandcamp_option"
  | "stock_positive_promotion"
  | "warehouse_stock_zero_demoted"
  | "holdout_expired_90_days"
  | "holdout_expired_10_evaluations"
  | "descriptor_mismatch_color"
  | "descriptor_mismatch_edition"
  | "descriptor_mismatch_bundle"
  | "placeholder_sku_detected"
  | "duplicate_remote_detected"
  | "fetch_timeout"
  | "fetch_recovered"
  | "human_override"
  | "shadow_stability_window_passed";

/**
 * Automation cannot egress terminal states; only `human_review` may.
 */
export const TERMINAL_AUTONOMOUS_STATES: readonly OutcomeState[] = [
  "auto_reject_non_match",
  "auto_skip_non_operational",
] as const;

export type InitialOr<T> = T | "initial";

/**
 * Legal transition table. Each entry declares the set of valid target
 * states for the given source + trigger. All other transitions are
 * rejected by `isLegalTransition()`.
 *
 * Cross-check with plan §"Legal transitions" for the prose spec.
 *   * Fan-out from `initial` covers evidence_gate results (six of the
 *     eight identity-side outcomes; `auto_live_inventory_alias` is
 *     reached only from `auto_database_identity_match` via
 *     `stock_change`).
 *   * `auto_live_inventory_alias` can round-trip to
 *     `auto_database_identity_match` when warehouse stock hits zero,
 *     or cross-storage-demote to `client_stock_exception` when remote
 *     stock is positive.
 *   * Only `human_review` may escape `auto_reject_non_match` /
 *     `auto_skip_non_operational`.
 */
type LegalTable = Record<
  InitialOr<OutcomeState>,
  Partial<Record<TransitionTrigger, readonly OutcomeState[]>>
>;

export const LEGAL_TRANSITIONS: LegalTable = {
  initial: {
    evidence_gate: [
      "auto_database_identity_match",
      "auto_shadow_identity_match",
      "auto_holdout_for_evidence",
      "auto_reject_non_match",
      "auto_skip_non_operational",
      "fetch_incomplete_holdout",
    ],
    human_review: [...FULL_OUTCOME_STATES],
  },
  auto_shadow_identity_match: {
    evidence_gate: ["auto_database_identity_match"],
    periodic_revaluation: ["auto_reject_non_match"],
    human_review: [...FULL_OUTCOME_STATES],
  },
  auto_database_identity_match: {
    stock_change: ["auto_live_inventory_alias"],
    periodic_revaluation: ["auto_holdout_for_evidence", "auto_reject_non_match"],
    human_review: [...FULL_OUTCOME_STATES],
  },
  auto_holdout_for_evidence: {
    evidence_gate: ["auto_shadow_identity_match", "auto_database_identity_match"],
    periodic_revaluation: ["auto_reject_non_match"],
    human_review: [...FULL_OUTCOME_STATES],
  },
  auto_live_inventory_alias: {
    stock_change: ["auto_database_identity_match", "client_stock_exception"],
    periodic_revaluation: ["auto_holdout_for_evidence"],
    human_review: [...FULL_OUTCOME_STATES],
  },
  client_stock_exception: {
    stock_change: ["auto_live_inventory_alias"],
    human_review: [...FULL_OUTCOME_STATES],
  },
  fetch_incomplete_holdout: {
    fetch_recovery: [
      "auto_database_identity_match",
      "auto_shadow_identity_match",
      "auto_holdout_for_evidence",
      "auto_reject_non_match",
      "auto_skip_non_operational",
    ],
    human_review: [...FULL_OUTCOME_STATES],
  },
  auto_reject_non_match: {
    human_review: [...FULL_OUTCOME_STATES],
  },
  auto_skip_non_operational: {
    human_review: [...FULL_OUTCOME_STATES],
  },
};

/**
 * Pure predicate. Same (from, to, trigger) ⇒ same answer forever. Used
 * by the ranker dry-run and shadow-promotion planner before any DB
 * write is attempted.
 */
export function isLegalTransition(
  from: InitialOr<OutcomeState>,
  to: OutcomeState,
  trigger: TransitionTrigger,
): boolean {
  const row = LEGAL_TRANSITIONS[from];
  if (!row) return false;
  const targets = row[trigger];
  if (!targets) return false;
  return targets.includes(to);
}

/**
 * Returns every legal (trigger, target-state) pair for the given from
 * state. Used by admin UI to show "what could happen next" and by CI
 * drift guards.
 */
export function legalNextStates(
  from: InitialOr<OutcomeState>,
): Array<{ trigger: TransitionTrigger; to: OutcomeState }> {
  const row = LEGAL_TRANSITIONS[from];
  if (!row) return [];
  const out: Array<{ trigger: TransitionTrigger; to: OutcomeState }> = [];
  for (const [trig, targets] of Object.entries(row) as Array<
    [TransitionTrigger, readonly OutcomeState[] | undefined]
  >) {
    if (!targets) continue;
    for (const to of targets) out.push({ trigger: trig, to });
  }
  return out;
}

/**
 * Input shape for the TS-side wrapper that will call the Phase 2+ RPC.
 * The RPC itself (`apply_outcome_transition`, to be added alongside the
 * shadow-promotion loop in Phase 2) is responsible for:
 *   1. `SELECT pg_advisory_xact_lock(hashtext('sku_transition:' || id))`
 *      as the first statement.
 *   2. Rejecting illegal transitions by consulting a PL/pgSQL mirror of
 *      this table.
 *   3. Rejecting terminal-state egress via any trigger other than
 *      `human_review`.
 *   4. OCC check on `state_version`.
 *   5. Updating the row and appending a `sku_outcome_transitions` audit.
 *
 * Phase 1 only ships this typed shape + the pure predicate above. The
 * wrapper function (`applyOutcomeTransition`) lands when the RPC lands.
 */
export interface ApplyOutcomeTransitionInput {
  workspaceId: string;
  orgId: string;
  connectionId: string;
  variantId?: string | null;
  identityMatchId?: string | null;
  expectedStateVersion: number;
  from: InitialOr<OutcomeState>;
  to: OutcomeState;
  trigger: TransitionTrigger;
  reasonCode: ReasonCode;
  evidenceSnapshot?: Record<string, unknown>;
  triggeredBy?: string | null;
}

/**
 * Validate an `ApplyOutcomeTransitionInput` shape BEFORE calling the RPC.
 * Pure, no I/O. Catches the three most common client-side mistakes:
 *   1. Illegal transition (source state cannot reach target via trigger).
 *   2. Terminal state tried to egress via a non-human trigger.
 *   3. `reasonCode` missing (TypeScript catches absence, but runtime
 *      callers sometimes cast to any — we double-check).
 */
export function validateOutcomeTransition(
  input: ApplyOutcomeTransitionInput,
): { ok: true } | { ok: false; reason: string } {
  if (!input.reasonCode) {
    return { ok: false, reason: "missing_reason_code" };
  }
  if (
    (TERMINAL_AUTONOMOUS_STATES as readonly OutcomeState[]).includes(input.from as OutcomeState) &&
    input.trigger !== "human_review"
  ) {
    return { ok: false, reason: "terminal_state_non_human_egress" };
  }
  if (!isLegalTransition(input.from, input.to, input.trigger)) {
    return { ok: false, reason: "illegal_transition" };
  }
  return { ok: true };
}
