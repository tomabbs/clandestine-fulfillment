/**
 * Phase 6 (finish-line plan v4) — pure halt-criteria evaluator.
 *
 * Extracted from the `ramp-halt-criteria-sensor` Trigger task so the
 * threshold logic is unit-testable without spinning up Trigger or Supabase.
 *
 * Halt criteria (§31 of the mega-plan, refined by finish-line plan v4 §5.3):
 *
 *   H-1  inv.redis_postgres_drift = critical              → halt
 *   H-2  inv.propagation_lag      = critical              → halt
 *   H-3  spot-check drift_major   > 5% of sampled SKUs    → halt (two consecutive
 *                                                          runs persistence;
 *                                                          one-run flap = warn-only)
 *   H-4  shipstation v2 5xx rate  > 2% over 30 min        → halt + page
 *   H-5  webhook silence detected on any active store     → warn (do not halt
 *                                                          unless paired with H-1)
 *
 * Per finish-line v4 reviewer A §3:
 *   • Bucket flap on H-3 across a single eval window MUST NOT halt; require
 *     two consecutive runs of `drift_major > 5%` before halting.
 *
 * Per finish-line v4 reviewer A §6 (excludeStressArtifacts):
 *   • The CALLER is responsible for filtering stress-harness rows out of
 *     the readings/events the evaluator sees. The evaluator itself is pure.
 *
 * Per finish-line v4 reviewer B §3 (decoupling from Server Action):
 *   • The evaluator returns a recommended action (halt vs hold). The caller
 *     is the one that calls `setFanoutRolloutPercentInternal` if action=halt.
 */

export interface HaltEvaluatorReading {
  /** Lowercase canonical sensor name, e.g. `inv.redis_postgres_drift`. */
  sensorName: string;
  status: "healthy" | "warning" | "critical";
  /** Free-form metadata; some evaluators inspect specific keys (e.g. percent). */
  value?: Record<string, unknown>;
  /** ISO timestamp the reading was recorded. */
  ts: string;
}

export interface HaltEvaluatorInput {
  /** Readings within the activity window (caller filters by ts; default 1h). */
  recentReadings: HaltEvaluatorReading[];
  /**
   * Result of the prior evaluator run, used for §5.3 two-consecutive-runs
   * persistence on H-3. Pass `null` on first run.
   */
  priorRunSpotCheckTriggered?: boolean | null;
  /**
   * Caller-computed spot-check drift_major fraction (0..1) for THIS run,
   * sourced from `external_sync_events` or whichever source the spot-check
   * task writes to. `null` if no spot-check completed in the window.
   */
  spotCheckDriftMajorFraction?: number | null;
  /**
   * Caller-computed ShipStation v2 5xx rate (0..1) over the last 30 min.
   * `null` if no v2 traffic.
   */
  shipstationV2_5xxRate?: number | null;
}

export type HaltAction =
  | { kind: "hold"; reason: string }
  | { kind: "warn"; reason: string; sensors: string[] }
  | { kind: "halt"; reason: string; trippedCriteria: string[] }
  | { kind: "halt_and_page"; reason: string; trippedCriteria: string[] };

export interface HaltEvaluatorResult {
  action: HaltAction;
  /** Persist this back into the next run's `priorRunSpotCheckTriggered`. */
  spotCheckTrippedThisRun: boolean;
  /** Per-criterion findings for audit/log. */
  findings: Array<{
    id: "H-1" | "H-2" | "H-3" | "H-4" | "H-5";
    label: string;
    triggered: boolean;
    detail: string;
  }>;
}

const SPOT_CHECK_THRESHOLD = 0.05;
const V2_5XX_THRESHOLD = 0.02;

/**
 * Pure halt-criteria evaluator. Caller does I/O; this function does math.
 */
export function evaluateRampHaltCriteria(input: HaltEvaluatorInput): HaltEvaluatorResult {
  const findings: HaltEvaluatorResult["findings"] = [];
  const tripped: string[] = [];
  const warns: string[] = [];
  let pageOperator = false;

  const driftCritical = input.recentReadings.some(
    (r) => r.sensorName === "inv.redis_postgres_drift" && r.status === "critical",
  );
  findings.push({
    id: "H-1",
    label: "inv.redis_postgres_drift critical",
    triggered: driftCritical,
    detail: driftCritical ? "at least one critical reading in window" : "no critical readings",
  });
  if (driftCritical) tripped.push("H-1");

  const lagCritical = input.recentReadings.some(
    (r) => r.sensorName === "inv.propagation_lag" && r.status === "critical",
  );
  findings.push({
    id: "H-2",
    label: "inv.propagation_lag critical",
    triggered: lagCritical,
    detail: lagCritical ? "at least one critical reading in window" : "no critical readings",
  });
  if (lagCritical) tripped.push("H-2");

  const spotCheckOver =
    typeof input.spotCheckDriftMajorFraction === "number" &&
    input.spotCheckDriftMajorFraction > SPOT_CHECK_THRESHOLD;
  const spotCheckTrippedThisRun = spotCheckOver;
  const spotCheckTwoRuns = spotCheckOver && input.priorRunSpotCheckTriggered === true;
  findings.push({
    id: "H-3",
    label: "spot-check drift_major > 5%",
    triggered: spotCheckTwoRuns,
    detail: spotCheckOver
      ? input.priorRunSpotCheckTriggered === true
        ? `tripped twice in a row (this run: ${pct(input.spotCheckDriftMajorFraction)})`
        : `tripped this run only (${pct(input.spotCheckDriftMajorFraction)}) — waiting for second confirmation per §5.3`
      : input.spotCheckDriftMajorFraction === null ||
          input.spotCheckDriftMajorFraction === undefined
        ? "no spot-check data in window"
        : `within threshold (${pct(input.spotCheckDriftMajorFraction)})`,
  });
  if (spotCheckTwoRuns) tripped.push("H-3");
  else if (spotCheckOver) warns.push("H-3");

  const v2Over =
    typeof input.shipstationV2_5xxRate === "number" &&
    input.shipstationV2_5xxRate > V2_5XX_THRESHOLD;
  findings.push({
    id: "H-4",
    label: "shipstation v2 5xx > 2% (30m)",
    triggered: v2Over,
    detail: v2Over
      ? `5xx rate ${pct(input.shipstationV2_5xxRate)} > ${pct(V2_5XX_THRESHOLD)}`
      : input.shipstationV2_5xxRate === null || input.shipstationV2_5xxRate === undefined
        ? "no v2 traffic in window"
        : `within threshold (${pct(input.shipstationV2_5xxRate)})`,
  });
  if (v2Over) {
    tripped.push("H-4");
    pageOperator = true;
  }

  const webhookSilence = input.recentReadings.some(
    (r) => r.sensorName === "webhook.silence" && r.status !== "healthy",
  );
  findings.push({
    id: "H-5",
    label: "webhook.silence (warn-only unless paired with H-1)",
    triggered: false,
    detail: webhookSilence
      ? "webhook silence detected; warn-only unless paired with H-1"
      : "no webhook silence",
  });
  if (webhookSilence) warns.push("H-5");

  if (tripped.length === 0) {
    if (warns.length === 0) {
      return {
        action: { kind: "hold", reason: "all criteria within threshold" },
        spotCheckTrippedThisRun,
        findings,
      };
    }
    return {
      action: {
        kind: "warn",
        reason: `warn-only criteria tripped: ${warns.join(", ")}`,
        sensors: warns,
      },
      spotCheckTrippedThisRun,
      findings,
    };
  }

  return {
    action: pageOperator
      ? {
          kind: "halt_and_page",
          reason: `halt-criteria tripped: ${tripped.join(", ")}`,
          trippedCriteria: tripped,
        }
      : {
          kind: "halt",
          reason: `halt-criteria tripped: ${tripped.join(", ")}`,
          trippedCriteria: tripped,
        },
    spotCheckTrippedThisRun,
    findings,
  };
}

function pct(n: number | null | undefined): string {
  if (typeof n !== "number") return "n/a";
  return `${(n * 100).toFixed(2)}%`;
}
