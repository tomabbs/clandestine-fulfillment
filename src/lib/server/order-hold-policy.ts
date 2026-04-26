/**
 * PURE order-hold classification policy.
 *
 * Plan references:
 *   - §1910–1921 "Hold evaluator contract": enumerates HoldReason,
 *     per-line evaluation order, and the {should_hold, affected_lines,
 *     client_alert_required, staff_review_required, hold_reason}
 *     return shape.
 *   - §1944–1960 "Interaction with commitOrderItems() and ATP":
 *     warehouse-stocked lines in a mixed order MUST commit in the
 *     same transaction as the hold. The evaluator's output tells the
 *     caller which lines to commit (`committableLines`) and which to
 *     stay held for client action (`affectedLines`).
 *
 * This module is intentionally pure — NO DB I/O, NO Date.now(), NO
 * random. The async orchestrator lives in `order-hold-evaluator.ts`
 * and is a thin shell around these functions: it fetches per-line
 * state (alias row, identity row, live warehouse stock, fetch_status)
 * and feeds it into `classifyOrderLine` per line; then it rolls up
 * via `decideOrderHold`.
 *
 * Keeping the policy pure means the full decision matrix is covered
 * by in-memory unit tests (see `order-hold-policy.test.ts`), and the
 * orchestrator test only has to verify the queries + state-to-policy
 * handoff, not the decision logic itself.
 */

import type {
  NormalizedClientStoreOrder,
  NormalizedOrderLine,
} from "@/lib/server/normalized-order";
import { isPlaceholderSku } from "@/lib/shared/utils";

/**
 * The five terminal hold reasons per plan §1914. These map 1:1 onto
 * the `fulfillment_hold_reason` column on `warehouse_orders`.
 *
 * Severity taxonomy (used by `decideOrderHold` to pick the primary
 * order-level `holdReason` when lines produce a mixture):
 *
 *   - `fetch_incomplete_at_match` — transient. The `sku-hold-recovery-
 *     recheck` task auto-releases when the next fetch succeeds and
 *     the re-evaluator returns `should_hold=false`. `staffReview`.
 *   - `identity_only_match` — we recognize the product but have not
 *     promoted it to a live alias (still in the autonomous shadow
 *     pipeline). Client can't do anything; autonomous promotion or
 *     staff override is the resolution. `staffReview`.
 *   - `placeholder_sku_detected` — the remote store has a bad SKU
 *     literal (`""`, `"1"`, `"n/a"`, `"SQ12345"`, etc.). Client must
 *     fix the listing. `clientAlert`.
 *   - `unmapped_sku` — remote SKU has never been seen in either the
 *     alias table or the identity table. Client confirms the listing
 *     or removes it. `clientAlert`.
 *   - `non_warehouse_sku` — alias exists but warehouse stock is
 *     non-positive. The classic "they sold a product we don't have
 *     in the warehouse" case. Client replenishes or cancels.
 *     `clientAlert`.
 */
export const HOLD_REASONS = [
  "fetch_incomplete_at_match",
  "placeholder_sku_detected",
  "identity_only_match",
  "unmapped_sku",
  "non_warehouse_sku",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/**
 * The two audiences for a hold notification.
 *
 *   - `clientAlert` — the client-side remedy: fix the remote listing,
 *     replenish stock, or cancel the remote order. The
 *     `send-non-warehouse-order-hold-alert` task sends an email to
 *     the client listing ONLY these lines (plan §1978).
 *   - `staffReview` — internal remedy: autonomous matcher promotes the
 *     identity row to an alias, or the hold-recovery task auto-releases
 *     when the transient fetch error clears. No client email fires on
 *     its own.
 *
 * A single order can require BOTH simultaneously (mixed reasons across
 * lines); the evaluator returns two independent booleans rather than a
 * single audience enum so the caller can route correctly.
 */
export type HoldAudience = "clientAlert" | "staffReview";

export const HOLD_REASON_AUDIENCE: Record<HoldReason, HoldAudience> = {
  fetch_incomplete_at_match: "staffReview",
  identity_only_match: "staffReview",
  placeholder_sku_detected: "clientAlert",
  unmapped_sku: "clientAlert",
  non_warehouse_sku: "clientAlert",
};

/**
 * Priority used to pick THE primary order-level `holdReason` when
 * multiple lines produce different reasons. Lower number = higher
 * priority. This is the deterministic tiebreaker required by release
 * gate SKU-AUTO-3 (webhook and poll paths must pick the same
 * holdReason for the same input order).
 *
 * Rationale for the ordering:
 *   1. `non_warehouse_sku` is the most common, most actionable for
 *      the client, and the worst from an operational standpoint (we
 *      know we can't ship, full stop). Report it first.
 *   2. `unmapped_sku` — client needs to clarify what this SKU is.
 *   3. `placeholder_sku_detected` — client needs to clean up the
 *      listing. Narrow subset of `unmapped_sku`, so reported under
 *      it only if no "true unmapped" line exists.
 *   4. `identity_only_match` — autonomous pipeline will resolve; the
 *      client reading "this is held for internal matching" is less
 *      useful than the alternative reasons above.
 *   5. `fetch_incomplete_at_match` — lowest priority because it is
 *      transient; the recovery task will auto-release soon.
 */
export const HOLD_REASON_PRIORITY: Record<HoldReason, number> = {
  non_warehouse_sku: 1,
  unmapped_sku: 2,
  placeholder_sku_detected: 3,
  identity_only_match: 4,
  fetch_incomplete_at_match: 5,
};

/**
 * Per-line classification result. The discriminant is `committable`
 * vs one of the five hold reasons.
 *
 * When `committable: true`, the caller MUST write an `inventory_commitments`
 * row (source `order`, source_id `warehouse_orders.id`) for this line
 * IN THE SAME TRANSACTION as stamping `fulfillment_hold='on_hold'` on
 * the order (plan §1955). Failing to do so reintroduces the Order-A /
 * Order-B oversell scenario in plan §1946–1951.
 */
export type HoldLineClassification =
  | {
      committable: true;
      line: NormalizedOrderLine;
      /**
       * The alias row id from `client_store_sku_mappings` — needed by
       * the caller to write `inventory_commitments.variant_id`.
       * Guaranteed non-null for `committable: true`.
       */
      aliasId: string;
      variantId: string;
      /** Current positive available stock observed at evaluation. */
      availableStockAtEval: number;
    }
  | {
      committable: false;
      line: NormalizedOrderLine;
      reason: HoldReason;
      /**
       * Carries the matched identity row id when `reason` is
       * `identity_only_match`. Useful for the audit row metadata;
       * null for all other reasons.
       */
      identityMatchId: string | null;
      /**
       * Present when `reason === 'non_warehouse_sku'`. Lets downstream
       * telemetry distinguish "alias with 0 stock" from "alias with
       * negative stock" during drift investigations.
       */
      availableStockAtEval: number | null;
    };

/**
 * State the pure classifier needs for a single line. All of this is
 * pre-fetched by the async orchestrator so the policy stays pure.
 *
 * Field semantics:
 *   - `alias`: a matching, ACTIVE row from `client_store_sku_mappings`
 *     (is_active=true, matching connection_id + remote_sku). Null if
 *     no live-inventory alias exists for this remote SKU.
 *   - `identityMatch`: a matching, ACTIVE row from
 *     `client_store_product_identity_matches` (is_active=true). Null if
 *     no identity-only record exists.
 *   - `warehouseAvailable`: live `warehouse_inventory_levels.available`
 *     for the alias's variant. Null if `alias` is null (we never look
 *     up stock for a line with no alias). A zero or negative value
 *     with an existing alias triggers `non_warehouse_sku`.
 *   - `latestFetchStatus`: the most recent
 *     `sku_autonomous_decisions.fetch_status` for this variant, or
 *     null if no autonomous run has evaluated this variant yet. Any
 *     non-'ok' value on a line that would otherwise be held
 *     (identity_only_match or unmapped_sku) escalates the reason to
 *     `fetch_incomplete_at_match` so the auto-recovery task picks it
 *     up (plan §1921).
 */
export interface OrderLineState {
  readonly alias: {
    readonly id: string;
    readonly variantId: string;
  } | null;
  readonly identityMatch: {
    readonly id: string;
    readonly variantId: string | null;
  } | null;
  readonly warehouseAvailable: number | null;
  readonly latestFetchStatus:
    | "ok"
    | "timeout"
    | "auth_error"
    | "unavailable"
    | "unsupported"
    | "partial"
    | null;
}

/**
 * Classify a single order line. Pure function of (line, state).
 *
 * Evaluation order per plan §1916–1921:
 *   1. Placeholder SKU → `placeholder_sku_detected` (client alert)
 *   2. Active alias present → check `warehouseAvailable`
 *      - positive → `committable: true`
 *      - non-positive (0, negative, or null) → `non_warehouse_sku`
 *   3. No alias, identity row present → `identity_only_match`
 *      (unless step 5 escalates)
 *   4. No alias, no identity → `unmapped_sku` (unless step 5 escalates)
 *   5. If we would have held (reason ∈ {identity_only_match,
 *      unmapped_sku}) AND `latestFetchStatus` is present AND non-'ok',
 *      override to `fetch_incomplete_at_match` so the auto-recovery
 *      task picks it up after the next successful fetch.
 *
 * Note that step 5 only escalates the "ambiguous" holds
 * (identity_only_match, unmapped_sku), not the deterministic ones
 * (placeholder_sku_detected, non_warehouse_sku). A placeholder SKU is
 * a placeholder regardless of fetch status; a zero-stock alias is
 * zero-stock regardless of fetch status.
 */
export function classifyOrderLine(
  line: NormalizedOrderLine,
  state: OrderLineState,
): HoldLineClassification {
  if (isPlaceholderSku(line.remoteSku)) {
    return {
      committable: false,
      line,
      reason: "placeholder_sku_detected",
      identityMatchId: null,
      availableStockAtEval: null,
    };
  }

  if (state.alias !== null) {
    const available = state.warehouseAvailable;
    if (typeof available === "number" && available > 0) {
      return {
        committable: true,
        line,
        aliasId: state.alias.id,
        variantId: state.alias.variantId,
        availableStockAtEval: available,
      };
    }
    return {
      committable: false,
      line,
      reason: "non_warehouse_sku",
      identityMatchId: null,
      availableStockAtEval: typeof available === "number" ? available : null,
    };
  }

  const ambiguousReason: HoldReason =
    state.identityMatch !== null ? "identity_only_match" : "unmapped_sku";
  const identityMatchId = state.identityMatch?.id ?? null;

  const fetchStatus = state.latestFetchStatus;
  if (fetchStatus !== null && fetchStatus !== "ok") {
    return {
      committable: false,
      line,
      reason: "fetch_incomplete_at_match",
      identityMatchId,
      availableStockAtEval: null,
    };
  }

  return {
    committable: false,
    line,
    reason: ambiguousReason,
    identityMatchId,
    availableStockAtEval: null,
  };
}

/**
 * The hold decision for an entire normalized order.
 *
 *   - `shouldHold`: true IFF at least one line is non-committable.
 *   - `holdReason`: the primary reason, chosen by HOLD_REASON_PRIORITY
 *     across all non-committable lines. Null iff `shouldHold=false`.
 *   - `affectedLines`: every non-committable line with its per-line
 *     reason. Empty iff `shouldHold=false`.
 *   - `committableLines`: every committable line. Callers must write
 *     `inventory_commitments` rows for these in the same transaction
 *     as the hold stamp (plan §1955).
 *   - `clientAlertRequired`: true IFF ANY non-committable line's
 *     audience is `clientAlert` (non_warehouse_sku, unmapped_sku,
 *     placeholder_sku_detected). The alert task key-off's
 *     `fulfillment_hold_cycle_id` for idempotency.
 *   - `staffReviewRequired`: true IFF ANY non-committable line's
 *     audience is `staffReview` (identity_only_match,
 *     fetch_incomplete_at_match). An operator may need to intervene
 *     or the recovery task needs to catch up.
 */
export interface HoldDecision {
  readonly shouldHold: boolean;
  readonly holdReason: HoldReason | null;
  readonly affectedLines: ReadonlyArray<HoldLineClassification & { committable: false }>;
  readonly committableLines: ReadonlyArray<HoldLineClassification & { committable: true }>;
  readonly clientAlertRequired: boolean;
  readonly staffReviewRequired: boolean;
}

export function decideOrderHold(
  classifications: ReadonlyArray<HoldLineClassification>,
): HoldDecision {
  const affected: Array<HoldLineClassification & { committable: false }> = [];
  const committable: Array<HoldLineClassification & { committable: true }> = [];
  for (const c of classifications) {
    if (c.committable) committable.push(c);
    else affected.push(c);
  }

  if (affected.length === 0) {
    return {
      shouldHold: false,
      holdReason: null,
      affectedLines: [],
      committableLines: committable,
      clientAlertRequired: false,
      staffReviewRequired: false,
    };
  }

  let primary: HoldReason = affected[0].reason;
  let primaryPriority = HOLD_REASON_PRIORITY[primary];
  let clientAlertRequired = false;
  let staffReviewRequired = false;
  for (const a of affected) {
    const p = HOLD_REASON_PRIORITY[a.reason];
    if (p < primaryPriority) {
      primary = a.reason;
      primaryPriority = p;
    }
    if (HOLD_REASON_AUDIENCE[a.reason] === "clientAlert") clientAlertRequired = true;
    if (HOLD_REASON_AUDIENCE[a.reason] === "staffReview") staffReviewRequired = true;
  }

  return {
    shouldHold: true,
    holdReason: primary,
    affectedLines: affected,
    committableLines: committable,
    clientAlertRequired,
    staffReviewRequired,
  };
}

/**
 * Convenience helper for callers that have already classified every
 * line. Equivalent to `decideOrderHold(classifications)` plus a
 * debug-payload carrying the normalized order's identity (useful for
 * structured logs).
 *
 * The evaluator orchestrator in `order-hold-evaluator.ts` typically
 * calls this; direct callers (e.g. a dry-run pipeline) can too.
 */
export function buildHoldDecision(args: {
  order: NormalizedClientStoreOrder;
  classifications: ReadonlyArray<HoldLineClassification>;
}): HoldDecision & { orderId: string | null; connectionId: string; source: string } {
  const decision = decideOrderHold(args.classifications);
  return {
    ...decision,
    orderId: args.order.warehouseOrderId,
    connectionId: args.order.connectionId,
    source: args.order.source,
  };
}
