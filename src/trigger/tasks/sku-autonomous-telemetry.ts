/**
 * Autonomous SKU matcher — Phase 7.B: sku-autonomous-telemetry
 * weekly-per-workspace sensor runner.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Critical success criteria" (Phase 7 rollout safety gates)
 *       §"Phased rollout + flags" (Phase 7 entry preconditions)
 *       Rule #58 (one truth per concern — thresholds live in the
 *         pure summarizer, NOT scattered across orchestrators)
 *       SKU-AUTO emergency-pause contract.
 *
 * What this task does
 * ────────────────────
 * Once a week (Monday 08:00 UTC) per workspace:
 *
 *   1. Consult the `sku_autonomous_emergency_paused` kill switch
 *      (fail-closed: a DB read error is treated as paused).
 *   2. Fetch the last 30 days of:
 *        • `sku_autonomous_runs`
 *        • `sku_autonomous_decisions` (scoped to the fetched run
 *          ids to avoid ever loading unrelated workspace rows).
 *        • `sku_outcome_transitions`
 *        • `order_fulfillment_hold_events`
 *      plus a point-in-time identity-match outcome breakdown used
 *      as the denominator proxies by the summarizer (shadow pool
 *      and alias pool).
 *   3. Call the pure `summarizeAutonomousTelemetry()` helper
 *      (src/lib/server/sku-autonomous-telemetry.ts — owner of the
 *      threshold contract). The helper returns a rollup with zero
 *      or more `TelemetryReasonCode` entries; the orchestrator owns
 *      IO but NEVER re-evaluates thresholds.
 *   4. Insert ONE `sensor_readings` row with
 *      `sensor_name = 'sku_autonomous.telemetry'`, echoing the full
 *      rollup in the `value` column. Status is `warning` iff the
 *      summarizer reported at least one reason code, else `healthy`.
 *   5. For each reason code, UPSERT a `warehouse_review_queue` item
 *      keyed by `group_key = 'sku-autonomous-telemetry:{reason}:
 *      {workspaceId}:{ISO-week}'`. The ISO-week bucket means a
 *      repeated reason in the SAME week is idempotent (re-triggering
 *      the task or Trigger.dev double-delivery → occurrence_count
 *      increments), but each new ISO week creates a FRESH item so
 *      operators are re-pinged weekly if the condition persists.
 *      This is intentional: unlike `megaplan-spot-check` (which
 *      wants two-consecutive-runs persistence to suppress noisy
 *      per-SKU transient drift), the telemetry reason codes here
 *      are aggregate signals that already carry a 30-day smoothing
 *      window, so a trip is always actionable.
 *   6. If the workspace is emergency-paused: STILL write the
 *      `sensor_readings` row (observability during remediation is
 *      non-negotiable) but SKIP the review-queue upserts (ops
 *      already paused the system; they don't need to be told the
 *      metrics look bad). The paused state is echoed in the sensor
 *      value so the weekly graph clearly shows a gap-then-recovery
 *      shape rather than a silent run-failure.
 *
 * Emergency-pause vs observability
 * ────────────────────────────────
 * Per the SKU-AUTO emergency-pause contract (`workspace-flags.ts`
 * §readWorkspaceEmergencyPause), autonomous Trigger tasks must skip
 * "ANY autonomous side effect" when paused. `sensor_readings` and
 * `warehouse_review_queue` are observability, not side effects —
 * but a review-queue item saying "demotion rate above threshold"
 * during a pause is noise, not signal (the operator already knows
 * something is wrong; they paused the system). So we narrow the
 * pause impact to review-queue writes only.
 *
 * Queue policy
 * ────────────
 * Not pinned to any external-API queue — this task reads Postgres
 * only and writes Postgres only. Default Trigger queue is fine.
 *
 * Idempotency
 * ───────────
 * Sensor_readings are append-only time-series rows; a duplicate
 * delivery just produces two rows with different `created_at` and
 * the same `value`. The review-queue upserts are idempotent inside
 * an ISO week via `group_key` UNIQUE + `onConflict: group_key` with
 * `ignoreDuplicates: false` (so the `occurrence_count` increments).
 *
 * Cancellation
 * ────────────
 * No mid-run cancellation token — the task is bounded work (a
 * handful of reads per workspace). Worst case a new run starts while
 * an old one is finishing; both write their sensor_readings (not
 * harmful) and both race to upsert the same group_keys (Postgres
 * resolves the race, occurrence_count increments correctly).
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import {
  type AutonomousDecisionRow,
  type AutonomousRunRow,
  type HoldEventRow,
  type IdentityMatchCounts,
  type OutcomeTransitionRow,
  summarizeAutonomousTelemetry,
  TELEMETRY_REASON_CODES,
  type TelemetryReasonCode,
  type TelemetrySummary,
} from "@/lib/server/sku-autonomous-telemetry";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  type EmergencyPauseSupabaseClient,
  readWorkspaceEmergencyPause,
} from "@/lib/server/workspace-flags";

/**
 * Window length in days. 30 days gives a stable signal for every
 * threshold in the summarizer:
 *  - rate-based thresholds (demotion, promotion, run failure) need
 *    enough events to be non-noisy.
 *  - per-week thresholds (client alerts) are scaled inside the
 *    summarizer regardless of windowDays.
 *  - per-month thresholds (promotion rate) are scaled to a 30-day
 *    equivalent inside the summarizer.
 * A 30-day window plus a weekly cadence means a tripped reason
 * persists for up to 4 weeks before the bad data rolls off, which
 * is what we want — operators shouldn't be able to ignore a signal
 * that's still true.
 */
const WINDOW_DAYS = 30;

/**
 * Per-workspace row caps. If we ever hit these, the task logs a
 * warning and emits a `truncated` flag in the sensor value so ops
 * know the threshold evaluation was done on partial data. None of
 * these caps are expected to trip for a healthy workspace at the
 * volumes seen in the Phase 7 canary.
 */
const RUNS_LIMIT = 5_000;
const TRANSITIONS_LIMIT = 10_000;
const HOLD_EVENTS_LIMIT = 10_000;
/** Per-page size when paginating decisions. */
const DECISIONS_PAGE_SIZE = 1_000;
/** Hard ceiling on total decision rows per workspace to prevent runaway reads. */
const DECISIONS_TOTAL_LIMIT = 50_000;

type TelemetrySupabaseClient = ReturnType<typeof createServiceRoleClient>;

// ─────────────────────────────────────────────────────────────────────
// Public surface — exported for the test suite.
// ─────────────────────────────────────────────────────────────────────

export interface RunSkuAutonomousTelemetryOptions {
  supabase?: TelemetrySupabaseClient;
  now?: Date;
  /**
   * Optional window override — the default is {@link WINDOW_DAYS}.
   * Exposed so tests can exercise shorter windows and so an admin
   * one-off can reframe the rollup at diagnosis time.
   */
  windowDays?: number;
  /**
   * Optional workspace filter — when provided, only these workspace
   * ids are evaluated. Used by the manual trigger variant from the
   * rollout page so operators can spot-check a single workspace
   * without running the full weekly pass.
   */
  workspaceIds?: string[];
}

export type WorkspaceTelemetryStatus =
  | "ok"
  | "emergency_paused"
  | "pause_read_failed"
  | "runs_read_failed"
  | "decisions_read_failed"
  | "transitions_read_failed"
  | "hold_events_read_failed"
  | "identity_counts_read_failed"
  | "sensor_write_failed";

export interface WorkspaceTelemetryResult {
  workspace_id: string;
  status: WorkspaceTelemetryStatus;
  reasons: TelemetryReasonCode[];
  sensor_status: "healthy" | "warning" | "paused" | null;
  review_items_upserted: number;
  truncated: {
    runs: boolean;
    decisions: boolean;
    transitions: boolean;
    hold_events: boolean;
  };
  detail?: string;
  rollup?: TelemetrySummary;
}

export interface SkuAutonomousTelemetryRunResult {
  started_at: string;
  window_days: number;
  workspaces_scanned: number;
  workspaces_ok: number;
  workspaces_emergency_paused: number;
  workspaces_errored: number;
  total_review_items_upserted: number;
  per_workspace: WorkspaceTelemetryResult[];
}

export async function runSkuAutonomousTelemetry(
  options: RunSkuAutonomousTelemetryOptions = {},
): Promise<SkuAutonomousTelemetryRunResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? WINDOW_DAYS;
  const windowStartIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const result: SkuAutonomousTelemetryRunResult = {
    started_at: now.toISOString(),
    window_days: windowDays,
    workspaces_scanned: 0,
    workspaces_ok: 0,
    workspaces_emergency_paused: 0,
    workspaces_errored: 0,
    total_review_items_upserted: 0,
    per_workspace: [],
  };

  const workspaceIds = await loadWorkspaceIds(supabase, options.workspaceIds);
  result.workspaces_scanned = workspaceIds.length;

  for (const workspaceId of workspaceIds) {
    const wr = await processWorkspace(supabase, workspaceId, now, windowStartIso, windowDays);
    result.per_workspace.push(wr);
    if (wr.status === "ok") {
      result.workspaces_ok += 1;
      result.total_review_items_upserted += wr.review_items_upserted;
    } else if (wr.status === "emergency_paused") {
      result.workspaces_emergency_paused += 1;
    } else {
      result.workspaces_errored += 1;
    }
  }

  logger.info("sku-autonomous-telemetry: pass complete", {
    window_days: windowDays,
    workspaces_scanned: result.workspaces_scanned,
    workspaces_ok: result.workspaces_ok,
    workspaces_emergency_paused: result.workspaces_emergency_paused,
    workspaces_errored: result.workspaces_errored,
    total_review_items_upserted: result.total_review_items_upserted,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Per-workspace orchestration
// ─────────────────────────────────────────────────────────────────────

async function processWorkspace(
  supabase: TelemetrySupabaseClient,
  workspaceId: string,
  now: Date,
  windowStartIso: string,
  windowDays: number,
): Promise<WorkspaceTelemetryResult> {
  const base: WorkspaceTelemetryResult = {
    workspace_id: workspaceId,
    status: "ok",
    reasons: [],
    sensor_status: null,
    review_items_upserted: 0,
    truncated: { runs: false, decisions: false, transitions: false, hold_events: false },
  };

  const pauseCheck = await readWorkspaceEmergencyPause(
    supabase as unknown as EmergencyPauseSupabaseClient,
    workspaceId,
  );
  if (pauseCheck.kind === "error") {
    logger.warn("sku-autonomous-telemetry: pause read failed; skipping", {
      workspace_id: workspaceId,
      detail: pauseCheck.detail,
    });
    return { ...base, status: "pause_read_failed", detail: pauseCheck.detail };
  }

  // Fetch inputs. Even under pause we fetch the rollup so the sensor
  // row stays observable; the pause just narrows what side effects
  // follow.
  const runsRes = await fetchRuns(supabase, workspaceId, windowStartIso);
  if (runsRes.kind === "error") {
    return { ...base, status: "runs_read_failed", detail: runsRes.detail };
  }
  const runs = runsRes.rows;
  base.truncated.runs = runsRes.truncated;

  const runIds = runs.map((r) => r.id);
  const decisionsRes = await fetchDecisions(supabase, workspaceId, runIds);
  if (decisionsRes.kind === "error") {
    return { ...base, status: "decisions_read_failed", detail: decisionsRes.detail };
  }
  const decisions = decisionsRes.rows;
  base.truncated.decisions = decisionsRes.truncated;

  const transitionsRes = await fetchTransitions(supabase, workspaceId, windowStartIso);
  if (transitionsRes.kind === "error") {
    return { ...base, status: "transitions_read_failed", detail: transitionsRes.detail };
  }
  const transitions = transitionsRes.rows;
  base.truncated.transitions = transitionsRes.truncated;

  const holdEventsRes = await fetchHoldEvents(supabase, workspaceId, windowStartIso);
  if (holdEventsRes.kind === "error") {
    return { ...base, status: "hold_events_read_failed", detail: holdEventsRes.detail };
  }
  const holdEvents = holdEventsRes.rows;
  base.truncated.hold_events = holdEventsRes.truncated;

  const identityCountsRes = await fetchIdentityCounts(supabase, workspaceId);
  if (identityCountsRes.kind === "error") {
    return { ...base, status: "identity_counts_read_failed", detail: identityCountsRes.detail };
  }
  const identityCounts = identityCountsRes.counts;

  const summary = summarizeAutonomousTelemetry({
    windowDays,
    runs,
    decisions,
    transitions,
    holdEvents,
    identityCounts,
  });
  base.reasons = [...summary.reasons];
  base.rollup = summary;

  // Always write the sensor row. `paused` overrides the summarizer
  // status when we're in the kill-switch corridor — ops reading the
  // sensor stream should clearly see the gap.
  const sensorStatus: "healthy" | "warning" | "paused" = pauseCheck.paused
    ? "paused"
    : summary.status;
  base.sensor_status = sensorStatus;

  const { error: sensorErr } = await supabase.from("sensor_readings").insert({
    workspace_id: workspaceId,
    sensor_name: "sku_autonomous.telemetry",
    status: sensorStatus,
    value: {
      window_days: windowDays,
      summary,
      emergency_paused: pauseCheck.paused,
      truncated: base.truncated,
      identity_counts: identityCounts,
    },
    message: buildSensorMessage(sensorStatus, summary, pauseCheck.paused),
  });
  if (sensorErr) {
    logger.warn("sku-autonomous-telemetry: sensor write failed (non-fatal)", {
      workspace_id: workspaceId,
      detail: sensorErr.message,
    });
    return { ...base, status: "sensor_write_failed", detail: sensorErr.message };
  }

  // Under pause we stop before touching the review queue.
  if (pauseCheck.paused) {
    return { ...base, status: "emergency_paused" };
  }

  if (summary.reasons.length > 0) {
    base.review_items_upserted = await upsertReviewItems(
      supabase,
      workspaceId,
      summary,
      now,
      windowDays,
    );
  }

  return base;
}

function buildSensorMessage(
  status: "healthy" | "warning" | "paused",
  summary: TelemetrySummary,
  paused: boolean,
): string {
  if (paused) {
    return `Autonomous matching emergency-paused; telemetry recorded over ${summary.windowDays}d window (reasons would be: ${summary.reasons.join(", ") || "none"})`;
  }
  if (status === "healthy") {
    return `Autonomous telemetry within thresholds over ${summary.windowDays}d window`;
  }
  return `Autonomous telemetry threshold trip(s): ${summary.reasons.join(", ")}`;
}

// ─────────────────────────────────────────────────────────────────────
// Review-queue upsert — one row per reason code, deduplicated per
// workspace per ISO week via `group_key` so the same week's re-runs
// merge but a new week re-alerts operators if the condition persists.
// ─────────────────────────────────────────────────────────────────────

async function upsertReviewItems(
  supabase: TelemetrySupabaseClient,
  workspaceId: string,
  summary: TelemetrySummary,
  now: Date,
  windowDays: number,
): Promise<number> {
  const weekBucket = isoWeekKey(now);
  let upserted = 0;
  for (const reason of summary.reasons) {
    const { error } = await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        category: "sku_autonomous_telemetry",
        severity: severityFor(reason),
        title: titleFor(reason),
        description: descriptionFor(reason, summary),
        metadata: {
          reason,
          window_days: windowDays,
          week_bucket: weekBucket,
          summary,
        },
        status: "open",
        group_key: `sku-autonomous-telemetry:${reason}:${workspaceId}:${weekBucket}`,
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: false },
    );
    if (error) {
      logger.warn("sku-autonomous-telemetry: review queue upsert failed (non-fatal)", {
        workspace_id: workspaceId,
        reason,
        detail: error.message,
      });
      continue;
    }
    upserted += 1;
  }
  return upserted;
}

function severityFor(reason: TelemetryReasonCode): "low" | "medium" | "high" | "critical" {
  // Severity policy:
  //  - `high`  : mislabel / audit / pipeline failure — blocks safe
  //             rollout widening even if only tripped once.
  //  - `medium`: tuning signals — need investigation but aren't
  //             SKU-AUTO rollout gate blockers by themselves.
  // We deliberately avoid `critical` here. The critical severity
  // tier is reserved for "halt the ramp right now" conditions
  // owned by `ramp-halt-criteria-sensor`; Phase 7 telemetry
  // escalates through that sensor, not directly.
  switch (reason) {
    case "demotion_rate_above_threshold":
    case "decision_audit_incomplete":
    case "run_failure_rate_above_threshold":
      return "high";
    case "hold_released_rate_below_band":
    case "hold_released_rate_above_band":
    case "client_alerts_above_threshold":
    case "promotion_rate_below_band":
    case "promotion_rate_above_band":
      return "medium";
    default: {
      // Exhaustiveness check — the unreachable `never` here fires at
      // compile time if TELEMETRY_REASON_CODES grows without updating
      // this switch (plus the test suite's enumeration lock).
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function titleFor(reason: TelemetryReasonCode): string {
  switch (reason) {
    case "demotion_rate_above_threshold":
      return "Autonomous SKU demotion rate above 2% threshold";
    case "hold_released_rate_below_band":
      return "Order-hold release rate below 60% band";
    case "hold_released_rate_above_band":
      return "Order-hold release rate above 80% band";
    case "client_alerts_above_threshold":
      return "Client hold-alert volume above 20/week";
    case "promotion_rate_below_band":
      return "Shadow-to-live promotion rate below 10%/month";
    case "promotion_rate_above_band":
      return "Shadow-to-live promotion rate above 30%/month";
    case "decision_audit_incomplete":
      return "Autonomous decision audit coverage below 100%";
    case "run_failure_rate_above_threshold":
      return "Autonomous run failure rate above 10%";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function descriptionFor(reason: TelemetryReasonCode, summary: TelemetrySummary): string {
  switch (reason) {
    case "demotion_rate_above_threshold":
      return `Demotion rate over trailing ${summary.windowDays}d is ${fmtPct(summary.demotionRate)} (threshold 2%). ${summary.demotionsInWindow} demotion(s) observed against an alias-pool proxy derived from stock_exception + in-window promotions. Investigate before widening SKU-AUTO rollout.`;
    case "hold_released_rate_below_band":
      return `${fmtPct(summary.holdReleasedRate)} of in-window order holds were released (band 60-80%). ${summary.holdsAppliedCycles} applied vs ${summary.holdsReleasedCycles} released. Low release rate suggests false holds are piling up.`;
    case "hold_released_rate_above_band":
      return `${fmtPct(summary.holdReleasedRate)} of in-window order holds were released (band 60-80%). High release rate suggests hold thresholds may be too sensitive — tune the fetch/evidence gates.`;
    case "client_alerts_above_threshold":
      return `${summary.clientAlertsSent} client hold-alerts sent over trailing ${summary.windowDays}d (threshold 20/week). Check for a catalog-outage storm or a sale that mis-classified.`;
    case "promotion_rate_below_band":
      return `Monthly-scaled promotion rate is ${fmtPct(summary.promotionRateMonthly)} (band 10-30%). ${summary.promotionsInWindow} promoted / ${summary.shadowCandidatesCurrent} shadow candidates. Low promotion rate means the backlog is stuck; investigate stock-stability gate and Path A/B gates.`;
    case "promotion_rate_above_band":
      return `Monthly-scaled promotion rate is ${fmtPct(summary.promotionRateMonthly)} (band 10-30%). Unusually high — verify the evidence gate hasn't silently weakened.`;
    case "decision_audit_incomplete":
      return `Audit coverage ${fmtPct(summary.decisionAuditCompleteness)} (${summary.completedRunsWithDecisions}/${summary.completedRunsExpected} completed non-dry-run runs have decisions). This is a SKU-AUTO rollout blocker — every autonomous run MUST emit at least one decision row.`;
    case "run_failure_rate_above_threshold":
      return `${summary.runsFailed} failed + ${summary.runsCancelled} cancelled out of ${summary.runsCompleted + summary.runsFailed + summary.runsCancelled} terminal runs (${fmtPct(summary.runFailureRate)}). Check Trigger.dev logs and sku_autonomous_runs.status details.`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function fmtPct(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

// ─────────────────────────────────────────────────────────────────────
// ISO week key — "YYYY-Www" per ISO-8601. Pure function (tested).
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the ISO-8601 week key ("YYYY-Www", zero-padded) for a
 * given date. Exported for the test suite; kept tiny and deps-free
 * so we don't pull in date-fns just for this.
 *
 * Rules: weeks are Monday-starting. The ISO week-year is whichever
 * year contains the Thursday of the week (so late-December and
 * early-January weeks may belong to a different numeric year than
 * the calendar date).
 */
export function isoWeekKey(now: Date): string {
  // Clone in UTC and snap to the Thursday of the ISO week the
  // date belongs to — that Thursday's calendar year is the ISO
  // week-year.
  const tmp = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7; // Sun=0→7, Mon=1, ..., Sat=6
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const year = tmp.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((tmp.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────
// Fetchers — each returns either rows+truncated or a typed error so
// the orchestrator can propagate a precise failure mode.
// ─────────────────────────────────────────────────────────────────────

async function loadWorkspaceIds(
  supabase: TelemetrySupabaseClient,
  filter: string[] | undefined,
): Promise<string[]> {
  if (filter !== undefined) {
    return [...new Set(filter.filter((id) => typeof id === "string" && id.length > 0))];
  }
  const { data, error } = await supabase.from("workspaces").select("id");
  if (error) {
    logger.error("sku-autonomous-telemetry: workspaces read failed", {
      detail: error.message,
    });
    return [];
  }
  return (data ?? []).map((w) => w.id as string).filter(Boolean);
}

type FetchResult<T> =
  | { kind: "ok"; rows: T[]; truncated: boolean }
  | { kind: "error"; detail: string };

async function fetchRuns(
  supabase: TelemetrySupabaseClient,
  workspaceId: string,
  windowStartIso: string,
): Promise<FetchResult<AutonomousRunRow>> {
  const { data, error } = await supabase
    .from("sku_autonomous_runs")
    .select("id, status, dry_run, started_at, completed_at, variants_evaluated, trigger_source")
    .eq("workspace_id", workspaceId)
    .gte("started_at", windowStartIso)
    .order("started_at", { ascending: true })
    .limit(RUNS_LIMIT);
  if (error) return { kind: "error", detail: error.message };
  const rows = (data ?? []).map((r) => ({
    id: r.id as string,
    status: r.status as AutonomousRunRow["status"],
    dry_run: r.dry_run === true,
    started_at: r.started_at as string,
    completed_at: (r.completed_at as string | null) ?? null,
    variants_evaluated: (r.variants_evaluated as number | null) ?? null,
    trigger_source: (r.trigger_source as string) ?? "",
  }));
  return { kind: "ok", rows, truncated: rows.length >= RUNS_LIMIT };
}

async function fetchDecisions(
  supabase: TelemetrySupabaseClient,
  workspaceId: string,
  runIds: string[],
): Promise<FetchResult<AutonomousDecisionRow>> {
  if (runIds.length === 0) return { kind: "ok", rows: [], truncated: false };

  // Paginate in case a few very-busy runs produced >1000 decisions.
  // The summarizer only semantically needs:
  //   (a) which run_ids have at least one decision row — enough to
  //       compute `decisionAuditCompleteness`;
  //   (b) `decisions.length` and `outcome_changed` counts, used for
  //       informational telemetry only (not threshold-gated).
  // So under truncation the audit-completeness is still correct as
  // long as we see at least one row per run that has any; the
  // `decisions_*` informational counters may undercount.
  const acc: AutonomousDecisionRow[] = [];
  let offset = 0;
  let truncated = false;
  while (offset < DECISIONS_TOTAL_LIMIT) {
    const { data, error } = await supabase
      .from("sku_autonomous_decisions")
      .select("run_id, outcome_state, outcome_changed")
      .eq("workspace_id", workspaceId)
      .in("run_id", runIds)
      .range(offset, offset + DECISIONS_PAGE_SIZE - 1);
    if (error) return { kind: "error", detail: error.message };
    const page = (data ?? []).map((r) => ({
      run_id: r.run_id as string,
      outcome_state: (r.outcome_state as string) ?? "",
      outcome_changed: r.outcome_changed === true,
    }));
    acc.push(...page);
    if (page.length < DECISIONS_PAGE_SIZE) break;
    offset += DECISIONS_PAGE_SIZE;
    if (acc.length >= DECISIONS_TOTAL_LIMIT) {
      truncated = true;
      break;
    }
  }
  return { kind: "ok", rows: acc, truncated };
}

async function fetchTransitions(
  supabase: TelemetrySupabaseClient,
  workspaceId: string,
  windowStartIso: string,
): Promise<FetchResult<OutcomeTransitionRow>> {
  const { data, error } = await supabase
    .from("sku_outcome_transitions")
    .select("from_state, to_state, trigger, reason_code, triggered_at")
    .eq("workspace_id", workspaceId)
    .gte("triggered_at", windowStartIso)
    .order("triggered_at", { ascending: true })
    .limit(TRANSITIONS_LIMIT);
  if (error) return { kind: "error", detail: error.message };
  const rows = (data ?? []).map((r) => ({
    from_state: (r.from_state as string | null) ?? null,
    to_state: r.to_state as string,
    trigger: (r.trigger as string) ?? "",
    reason_code: (r.reason_code as string | null) ?? null,
    triggered_at: r.triggered_at as string,
  }));
  return { kind: "ok", rows, truncated: rows.length >= TRANSITIONS_LIMIT };
}

async function fetchHoldEvents(
  supabase: TelemetrySupabaseClient,
  workspaceId: string,
  windowStartIso: string,
): Promise<FetchResult<HoldEventRow>> {
  const { data, error } = await supabase
    .from("order_fulfillment_hold_events")
    .select("event_type, hold_cycle_id, created_at, resolution_code")
    .eq("workspace_id", workspaceId)
    .gte("created_at", windowStartIso)
    .order("created_at", { ascending: true })
    .limit(HOLD_EVENTS_LIMIT);
  if (error) return { kind: "error", detail: error.message };
  const rows = (data ?? []).map((r) => ({
    event_type: r.event_type as HoldEventRow["event_type"],
    hold_cycle_id: r.hold_cycle_id as string,
    created_at: r.created_at as string,
    resolution_code: (r.resolution_code as string | null) ?? null,
  }));
  return { kind: "ok", rows, truncated: rows.length >= HOLD_EVENTS_LIMIT };
}

async function fetchIdentityCounts(
  supabase: TelemetrySupabaseClient,
  workspaceId: string,
): Promise<{ kind: "ok"; counts: IdentityMatchCounts } | { kind: "error"; detail: string }> {
  async function countByOutcome(
    outcomeState: string,
  ): Promise<{ count: number; error: string | null }> {
    const { count, error } = await supabase
      .from("client_store_product_identity_matches")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("outcome_state", outcomeState)
      .eq("is_active", true);
    if (error) return { count: 0, error: error.message };
    return { count: count ?? 0, error: null };
  }

  const [shadow, exception, holdout] = await Promise.all([
    countByOutcome("auto_database_identity_match"),
    countByOutcome("client_stock_exception"),
    countByOutcome("auto_holdout_for_evidence"),
  ]);
  const err = shadow.error ?? exception.error ?? holdout.error;
  if (err) return { kind: "error", detail: err };
  return {
    kind: "ok",
    counts: {
      shadow_candidates: shadow.count,
      stock_exception: exception.count,
      holdout: holdout.count,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scheduled + manual Trigger bindings. Monday 08:00 UTC puts the task
// before `sku-matching-monitor` (Monday 14:00 UTC) — so operators
// arriving at their Monday cockpit see BOTH weekly SKU signals
// populated.
// ─────────────────────────────────────────────────────────────────────

export const skuAutonomousTelemetryScheduledTask = schedules.task({
  id: "sku-autonomous-telemetry",
  cron: "0 8 * * 1",
  maxDuration: 900,
  run: async () => runSkuAutonomousTelemetry(),
});

export const skuAutonomousTelemetryManualTask = task({
  id: "sku-autonomous-telemetry-manual",
  maxDuration: 900,
  run: async (payload: { workspaceIds?: string[]; windowDays?: number }) =>
    runSkuAutonomousTelemetry({
      workspaceIds: payload?.workspaceIds,
      windowDays: payload?.windowDays,
    }),
});

// ─────────────────────────────────────────────────────────────────────
// Exhaustiveness self-check — forces a compile error if a reason is
// added to the summarizer's TELEMETRY_REASON_CODES without a
// corresponding severity+title+description mapping above.
// ─────────────────────────────────────────────────────────────────────

const _exhaustive: Record<TelemetryReasonCode, true> = Object.fromEntries(
  TELEMETRY_REASON_CODES.map((r) => [r, true]),
) as Record<TelemetryReasonCode, true>;
// Reference so the const isn't tree-shaken / unused. The
// `severityFor`/`titleFor`/`descriptionFor` switches also do
// compile-time exhaustiveness via `_exhaustive: never`; this
// constant just makes the runtime dependency explicit.
void _exhaustive;
