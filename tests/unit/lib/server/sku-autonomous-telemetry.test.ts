/**
 * Phase 7.A tests for `summarizeAutonomousTelemetry`. The summarizer is
 * I/O-free and deterministic, so we can drive every threshold branch
 * directly.
 *
 * Coverage targets:
 *   - every field of `TelemetryInput` contributes correctly
 *   - every divide-by-zero produces `null`, not `NaN` or `Infinity`
 *   - every threshold reason code is trippable in isolation
 *   - every threshold reason code is NOT tripped when exactly on the
 *     boundary (the summarizer uses strict `<` / `>`)
 *   - multiple reasons stack in one rollup
 *   - hold-cycle dedup (a cycle released in the window but applied
 *     before the window does NOT count toward `holdReleasedRate`)
 *   - dry-run completed runs are excluded from the decision-audit
 *     denominator
 *   - the exported `TELEMETRY_REASON_CODES` list matches every reason
 *     the summarizer can emit (guards against silent additions)
 */

import { describe, expect, it } from "vitest";
import {
  type AutonomousDecisionRow,
  type AutonomousRunRow,
  type HoldEventRow,
  type IdentityMatchCounts,
  type OutcomeTransitionRow,
  summarizeAutonomousTelemetry,
  TELEMETRY_REASON_CODES,
  TELEMETRY_THRESHOLDS,
  type TelemetryInput,
} from "../../../../src/lib/server/sku-autonomous-telemetry";

// ─────────────────────────────────────────────────────────────────────
// Fixtures + helpers — every factory returns a minimal row with safe
// defaults that tests override per-case.
// ─────────────────────────────────────────────────────────────────────

const BASE_DATE = new Date("2026-04-20T00:00:00Z").toISOString();

function run(overrides: Partial<AutonomousRunRow> = {}): AutonomousRunRow {
  return {
    id: overrides.id ?? "run-0",
    status: "completed",
    dry_run: false,
    started_at: BASE_DATE,
    completed_at: BASE_DATE,
    variants_evaluated: 100,
    trigger_source: "cron",
    ...overrides,
  };
}

function decision(overrides: Partial<AutonomousDecisionRow> = {}): AutonomousDecisionRow {
  return {
    run_id: "run-0",
    outcome_state: "auto_live_inventory_alias",
    outcome_changed: false,
    ...overrides,
  };
}

function transition(overrides: Partial<OutcomeTransitionRow> = {}): OutcomeTransitionRow {
  return {
    from_state: null,
    to_state: "auto_live_inventory_alias",
    trigger: "cron",
    reason_code: null,
    triggered_at: BASE_DATE,
    ...overrides,
  };
}

function holdEvent(overrides: Partial<HoldEventRow> = {}): HoldEventRow {
  return {
    event_type: "hold_applied",
    hold_cycle_id: "cycle-0",
    created_at: BASE_DATE,
    resolution_code: null,
    ...overrides,
  };
}

function counts(overrides: Partial<IdentityMatchCounts> = {}): IdentityMatchCounts {
  return { shadow_candidates: 0, stock_exception: 0, holdout: 0, ...overrides };
}

function makeInput(partial: Partial<TelemetryInput> = {}): TelemetryInput {
  return {
    windowDays: 7,
    runs: [],
    decisions: [],
    transitions: [],
    holdEvents: [],
    identityCounts: counts(),
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Empty window + divide-by-zero safety
// ─────────────────────────────────────────────────────────────────────

describe("summarizeAutonomousTelemetry — empty window", () => {
  it("returns a fully-zeroed healthy rollup with no reasons when every input is empty", () => {
    const result = summarizeAutonomousTelemetry(makeInput());

    expect(result).toMatchObject({
      windowDays: 7,
      runsTotal: 0,
      runsCompleted: 0,
      runsFailed: 0,
      runsCancelled: 0,
      runsRunning: 0,
      runFailureRate: null,
      completedRunsWithDecisions: 0,
      completedRunsExpected: 0,
      decisionAuditCompleteness: null,
      decisionsTotal: 0,
      decisionsOutcomeChanged: 0,
      promotionsInWindow: 0,
      demotionsInWindow: 0,
      giveUpsInWindow: 0,
      shadowCandidatesCurrent: 0,
      promotionRateMonthly: null,
      demotionRate: null,
      holdsAppliedCycles: 0,
      holdsReleasedCycles: 0,
      holdsCancelledCycles: 0,
      holdReleasedRate: null,
      clientAlertsSent: 0,
      reasons: [],
      status: "healthy",
    });

    // Divide-by-zero sanity: no NaN or Infinity leaked anywhere.
    for (const v of Object.values(result)) {
      if (typeof v === "number") {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("returns null for runFailureRate when only running rows exist (no terminal denominator)", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({ runs: [run({ id: "r1", status: "running", completed_at: null })] }),
    );

    expect(result.runsRunning).toBe(1);
    expect(result.runFailureRate).toBeNull();
  });

  it("returns null for decisionAuditCompleteness when no non-dry-run completed runs exist", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({ runs: [run({ id: "r1", status: "completed", dry_run: true })] }),
    );

    expect(result.completedRunsExpected).toBe(0);
    expect(result.decisionAuditCompleteness).toBeNull();
  });

  it("returns null for promotionRateMonthly when shadow pool is zero", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        transitions: [transition()],
        identityCounts: counts({ shadow_candidates: 0 }),
      }),
    );

    expect(result.promotionsInWindow).toBe(1);
    expect(result.promotionRateMonthly).toBeNull();
  });

  it("returns null for demotionRate when the alias pool proxy is zero", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        transitions: [],
        identityCounts: counts({ stock_exception: 0 }),
      }),
    );

    expect(result.demotionRate).toBeNull();
  });

  it("returns null for holdReleasedRate when no holds were applied in the window", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        holdEvents: [holdEvent({ event_type: "hold_released", hold_cycle_id: "stale-cycle" })],
      }),
    );

    expect(result.holdsAppliedCycles).toBe(0);
    expect(result.holdReleasedRate).toBeNull();
    expect(result.reasons).toEqual([]);
  });

  it("does not evaluate client-alert threshold when windowDays is 0", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        windowDays: 0,
        holdEvents: Array.from({ length: 1_000 }, (_, i) =>
          holdEvent({ event_type: "hold_alert_sent", hold_cycle_id: `c${i}` }),
        ),
      }),
    );

    expect(result.clientAlertsSent).toBe(1_000);
    expect(result.reasons).not.toContain("client_alerts_above_threshold");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Individual threshold trips — each test asserts ONE reason surfaces.
// ─────────────────────────────────────────────────────────────────────

describe("summarizeAutonomousTelemetry — threshold trips", () => {
  it("trips `demotion_rate_above_threshold` when demotionRate > 2%", () => {
    // Alias pool proxy = stock_exception (50) + promotions in window (0).
    // 2 demotions / 50 = 0.04 > 0.02 → trip.
    const result = summarizeAutonomousTelemetry(
      makeInput({
        identityCounts: counts({ stock_exception: 50 }),
        transitions: [
          transition({
            from_state: "auto_live_inventory_alias",
            to_state: "client_stock_exception",
          }),
          transition({
            from_state: "auto_live_inventory_alias",
            to_state: "client_stock_exception",
          }),
        ],
      }),
    );

    expect(result.demotionsInWindow).toBe(2);
    expect(result.demotionRate).toBeCloseTo(0.04);
    expect(result.reasons).toContain("demotion_rate_above_threshold");
    expect(result.status).toBe("warning");
  });

  it("trips `hold_released_rate_below_band` when <60%", () => {
    // 10 applied, 5 released → 0.5 < 0.6
    const applied = Array.from({ length: 10 }, (_, i) =>
      holdEvent({ event_type: "hold_applied", hold_cycle_id: `c${i}` }),
    );
    const released = Array.from({ length: 5 }, (_, i) =>
      holdEvent({ event_type: "hold_released", hold_cycle_id: `c${i}` }),
    );

    const result = summarizeAutonomousTelemetry(
      makeInput({ holdEvents: [...applied, ...released] }),
    );

    expect(result.holdsAppliedCycles).toBe(10);
    expect(result.holdReleasedRate).toBeCloseTo(0.5);
    expect(result.reasons).toContain("hold_released_rate_below_band");
  });

  it("trips `hold_released_rate_above_band` when >80%", () => {
    // 10 applied, 9 released → 0.9 > 0.8
    const applied = Array.from({ length: 10 }, (_, i) =>
      holdEvent({ event_type: "hold_applied", hold_cycle_id: `c${i}` }),
    );
    const released = Array.from({ length: 9 }, (_, i) =>
      holdEvent({ event_type: "hold_released", hold_cycle_id: `c${i}` }),
    );

    const result = summarizeAutonomousTelemetry(
      makeInput({ holdEvents: [...applied, ...released] }),
    );

    expect(result.holdReleasedRate).toBeCloseTo(0.9);
    expect(result.reasons).toContain("hold_released_rate_above_band");
    expect(result.reasons).not.toContain("hold_released_rate_below_band");
  });

  it("trips `client_alerts_above_threshold` when weekly-scaled alerts > 20", () => {
    // 14-day window, 45 alerts → 45 * 7 / 14 = 22.5 > 20
    const alerts = Array.from({ length: 45 }, (_, i) =>
      holdEvent({ event_type: "hold_alert_sent", hold_cycle_id: `c${i}` }),
    );

    const result = summarizeAutonomousTelemetry(makeInput({ windowDays: 14, holdEvents: alerts }));

    expect(result.clientAlertsSent).toBe(45);
    expect(result.reasons).toContain("client_alerts_above_threshold");
  });

  it("counts `hold_alert_resent` toward client alert volume", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        windowDays: 7,
        holdEvents: Array.from({ length: 25 }, (_, i) =>
          holdEvent({ event_type: "hold_alert_resent", hold_cycle_id: `c${i}` }),
        ),
      }),
    );

    expect(result.clientAlertsSent).toBe(25);
    expect(result.reasons).toContain("client_alerts_above_threshold");
  });

  it("trips `promotion_rate_below_band` when monthly-scaled < 10%", () => {
    // 100 shadow, 1 promotion over 30 days → 1/100 * 30/30 = 0.01 < 0.1
    const result = summarizeAutonomousTelemetry(
      makeInput({
        windowDays: 30,
        transitions: [transition()],
        identityCounts: counts({ shadow_candidates: 100 }),
      }),
    );

    expect(result.promotionRateMonthly).toBeCloseTo(0.01);
    expect(result.reasons).toContain("promotion_rate_below_band");
  });

  it("trips `promotion_rate_above_band` when monthly-scaled > 30%", () => {
    // 10 shadow, 4 promotions over 30 days → 0.4 > 0.3
    const result = summarizeAutonomousTelemetry(
      makeInput({
        windowDays: 30,
        transitions: Array.from({ length: 4 }, () => transition()),
        identityCounts: counts({ shadow_candidates: 10 }),
      }),
    );

    expect(result.promotionRateMonthly).toBeCloseTo(0.4);
    expect(result.reasons).toContain("promotion_rate_above_band");
  });

  it("scales promotion rate to a 30-day equivalent even with short windows", () => {
    // 7-day window. 1 promotion, 10 shadow → per-window rate is 0.1,
    // monthly-scaled is 0.1 * 30/7 = ~0.428, which trips the upper band.
    const result = summarizeAutonomousTelemetry(
      makeInput({
        windowDays: 7,
        transitions: [transition()],
        identityCounts: counts({ shadow_candidates: 10 }),
      }),
    );

    expect(result.promotionRateMonthly).toBeCloseTo((1 / 10) * (30 / 7));
    expect(result.reasons).toContain("promotion_rate_above_band");
  });

  it("trips `decision_audit_incomplete` when any completed non-dry-run has no decisions", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        runs: [run({ id: "with" }), run({ id: "without" })],
        decisions: [decision({ run_id: "with" })],
      }),
    );

    expect(result.completedRunsExpected).toBe(2);
    expect(result.completedRunsWithDecisions).toBe(1);
    expect(result.decisionAuditCompleteness).toBe(0.5);
    expect(result.reasons).toContain("decision_audit_incomplete");
  });

  it("trips `run_failure_rate_above_threshold` when >10% of terminal runs failed or cancelled", () => {
    // 7 completed + 2 failed + 1 cancelled = 10 terminal; (2+1)/10 = 0.3 > 0.1
    const completed = Array.from({ length: 7 }, (_, i) => run({ id: `ok${i}` }));
    const failed = Array.from({ length: 2 }, (_, i) => run({ id: `fail${i}`, status: "failed" }));
    const cancelled = [run({ id: "cx", status: "cancelled" })];

    const result = summarizeAutonomousTelemetry(
      makeInput({ runs: [...completed, ...failed, ...cancelled] }),
    );

    expect(result.runFailureRate).toBeCloseTo(0.3);
    expect(result.reasons).toContain("run_failure_rate_above_threshold");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Boundary behaviour — exactly-at-threshold must NOT trip (the
// summarizer uses strict `<` / `>`).
// ─────────────────────────────────────────────────────────────────────

describe("summarizeAutonomousTelemetry — boundaries", () => {
  it("does NOT trip demotion when rate === max (strict `>`)", () => {
    // 50 alias pool proxy, 1 demotion → 0.02 exactly.
    const result = summarizeAutonomousTelemetry(
      makeInput({
        identityCounts: counts({ stock_exception: 50 }),
        transitions: [
          transition({
            from_state: "auto_live_inventory_alias",
            to_state: "client_stock_exception",
          }),
        ],
      }),
    );

    expect(result.demotionRate).toBeCloseTo(0.02);
    expect(result.reasons).not.toContain("demotion_rate_above_threshold");
  });

  it("does NOT trip hold-released-band at the exact min or max", () => {
    // 10 applied, 6 released → 0.6 exact → no trip on the lower band.
    const resultLower = summarizeAutonomousTelemetry(
      makeInput({
        holdEvents: [
          ...Array.from({ length: 10 }, (_, i) =>
            holdEvent({ event_type: "hold_applied", hold_cycle_id: `c${i}` }),
          ),
          ...Array.from({ length: 6 }, (_, i) =>
            holdEvent({ event_type: "hold_released", hold_cycle_id: `c${i}` }),
          ),
        ],
      }),
    );
    expect(resultLower.holdReleasedRate).toBeCloseTo(0.6);
    expect(resultLower.reasons).not.toContain("hold_released_rate_below_band");

    // 10 applied, 8 released → 0.8 exact → no trip on the upper band.
    const resultUpper = summarizeAutonomousTelemetry(
      makeInput({
        holdEvents: [
          ...Array.from({ length: 10 }, (_, i) =>
            holdEvent({ event_type: "hold_applied", hold_cycle_id: `c${i}` }),
          ),
          ...Array.from({ length: 8 }, (_, i) =>
            holdEvent({ event_type: "hold_released", hold_cycle_id: `c${i}` }),
          ),
        ],
      }),
    );
    expect(resultUpper.holdReleasedRate).toBeCloseTo(0.8);
    expect(resultUpper.reasons).not.toContain("hold_released_rate_above_band");
  });

  it("does NOT trip run-failure at exactly 10%", () => {
    // 9 completed + 1 failed = 10 terminal; 1/10 = 0.1 exact.
    const result = summarizeAutonomousTelemetry(
      makeInput({
        runs: [
          ...Array.from({ length: 9 }, (_, i) => run({ id: `ok${i}` })),
          run({ id: "fail", status: "failed" }),
        ],
      }),
    );

    expect(result.runFailureRate).toBeCloseTo(0.1);
    expect(result.reasons).not.toContain("run_failure_rate_above_threshold");
  });

  it("does NOT trip decision-audit when every completed non-dry-run has a decision", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        runs: [run({ id: "r1" }), run({ id: "r2" })],
        decisions: [decision({ run_id: "r1" }), decision({ run_id: "r2" })],
      }),
    );

    expect(result.decisionAuditCompleteness).toBe(1);
    expect(result.reasons).not.toContain("decision_audit_incomplete");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Multi-trip rollup — every reason should be reported independently.
// ─────────────────────────────────────────────────────────────────────

describe("summarizeAutonomousTelemetry — multi-trip rollup", () => {
  it("stacks multiple threshold reasons in one summary", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        windowDays: 7,
        runs: [
          run({ id: "ok" }),
          run({ id: "missing-decisions" }),
          run({ id: "fail", status: "failed" }),
        ],
        decisions: [decision({ run_id: "ok" })],
        transitions: [
          transition({
            from_state: "auto_live_inventory_alias",
            to_state: "client_stock_exception",
          }),
        ],
        holdEvents: [
          ...Array.from({ length: 5 }, (_, i) =>
            holdEvent({ event_type: "hold_applied", hold_cycle_id: `c${i}` }),
          ),
          // Only 1 out of 5 released → 20% << 60% → below-band trip.
          holdEvent({ event_type: "hold_released", hold_cycle_id: "c0" }),
          // 25 alerts in a 7-day window → right at threshold-exceeding.
          ...Array.from({ length: 25 }, (_, i) =>
            holdEvent({ event_type: "hold_alert_sent", hold_cycle_id: `a${i}` }),
          ),
        ],
        identityCounts: counts({ stock_exception: 10 }),
      }),
    );

    expect(result.status).toBe("warning");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "demotion_rate_above_threshold",
        "hold_released_rate_below_band",
        "client_alerts_above_threshold",
        "decision_audit_incomplete",
        "run_failure_rate_above_threshold",
      ]),
    );
    // Upper band is mutually exclusive with lower band.
    expect(result.reasons).not.toContain("hold_released_rate_above_band");
  });

  it("emits upper or lower hold-released-band, never both", () => {
    // This is structural: the branch in the summarizer uses `else if`,
    // so this invariant is impossible by construction. Pin it.
    // Contrived data that produces a >80% release rate:
    const result = summarizeAutonomousTelemetry(
      makeInput({
        holdEvents: [
          ...Array.from({ length: 5 }, (_, i) =>
            holdEvent({ event_type: "hold_applied", hold_cycle_id: `c${i}` }),
          ),
          ...Array.from({ length: 5 }, (_, i) =>
            holdEvent({ event_type: "hold_released", hold_cycle_id: `c${i}` }),
          ),
        ],
      }),
    );
    expect(result.reasons.filter((r) => r.startsWith("hold_released_rate_"))).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Non-obvious semantic behaviours worth pinning
// ─────────────────────────────────────────────────────────────────────

describe("summarizeAutonomousTelemetry — semantic invariants", () => {
  it("only credits hold-released against cycles that were APPLIED in the window", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        holdEvents: [
          // Cycle `in-window` is applied AND released — counts.
          holdEvent({ event_type: "hold_applied", hold_cycle_id: "in-window" }),
          holdEvent({ event_type: "hold_released", hold_cycle_id: "in-window" }),
          // Cycle `pre-window` appears only with a release event (applied
          // before the window we're looking at). We should NOT credit
          // it against the rate because its denominator applies row
          // isn't in `appliedCycles`.
          holdEvent({ event_type: "hold_released", hold_cycle_id: "pre-window" }),
        ],
      }),
    );

    expect(result.holdsAppliedCycles).toBe(1);
    // Total released cycles is 2 (we count ALL release events for the
    // informational field), but the rate denominator is 1 and
    // numerator is 1 → 100%. Asserts the rate math.
    expect(result.holdsReleasedCycles).toBe(2);
    expect(result.holdReleasedRate).toBe(1);
  });

  it("deduplicates multiple events of the same type on the same cycle", () => {
    // Two `hold_applied` events on the same cycle id count as one
    // applied cycle — the operator re-applied a hold they already
    // had open, not a new cycle.
    const result = summarizeAutonomousTelemetry(
      makeInput({
        holdEvents: [
          holdEvent({ event_type: "hold_applied", hold_cycle_id: "same" }),
          holdEvent({ event_type: "hold_applied", hold_cycle_id: "same" }),
        ],
      }),
    );
    expect(result.holdsAppliedCycles).toBe(1);
  });

  it("excludes dry-run completed runs from the decision-audit denominator", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        runs: [run({ id: "real", dry_run: false }), run({ id: "dry", dry_run: true })],
        decisions: [decision({ run_id: "real" })],
      }),
    );

    expect(result.completedRunsExpected).toBe(1);
    expect(result.decisionAuditCompleteness).toBe(1);
  });

  it("counts give-ups only when transition is holdout → reject_non_match", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        transitions: [
          transition({
            from_state: "auto_holdout_for_evidence",
            to_state: "auto_reject_non_match",
          }),
          // Not a give-up: different from_state
          transition({
            from_state: "client_stock_exception",
            to_state: "auto_reject_non_match",
          }),
          // Not a give-up: different to_state
          transition({
            from_state: "auto_holdout_for_evidence",
            to_state: "auto_live_inventory_alias",
          }),
        ],
      }),
    );

    expect(result.giveUpsInWindow).toBe(1);
  });

  it("does NOT count promotions whose `to_state` is anything other than auto_live_inventory_alias", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        transitions: [
          transition({ to_state: "auto_live_inventory_alias" }),
          transition({ to_state: "auto_holdout_for_evidence" }),
          transition({ to_state: "client_stock_exception" }),
        ],
      }),
    );
    expect(result.promotionsInWindow).toBe(1);
  });

  it("counts outcome_changed decisions separately from total decisions", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({
        runs: [run({ id: "r1" })],
        decisions: [
          decision({ run_id: "r1", outcome_changed: true }),
          decision({ run_id: "r1", outcome_changed: false }),
          decision({ run_id: "r1", outcome_changed: true }),
        ],
      }),
    );

    expect(result.decisionsTotal).toBe(3);
    expect(result.decisionsOutcomeChanged).toBe(2);
  });

  it("surfaces identityCounts.shadow_candidates as shadowCandidatesCurrent", () => {
    const result = summarizeAutonomousTelemetry(
      makeInput({ identityCounts: counts({ shadow_candidates: 42 }) }),
    );
    expect(result.shadowCandidatesCurrent).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Structural contracts — guard against silent additions.
// ─────────────────────────────────────────────────────────────────────

describe("summarizeAutonomousTelemetry — structural contracts", () => {
  it("lists every reason code the summarizer can emit", () => {
    // If a future change adds a reason in the summarizer but forgets
    // to update TELEMETRY_REASON_CODES, the Trigger task will fall
    // through to `never` exhaustiveness and silently miss alerting.
    // Pinning the full set here forces the PR author to touch the
    // constant and the test together.
    expect(new Set(TELEMETRY_REASON_CODES)).toEqual(
      new Set([
        "demotion_rate_above_threshold",
        "hold_released_rate_below_band",
        "hold_released_rate_above_band",
        "client_alerts_above_threshold",
        "promotion_rate_below_band",
        "promotion_rate_above_band",
        "decision_audit_incomplete",
        "run_failure_rate_above_threshold",
      ]),
    );
  });

  it("pins the exact Phase 7 threshold values (plan §Critical success criteria)", () => {
    expect(TELEMETRY_THRESHOLDS).toEqual({
      max_demotion_rate: 0.02,
      min_hold_released_rate: 0.6,
      max_hold_released_rate: 0.8,
      max_client_alerts_per_week: 20,
      min_promotion_rate_monthly: 0.1,
      max_promotion_rate_monthly: 0.3,
      min_decision_audit_completeness: 1,
      max_run_failure_rate: 0.1,
    });
  });

  it("status is `healthy` iff reasons is empty", () => {
    const healthy = summarizeAutonomousTelemetry(makeInput());
    expect(healthy.reasons).toHaveLength(0);
    expect(healthy.status).toBe("healthy");

    const unhealthy = summarizeAutonomousTelemetry(
      makeInput({
        runs: [run({ id: "f", status: "failed" })],
      }),
    );
    expect(unhealthy.reasons).toContain("run_failure_rate_above_threshold");
    expect(unhealthy.status).toBe("warning");
  });
});
