/**
 * Phase 7 — pure autonomous-matching telemetry summarizer.
 *
 * This module is deliberately I/O-free: it takes pre-fetched rows from
 * `sku_autonomous_runs` / `sku_outcome_transitions` /
 * `order_fulfillment_hold_events` / `sku_autonomous_decisions` and
 * returns a typed rollup with the Phase 7 "Critical success criteria"
 * (plan §"Critical success criteria") evaluated against hard thresholds.
 *
 * The Trigger task at `src/trigger/tasks/sku-autonomous-telemetry.ts`
 * owns the batch reads and the `sensor_readings` + `warehouse_review_queue`
 * writes; this helper owns the math and the threshold contract.
 *
 * Every threshold below is load-bearing for Phase 7 rollout safety.
 * Do NOT soften a threshold without an updated plan revision + a new
 * release gate.
 */

// ───────────────────────────────────────────────────────────────────────────
// Input row shapes — narrow, explicit, and only include columns the
// summarizer actually reads. Looser shapes would invite accidental
// coupling to schema additions that aren't semantically part of the
// rollup.
// ───────────────────────────────────────────────────────────────────────────

export interface AutonomousRunRow {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  dry_run: boolean;
  started_at: string;
  completed_at: string | null;
  variants_evaluated: number | null;
  trigger_source: string;
}

export interface AutonomousDecisionRow {
  run_id: string;
  outcome_state: string;
  outcome_changed: boolean;
}

export interface OutcomeTransitionRow {
  from_state: string | null;
  to_state: string;
  trigger: string;
  reason_code: string | null;
  triggered_at: string;
}

export interface HoldEventRow {
  event_type:
    | "hold_applied"
    | "hold_released"
    | "hold_cancelled"
    | "hold_alert_sent"
    | "hold_alert_resent";
  hold_cycle_id: string;
  created_at: string;
  resolution_code: string | null;
}

export interface IdentityMatchCounts {
  /** Count of rows where `outcome_state = 'auto_database_identity_match'` and `is_active=true`. */
  shadow_candidates: number;
  /** Count of rows where `outcome_state = 'client_stock_exception'` (live alias demoted). */
  stock_exception: number;
  /** Count of rows where `outcome_state = 'auto_holdout_for_evidence'` (pending give-up). */
  holdout: number;
}

export interface TelemetryInput {
  windowDays: number;
  runs: AutonomousRunRow[];
  decisions: AutonomousDecisionRow[];
  transitions: OutcomeTransitionRow[];
  holdEvents: HoldEventRow[];
  identityCounts: IdentityMatchCounts;
}

// ───────────────────────────────────────────────────────────────────────────
// Thresholds — mirrored in the test suite so changing one without
// touching the other is an immediate red build.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Phase 7 alert thresholds per plan §"Critical success criteria"
 * (2026-04-26 revision). Each threshold here maps to exactly one row
 * in `TelemetryReasonCode` below.
 */
export const TELEMETRY_THRESHOLDS = {
  /**
   * Live alias false-positive rate — proxied by demotion-to-exception
   * over the window divided by the current live-alias pool size
   * (approximated by `stock_exception + promoted-in-window`). Alert
   * above 2% per plan.
   */
  max_demotion_rate: 0.02,
  /**
   * Hold-then-released band. Holds released in the same window as the
   * ones applied should fall in [60%, 80%]. Much lower implies false
   * holds are piling up; much higher implies hold thresholds are noisy.
   */
  min_hold_released_rate: 0.6,
  max_hold_released_rate: 0.8,
  /**
   * Weekly client alert volume. `hold_alert_sent + hold_alert_resent`
   * over the window.
   */
  max_client_alerts_per_week: 20,
  /**
   * Shadow-to-live promotion rate (per month). We compute this over the
   * window and scale to a 30-day equivalent. Too low = stuck backlog;
   * too high = unsafe promotion.
   */
  min_promotion_rate_monthly: 0.1,
  max_promotion_rate_monthly: 0.3,
  /**
   * Decision audit completeness. Every `completed` run should have at
   * least one `sku_autonomous_decisions` row. A lower rate means we're
   * losing audit coverage — a SKU-AUTO rollout blocker.
   */
  min_decision_audit_completeness: 1.0,
  /**
   * Run failure rate. `failed + cancelled` over `completed + failed +
   * cancelled` — `running` rows are excluded because they're in flight.
   */
  max_run_failure_rate: 0.1,
} as const;

/**
 * Every threshold trip reports back a typed reason code. The Trigger
 * task uses these codes to decide review-queue severity, and the test
 * suite enumerates them to prevent silent threshold additions.
 */
export const TELEMETRY_REASON_CODES = [
  "demotion_rate_above_threshold",
  "hold_released_rate_below_band",
  "hold_released_rate_above_band",
  "client_alerts_above_threshold",
  "promotion_rate_below_band",
  "promotion_rate_above_band",
  "decision_audit_incomplete",
  "run_failure_rate_above_threshold",
] as const;

export type TelemetryReasonCode = (typeof TELEMETRY_REASON_CODES)[number];

// ───────────────────────────────────────────────────────────────────────────
// Output shape
// ───────────────────────────────────────────────────────────────────────────

export interface TelemetrySummary {
  windowDays: number;

  // Run health
  runsTotal: number;
  runsCompleted: number;
  runsFailed: number;
  runsCancelled: number;
  runsRunning: number;
  runFailureRate: number | null;

  // Decision audit completeness (completed non-dry-run runs that have
  // at least one decision row)
  completedRunsWithDecisions: number;
  completedRunsExpected: number;
  decisionAuditCompleteness: number | null;
  decisionsTotal: number;
  decisionsOutcomeChanged: number;

  // Promotion / demotion / give-up (read from sku_outcome_transitions)
  promotionsInWindow: number;
  demotionsInWindow: number;
  giveUpsInWindow: number;
  shadowCandidatesCurrent: number;
  promotionRateMonthly: number | null;
  demotionRate: number | null;

  // Holds (read from order_fulfillment_hold_events)
  holdsAppliedCycles: number;
  holdsReleasedCycles: number;
  holdsCancelledCycles: number;
  holdReleasedRate: number | null;
  clientAlertsSent: number;

  // Roll-up
  reasons: TelemetryReasonCode[];
  status: "healthy" | "warning";
}

// ───────────────────────────────────────────────────────────────────────────
// Summarizer
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute the Phase 7 rollout telemetry rollup for a single workspace
 * over a trailing window. Callers are responsible for pre-filtering
 * rows to the window (by `started_at` / `triggered_at` / `created_at`
 * >= now - windowDays). The summarizer trusts the caller on window
 * scope — it cares about semantics, not freshness.
 */
export function summarizeAutonomousTelemetry(input: TelemetryInput): TelemetrySummary {
  const { windowDays, runs, decisions, transitions, holdEvents, identityCounts } = input;

  // ── Run health ────────────────────────────────────────────────────────
  const runsTotal = runs.length;
  const runsByStatus = countBy(runs, (r) => r.status);
  const runsCompleted = runsByStatus.get("completed") ?? 0;
  const runsFailed = runsByStatus.get("failed") ?? 0;
  const runsCancelled = runsByStatus.get("cancelled") ?? 0;
  const runsRunning = runsByStatus.get("running") ?? 0;
  const terminalRuns = runsCompleted + runsFailed + runsCancelled;
  const runFailureRate =
    terminalRuns > 0 ? (runsFailed + runsCancelled) / terminalRuns : null;

  // ── Decision audit completeness ───────────────────────────────────────
  // Only count non-dry-run runs that reached `completed`. Dry-run passes
  // deliberately write fewer decisions (plan §"Phase 1 dry-run"); counting
  // them would dilute the metric.
  const runIdsWithDecisions = new Set(decisions.map((d) => d.run_id));
  const expectedRuns = runs.filter((r) => r.status === "completed" && r.dry_run === false);
  const completedRunsWithDecisions = expectedRuns.filter((r) =>
    runIdsWithDecisions.has(r.id),
  ).length;
  const completedRunsExpected = expectedRuns.length;
  const decisionAuditCompleteness =
    completedRunsExpected > 0 ? completedRunsWithDecisions / completedRunsExpected : null;
  const decisionsTotal = decisions.length;
  const decisionsOutcomeChanged = decisions.filter((d) => d.outcome_changed === true).length;

  // ── Transitions ───────────────────────────────────────────────────────
  const promotionsInWindow = transitions.filter((t) => t.to_state === "auto_live_inventory_alias").length;
  const demotionsInWindow = transitions.filter(
    (t) => t.from_state === "auto_live_inventory_alias" && t.to_state === "client_stock_exception",
  ).length;
  const giveUpsInWindow = transitions.filter(
    (t) => t.from_state === "auto_holdout_for_evidence" && t.to_state === "auto_reject_non_match",
  ).length;

  // Promotion rate is monthly-scaled. We measure over `windowDays` and
  // project to a 30-day equivalent. Denominator is the current shadow
  // pool — candidates that WOULD have been eligible for promotion in
  // this window. If there are zero shadow candidates the rate is null
  // (no divisor, no signal).
  const shadowCandidatesCurrent = identityCounts.shadow_candidates;
  const promotionRateMonthly =
    shadowCandidatesCurrent > 0 && windowDays > 0
      ? (promotionsInWindow / shadowCandidatesCurrent) * (30 / windowDays)
      : null;

  // Demotion rate is unscaled. Denominator is the current "live alias
  // pool" proxy — known live aliases (stock_exception rows had been
  // live at some point, so they're part of the lifetime pool) plus the
  // promotions that happened in this window. This is the same proxy
  // the plan uses.
  const aliasPoolProxy = identityCounts.stock_exception + promotionsInWindow;
  const demotionRate = aliasPoolProxy > 0 ? demotionsInWindow / aliasPoolProxy : null;

  // ── Holds ─────────────────────────────────────────────────────────────
  // "Hold cycles" are keyed by `hold_cycle_id`. A cycle is considered
  // applied/released/cancelled if ANY event of that type exists for
  // the cycle. This bubbles up operator actions correctly (a cycle
  // released, then re-applied, then released again is two cycles).
  const appliedCycles = distinct(
    holdEvents.filter((e) => e.event_type === "hold_applied").map((e) => e.hold_cycle_id),
  );
  const releasedCycles = distinct(
    holdEvents.filter((e) => e.event_type === "hold_released").map((e) => e.hold_cycle_id),
  );
  const cancelledCycles = distinct(
    holdEvents.filter((e) => e.event_type === "hold_cancelled").map((e) => e.hold_cycle_id),
  );

  const holdsAppliedCycles = appliedCycles.size;
  const holdsReleasedCycles = releasedCycles.size;
  const holdsCancelledCycles = cancelledCycles.size;

  // Hold-released rate denominator is applied-in-window (the cycles
  // whose fate we can measure). A cycle that was released in the
  // window but applied BEFORE the window is excluded by the numerator
  // filter `appliedCycles.has(cycleId)` — we only credit releases
  // against cycles that opened in this window.
  const releasedOfAppliedInWindow = distinct(
    holdEvents
      .filter((e) => e.event_type === "hold_released" && appliedCycles.has(e.hold_cycle_id))
      .map((e) => e.hold_cycle_id),
  );
  const holdReleasedRate =
    holdsAppliedCycles > 0 ? releasedOfAppliedInWindow.size / holdsAppliedCycles : null;

  const clientAlertsSent = holdEvents.filter(
    (e) => e.event_type === "hold_alert_sent" || e.event_type === "hold_alert_resent",
  ).length;

  // ── Reason roll-up ────────────────────────────────────────────────────
  const reasons: TelemetryReasonCode[] = [];

  if (demotionRate !== null && demotionRate > TELEMETRY_THRESHOLDS.max_demotion_rate) {
    reasons.push("demotion_rate_above_threshold");
  }

  if (holdReleasedRate !== null) {
    if (holdReleasedRate < TELEMETRY_THRESHOLDS.min_hold_released_rate) {
      reasons.push("hold_released_rate_below_band");
    } else if (holdReleasedRate > TELEMETRY_THRESHOLDS.max_hold_released_rate) {
      reasons.push("hold_released_rate_above_band");
    }
  }

  // `max_client_alerts_per_week` is defined per week. Scale the window
  // observation back to a weekly equivalent before comparing.
  if (windowDays > 0) {
    const weeklyAlerts = (clientAlertsSent / windowDays) * 7;
    if (weeklyAlerts > TELEMETRY_THRESHOLDS.max_client_alerts_per_week) {
      reasons.push("client_alerts_above_threshold");
    }
  }

  if (promotionRateMonthly !== null) {
    if (promotionRateMonthly < TELEMETRY_THRESHOLDS.min_promotion_rate_monthly) {
      reasons.push("promotion_rate_below_band");
    } else if (promotionRateMonthly > TELEMETRY_THRESHOLDS.max_promotion_rate_monthly) {
      reasons.push("promotion_rate_above_band");
    }
  }

  if (
    decisionAuditCompleteness !== null &&
    decisionAuditCompleteness < TELEMETRY_THRESHOLDS.min_decision_audit_completeness
  ) {
    reasons.push("decision_audit_incomplete");
  }

  if (
    runFailureRate !== null &&
    runFailureRate > TELEMETRY_THRESHOLDS.max_run_failure_rate
  ) {
    reasons.push("run_failure_rate_above_threshold");
  }

  return {
    windowDays,
    runsTotal,
    runsCompleted,
    runsFailed,
    runsCancelled,
    runsRunning,
    runFailureRate,
    completedRunsWithDecisions,
    completedRunsExpected,
    decisionAuditCompleteness,
    decisionsTotal,
    decisionsOutcomeChanged,
    promotionsInWindow,
    demotionsInWindow,
    giveUpsInWindow,
    shadowCandidatesCurrent,
    promotionRateMonthly,
    demotionRate,
    holdsAppliedCycles,
    holdsReleasedCycles,
    holdsCancelledCycles,
    holdReleasedRate,
    clientAlertsSent,
    reasons,
    status: reasons.length > 0 ? "warning" : "healthy",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

function countBy<T, K>(items: T[], key: (t: T) => K): Map<K, number> {
  const map = new Map<K, number>();
  for (const item of items) {
    const k = key(item);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

function distinct<T>(values: T[]): Set<T> {
  return new Set(values);
}
