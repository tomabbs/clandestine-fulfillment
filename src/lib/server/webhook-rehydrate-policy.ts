/**
 * Autonomous SKU matcher — webhook-ingress demotion-rehydrate policy (Phase 4).
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Post-demotion webhook ingress (the demotion black hole fix)"
 *       (lines ~717–732) + release gate SKU-AUTO-24.
 *
 * Contract summary:
 *   A Shopify `inventory_levels/update` (or WooCommerce/Squarespace
 *   equivalent) arrives for a remote listing that has no LIVE alias in
 *   `client_store_sku_mappings`. Before we fork the event into
 *   unknown-SKU discovery (which would keep piling `auto_holdout_for_
 *   evidence` rows on an identity we already resolved), we check
 *   `client_store_product_identity_matches` for an active identity
 *   row. If one exists we act on it here:
 *
 *     * `client_stock_exception`  — try to re-promote when the stock
 *       signal is credible, stable at the `boost` window, AND warehouse
 *       ATP is positive again. Otherwise we just bump the evidence.
 *     * any other active outcome state — we update evidence and hand off
 *       to the scheduled promotion task; we NEVER route to discovery.
 *
 *   When no identity row is found we defer to the caller ("route to
 *   discovery"); if one is found we NEVER produce that action.
 *
 * Purity contract:
 *   No I/O, no `Date.now()` (the stability gate reads `Date.now()`
 *   internally; tests set it via `vi.useFakeTimers()`). Same input ⇒
 *   same decision. The orchestrator in `webhook-rehydrate.ts` owns all
 *   DB reads and writes.
 *
 * Out of scope for this module:
 *   * Emergency-pause check — lives in the orchestrator because the
 *     workspace row read is an I/O step.
 *   * `sku_live_alias_autonomy_enabled` flag check — lives in the
 *     `promoteIdentityMatchToAlias` wrapper (defense-in-depth).
 *   * Identity-row lookup cascade — lives in the orchestrator.
 */

import type { StockHistoryReadings, StockSignal } from "@/lib/server/stock-reliability";
import { classifyStockTier, isStockStableFor } from "@/lib/server/stock-reliability";

/**
 * Outcome states we recognize on an identity row. Mirrors the DB CHECK
 * on `client_store_product_identity_matches.outcome_state` so any
 * schema drift shows up at compile time when this union is updated.
 */
export type IdentityOutcomeStateForRehydrate =
  | "auto_database_identity_match"
  | "auto_shadow_identity_match"
  | "auto_holdout_for_evidence"
  | "auto_reject_non_match"
  | "auto_skip_non_operational"
  | "fetch_incomplete_holdout"
  | "client_stock_exception";

/**
 * The snapshot the orchestrator hands to the policy. Only the fields
 * the policy branches on — everything else the orchestrator may need
 * (IDs, timestamps, workspace, connection, variant) is its concern.
 */
export interface IdentityRowSnapshot {
  outcomeState: IdentityOutcomeStateForRehydrate;
  isActive: boolean;
  stateVersion: number;
  variantId: string | null;
}

/**
 * Rationale codes surfaced on every non-promote decision. Callers log
 * these verbatim (telemetry + audit rows) so the operator can grep the
 * rationale without parsing free-form strings.
 */
export const REHYDRATE_RATIONALES = {
  no_identity_row: "no_identity_row",
  inactive_identity_row: "inactive_identity_row",
  not_stock_exception: "not_stock_exception",
  stock_tier_unreliable: "stock_tier_unreliable",
  remote_stock_not_positive: "remote_stock_not_positive",
  warehouse_atp_zero: "warehouse_atp_zero",
  stability_gate_failed: "stability_gate_failed",
  stock_positive_promotion: "stock_positive_promotion",
} as const;

export type RehydrateRationale = (typeof REHYDRATE_RATIONALES)[keyof typeof REHYDRATE_RATIONALES];

/**
 * Discriminated union the orchestrator consumes. `route_to_discovery`
 * is only emitted when no identity row exists; once we have a row the
 * policy always picks one of the other three actions.
 */
export type RehydrateAction =
  | {
      kind: "route_to_discovery";
      rationale: "no_identity_row";
    }
  | {
      kind: "update_evidence_only";
      rationale: "inactive_identity_row" | "not_stock_exception";
      outcomeState: IdentityOutcomeStateForRehydrate;
    }
  | {
      kind: "bump_reobserved";
      rationale:
        | "stock_tier_unreliable"
        | "remote_stock_not_positive"
        | "warehouse_atp_zero"
        | "stability_gate_failed";
    }
  | {
      kind: "promote";
      rationale: "stock_positive_promotion";
      expectedStateVersion: number;
      reasonCode: "stock_positive_promotion";
    };

export interface DecideRehydrateActionInput {
  identityRow: IdentityRowSnapshot | null;
  /**
   * The inbound stock signal as observed by the webhook handler. Must
   * already carry `observedAtLocal` so `classifyStockTier()` can tier
   * it reliably. The caller is responsible for materializing the
   * signal from the webhook payload — this policy only branches on it.
   */
  inboundStockSignal: StockSignal;
  /**
   * Current warehouse ATP for the identity row's canonical variant,
   * computed by the orchestrator as `MAX(0, available − committed −
   * safety)`. `null` means the orchestrator could not read a
   * warehouse_inventory_levels row for the variant (treat as
   * `warehouse_atp_zero`).
   */
  warehouseAtp: number | null;
  /**
   * Rolling readings of the inbound stock source consumed by the
   * `boost` stability window (plan §"Post-demotion webhook ingress").
   */
  stabilityHistory: StockHistoryReadings;
}

/**
 * Pure rehydrate-action classifier. See module header for the gate
 * sequence; each gate vetos and short-circuits.
 */
export function decideRehydrateAction(input: DecideRehydrateActionInput): RehydrateAction {
  const { identityRow, inboundStockSignal, warehouseAtp, stabilityHistory } = input;

  if (!identityRow) {
    return { kind: "route_to_discovery", rationale: "no_identity_row" };
  }

  if (!identityRow.isActive) {
    // Soft-deactivated rows should never be promoted through the
    // webhook path — staff reactivates them deliberately. Callers still
    // want the evidence update so the audit trail shows the webhook
    // arrived.
    return {
      kind: "update_evidence_only",
      rationale: "inactive_identity_row",
      outcomeState: identityRow.outcomeState,
    };
  }

  if (identityRow.outcomeState !== "client_stock_exception") {
    // For every other active state (identity match / shadow match /
    // holdout / reject / skip / fetch_incomplete_holdout) the
    // scheduled promotion + holdout sweep tasks own the lifecycle; the
    // webhook just records the observation.
    return {
      kind: "update_evidence_only",
      rationale: "not_stock_exception",
      outcomeState: identityRow.outcomeState,
    };
  }

  // --- client_stock_exception rehydrate gates ---

  const tier = classifyStockTier(inboundStockSignal);

  // Only reliable positive-stock signals can trigger a re-promotion.
  // `authoritative`, `fresh_remote`, and `remote_stale` are all
  // acceptable — the stability gate below enforces the "multiple
  // readings agree" requirement. `cached_only`, `unknown`, and
  // `fresh_remote_unbounded` are never sufficient on their own.
  if (tier !== "authoritative" && tier !== "fresh_remote" && tier !== "remote_stale") {
    return { kind: "bump_reobserved", rationale: "stock_tier_unreliable" };
  }

  // Remote stock must be strictly positive. A signal that still reports
  // zero is evidence that the listing has not recovered.
  if (
    typeof inboundStockSignal.value !== "number" ||
    !Number.isFinite(inboundStockSignal.value) ||
    inboundStockSignal.value <= 0
  ) {
    return { kind: "bump_reobserved", rationale: "remote_stock_not_positive" };
  }

  // Warehouse ATP must also be strictly positive. A demoted listing
  // with zero ATP stays demoted; the scheduled shadow-promotion task
  // will catch the re-stock window when warehouse inventory comes back.
  if (warehouseAtp === null || warehouseAtp <= 0) {
    return { kind: "bump_reobserved", rationale: "warehouse_atp_zero" };
  }

  // Stability gate: per plan §"Post-demotion webhook ingress", the
  // `boost` window (6h default) must report the same positive remote
  // value before we promote. This filters out single-spike deliveries
  // from a flaky remote store — one good reading is not enough.
  if (!isStockStableFor("boost", inboundStockSignal, stabilityHistory)) {
    return { kind: "bump_reobserved", rationale: "stability_gate_failed" };
  }

  return {
    kind: "promote",
    rationale: "stock_positive_promotion",
    expectedStateVersion: identityRow.stateVersion,
    reasonCode: "stock_positive_promotion",
  };
}

/**
 * Exported for runtime/drift-guard consumers that need to enumerate
 * the full set of rationale codes (e.g., a dashboard that shows
 * rehydrate outcomes grouped by reason). The object form keeps the
 * union authoritative.
 */
export const REHYDRATE_POLICY_CONTRACT = Object.freeze({
  rationales: REHYDRATE_RATIONALES,
  kinds: ["route_to_discovery", "update_evidence_only", "bump_reobserved", "promote"] as const,
});
