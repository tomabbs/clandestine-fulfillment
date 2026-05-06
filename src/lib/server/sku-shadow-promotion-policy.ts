/**
 * Autonomous SKU matcher — Phase 5.B: pure shadow-promotion policy.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Shadow → live promotion"
 *       §"sku-shadow-promotion" Trigger task.
 *
 * Overview
 * ────────
 * This module is the PURE decision kernel that the `sku-shadow-promotion`
 * Trigger task consumes once per candidate row. It has no I/O, no
 * `Date.now()` side effects (the current time is always passed in),
 * and no dependency on supabase-js. All the information it needs is
 * passed explicitly on the {@link ShadowPromotionCandidate} structure.
 *
 * Legal promotions (plan §"Promotion paths"):
 *
 *   Path A — new strong evidence appeared.
 *     * At least one of the Path-A evidence flags is true:
 *         - `verifiedBandcampOption` — new `bandcamp_product_mappings`
 *           row verified since last evaluation.
 *         - `exactBarcodeMatch` — verified UPC/GTIN from an
 *           authoritative or fresh_remote catalog field.
 *         - `exactSkuMatchSafe` — exact SKU match AND the SKU is
 *           `canonicalSkuUniqueWithinOrg && remoteSkuUniqueWithinConnection
 *            && !isPlaceholderSku(remoteSku)`.
 *     * `warehouseStockAtMatch > 0` (operational readiness).
 *     * `warehouseAtpNow > 0` (fresh ATP at promotion time).
 *     * Stock-stability gate passes at the `promotion` window.
 *
 *   Path B — stability over time.
 *     * `ageDays >= SHADOW_STABILITY_DAYS_MIN` (14d).
 *     * `priorDatabaseIdentityDecisionCount >= SHADOW_DECISION_COUNT_MIN` (5).
 *     * `warehouseStockAtMatch > 0`, `warehouseAtpNow > 0`.
 *     * Stock-stability gate passes at the `promotion` window.
 *
 *   Path C — human approval.
 *     * NOT evaluated by this pure helper. Human overrides come
 *       through the SKU matching UI Server Action, which calls
 *       `promoteIdentityMatchToAlias({ path: 'C', … })` directly.
 *       The scheduled task only automates Paths A and B.
 *
 * If no path qualifies, the caller MUST still bump the row's
 * `evaluation_count` and `last_evaluated_at` (and increment
 * `state_version`) so Path B's stability window advances. The
 * returned {@link ShadowPromotionDecision} distinguishes promote vs
 * bump and carries the set of disqualifier codes for audit rows.
 *
 * Purity contract
 * ──────────────
 * `now: Date` is the only "clock" input — tests fake it with a fixed
 * Date. No module-level mutable state. All public types are
 * structurally defined so test fixtures can be plain literals.
 */

import type { StockHistoryReadings, StockSignal } from "@/lib/server/stock-reliability";
import { isStockStableFor } from "@/lib/server/stock-reliability";

export const SHADOW_STABILITY_DAYS_MIN = 14;
export const SHADOW_DECISION_COUNT_MIN = 5;

/**
 * Reasons promotion is disqualified. Each veto appends one code to the
 * decision so audit rows carry the full trace.
 */
export type ShadowPromotionDisqualifier =
  | "outcome_state_not_promotable"
  | "warehouse_stock_at_match_not_positive"
  | "warehouse_atp_not_positive"
  | "no_path_a_evidence"
  | "path_b_age_not_met"
  | "path_b_decision_count_not_met"
  | "stability_gate_failed"
  | "missing_stock_signal"
  | "state_version_unknown";

/**
 * Subset of promotion reason codes this evaluator can emit. The
 * superset lives in `sku-alias-promotion.ts::PromotionReasonCode`.
 */
export type ShadowPromotionReasonCode =
  | "verified_bandcamp_option"
  | "exact_barcode_match"
  | "exact_sku_match"
  | "shadow_stability_window_passed";

export interface PathAEvidenceFlags {
  verifiedBandcampOption?: boolean;
  exactBarcodeMatch?: boolean;
  exactSkuMatchSafe?: boolean;
}

/**
 * Inputs the scheduled task gathers before handing a row to the
 * evaluator. Every field is pre-fetched by the orchestrator so the
 * evaluator is a single synchronous call.
 */
export interface ShadowPromotionCandidate {
  identityMatchId: string;
  workspaceId: string;
  connectionId: string;
  variantId: string | null;
  outcomeState: string;
  stateVersion: number;
  createdAt: string;
  evaluationCount: number;
  warehouseStockAtMatch: number | null;
  /**
   * Flags the orchestrator derives from `evidence_snapshot` and any
   * joined evidence tables (`bandcamp_product_mappings`,
   * `warehouse_product_variants.barcode`, etc.).
   */
  pathAEvidence: PathAEvidenceFlags;
  /**
   * COUNT(*) on `sku_autonomous_decisions` where
   * `identity_match_id = candidate.identityMatchId` AND
   * `outcome_state = 'auto_database_identity_match'`. Includes the
   * initial decision row written when the identity match was first
   * created.
   */
  priorDatabaseIdentityDecisionCount: number;
  /**
   * Current warehouse ATP for `variantId`. null → treat as 0 (policy
   * emits `warehouse_atp_not_positive`).
   */
  warehouseAtpNow: number | null;
  /**
   * Fresh warehouse stock reading — the orchestrator passes the same
   * `StockSignal` shape the ranker uses so tier + value are explicit.
   * May be null when no reading is available (e.g. stock_stability_readings
   * table empty for this variant). The policy emits
   * `missing_stock_signal` when null.
   */
  stockSignal: StockSignal | null;
  /**
   * Stock history the stability gate consumes. Empty readings array is
   * acceptable input — the gate will fail on its own.
   */
  stabilityHistory: StockHistoryReadings;
}

export type ShadowPromotionDecision =
  | {
      action: "promote";
      path: "A" | "B";
      reasonCode: ShadowPromotionReasonCode;
      disqualifiers: [];
    }
  | {
      action: "bump";
      disqualifiers: ShadowPromotionDisqualifier[];
    };

/**
 * Evaluate a single shadow-promotion candidate against Paths A and B.
 * Always returns a decision — `promote` or `bump` — and always
 * populates `disqualifiers` for the audit row.
 *
 * @param candidate — fully-populated inputs (orchestrator pre-fetches).
 * @param now — clock reference used for age math. Tests pin via fake timers.
 */
export function shouldPromoteShadow(
  candidate: ShadowPromotionCandidate,
  now: Date,
): ShadowPromotionDecision {
  const disqualifiers: ShadowPromotionDisqualifier[] = [];

  if (candidate.outcomeState !== "auto_database_identity_match") {
    disqualifiers.push("outcome_state_not_promotable");
    return { action: "bump", disqualifiers };
  }

  const warehouseAtpNow = candidate.warehouseAtpNow ?? 0;
  const warehouseAtMatch = candidate.warehouseStockAtMatch ?? 0;

  if (warehouseAtMatch <= 0) {
    disqualifiers.push("warehouse_stock_at_match_not_positive");
  }
  if (warehouseAtpNow <= 0) {
    disqualifiers.push("warehouse_atp_not_positive");
  }
  if (candidate.stockSignal === null) {
    disqualifiers.push("missing_stock_signal");
  }
  if (!Number.isFinite(candidate.stateVersion)) {
    disqualifiers.push("state_version_unknown");
  }

  // Stability gate — required for both A and B. Failure is recorded
  // but both path checks still run so the disqualifier set stays
  // informative.
  const stabilityPasses =
    candidate.stockSignal !== null &&
    isStockStableFor("promotion", candidate.stockSignal, candidate.stabilityHistory, now);

  if (!stabilityPasses) {
    disqualifiers.push("stability_gate_failed");
  }

  // ── Path A ──────────────────────────────────────────────────────────
  const pathAReason = pickPathAReason(candidate.pathAEvidence);
  const pathABlockedByGates = warehouseAtMatch <= 0 || warehouseAtpNow <= 0 || !stabilityPasses;

  if (pathAReason === null) {
    disqualifiers.push("no_path_a_evidence");
  } else if (!pathABlockedByGates) {
    return {
      action: "promote",
      path: "A",
      reasonCode: pathAReason,
      disqualifiers: [],
    };
  }

  // ── Path B ──────────────────────────────────────────────────────────
  const ageDays = ageDaysBetween(candidate.createdAt, now);
  if (ageDays < SHADOW_STABILITY_DAYS_MIN) {
    disqualifiers.push("path_b_age_not_met");
  }
  if (candidate.priorDatabaseIdentityDecisionCount < SHADOW_DECISION_COUNT_MIN) {
    disqualifiers.push("path_b_decision_count_not_met");
  }

  const pathBBlockedByGates =
    warehouseAtMatch <= 0 ||
    warehouseAtpNow <= 0 ||
    !stabilityPasses ||
    ageDays < SHADOW_STABILITY_DAYS_MIN ||
    candidate.priorDatabaseIdentityDecisionCount < SHADOW_DECISION_COUNT_MIN;

  if (!pathBBlockedByGates) {
    return {
      action: "promote",
      path: "B",
      reasonCode: "shadow_stability_window_passed",
      disqualifiers: [],
    };
  }

  return {
    action: "bump",
    disqualifiers: dedupeDisqualifiers(disqualifiers),
  };
}

/**
 * Pick the highest-signal Path-A reason code present. Priority order:
 * verified Bandcamp option > exact barcode match > exact SKU match.
 * Returns null when no Path-A evidence flag is set.
 */
function pickPathAReason(flags: PathAEvidenceFlags): ShadowPromotionReasonCode | null {
  if (flags.verifiedBandcampOption === true) return "verified_bandcamp_option";
  if (flags.exactBarcodeMatch === true) return "exact_barcode_match";
  if (flags.exactSkuMatchSafe === true) return "exact_sku_match";
  return null;
}

/**
 * Compute elapsed days as an integer floor. Callers treat
 * `ageDaysBetween(createdAt, now) >= 14` as "14-day window passed".
 *
 * A negative result (createdAt is in the future relative to `now`)
 * returns 0 — clock skew shouldn't accidentally promote a row.
 */
export function ageDaysBetween(createdAtIso: string, now: Date): number {
  const createdMs = new Date(createdAtIso).getTime();
  if (!Number.isFinite(createdMs)) return 0;
  const diffMs = now.getTime() - createdMs;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Preserve insertion order while deduping. Disqualifiers can
 * accumulate from multiple gates touching the same underlying fact.
 */
function dedupeDisqualifiers(list: ShadowPromotionDisqualifier[]): ShadowPromotionDisqualifier[] {
  const seen = new Set<ShadowPromotionDisqualifier>();
  const out: ShadowPromotionDisqualifier[] = [];
  for (const code of list) {
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
