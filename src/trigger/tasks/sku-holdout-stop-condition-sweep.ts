/**
 * Autonomous SKU matcher — Phase 5.D: sku-holdout-stop-condition-sweep
 * Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"sku-holdout-stop-condition-sweep" +
 *       §"Outcome state machine — terminal states" +
 *       SKU-AUTO-14 (state_version OCC) +
 *       SKU-AUTO-11 (reason_code required on every transition).
 *
 * Scope
 * ─────
 * Daily sweep that finds `client_store_product_identity_matches`
 * rows stuck in `auto_holdout_for_evidence` that meet either stop
 * condition and transitions them to the terminal
 * `auto_reject_non_match` state via `applyOutcomeTransition()` with
 * `trigger='periodic_revaluation'`.
 *
 * Stop conditions (ANY triggers retirement):
 *   1. `evaluation_count >= 10` — the evidence gate has had ten
 *      chances to find new signals and hasn't. Reason code:
 *      `holdout_expired_10_evaluations`.
 *   2. `age_days >= 90` — the row has existed for ≥90 days without
 *      ever escaping holdout. Reason code: `holdout_expired_90_days`.
 *
 * When BOTH are true we prefer the age-based reason code, because
 * age is the operator-visible heuristic in dashboards and the
 * 90-day rule is the harder rotation guarantee (you do NOT want
 * eternal holdouts regardless of evaluation count).
 *
 * Emergency pause (Rule SKU-AUTO-20)
 * ──────────────────────────────────
 * This task DOES write identity rows, so the per-workspace
 * emergency pause MUST block it. Pause read errors fail closed.
 *
 * Queue policy (Rule #9 / #60)
 * ────────────────────────────
 * Not pinned to `bandcamp-api`. The task calls Postgres only
 * (no outbound platform APIs).
 *
 * Idempotency
 * ───────────
 * `applyOutcomeTransition()` is OCC-guarded by `state_version` and
 * advisory-locked inside the RPC. A double delivery either:
 *   * races the advisory lock (one wins; the other returns
 *     `from_state_drift` because the row is now terminal); or
 *   * races the OCC check (one wins; the other returns
 *     `stale_state_version`).
 * Either way the row transitions exactly once.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger, schedules, task } from "@trigger.dev/sdk";
import {
  type ApplyOutcomeTransitionResult,
  applyOutcomeTransition,
  type RpcClient,
} from "@/lib/server/sku-outcome-transitions";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  type EmergencyPauseSupabaseClient,
  readWorkspaceEmergencyPause,
} from "@/lib/server/workspace-flags";

const HOLDOUT_EVALUATION_CAP = 10;
const HOLDOUT_AGE_DAYS_CAP = 90;
const CANDIDATE_LIMIT_PER_WORKSPACE = 500;

type SweepSupabaseClient = SupabaseClient;

export interface RunHoldoutSweepOptions {
  supabase?: SweepSupabaseClient;
  now?: Date;
  /** Test hook: swap the transition wrapper. */
  transition?: typeof applyOutcomeTransition;
}

export type HoldoutCandidateOutcome = "retired" | "transition_failed" | "skipped_not_stuck";

export interface HoldoutCandidateResult {
  identity_match_id: string;
  outcome: HoldoutCandidateOutcome;
  reason_code: "holdout_expired_10_evaluations" | "holdout_expired_90_days" | null;
  detail?: string;
}

export interface WorkspaceHoldoutSweepResult {
  workspace_id: string;
  status:
    | "ok"
    | "emergency_paused"
    | "pause_read_failed"
    | "candidates_read_failed"
    | "run_open_failed";
  candidates_evaluated: number;
  retired_age: number;
  retired_evaluations: number;
  errors: number;
  skipped: number;
  per_candidate: HoldoutCandidateResult[];
  detail?: string;
}

export interface HoldoutSweepRunResult {
  started_at: string;
  workspaces_scanned: number;
  workspaces_processed: number;
  total_retired: number;
  total_errors: number;
  per_workspace: WorkspaceHoldoutSweepResult[];
}

interface CandidateRow {
  id: string;
  workspaceId: string;
  orgId: string;
  connectionId: string;
  variantId: string | null;
  stateVersion: number;
  evaluationCount: number;
  createdAt: string;
  evidenceSnapshot: Record<string, unknown>;
}

export async function runSkuHoldoutStopConditionSweep(
  options: RunHoldoutSweepOptions = {},
): Promise<HoldoutSweepRunResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const transition = options.transition ?? applyOutcomeTransition;

  const result: HoldoutSweepRunResult = {
    started_at: now.toISOString(),
    workspaces_scanned: 0,
    workspaces_processed: 0,
    total_retired: 0,
    total_errors: 0,
    per_workspace: [],
  };

  const { data: workspaces, error: wsError } = await supabase.from("workspaces").select("id");
  if (wsError) {
    logger.error("sku-holdout-stop-condition-sweep: workspace read failed", {
      error: wsError.message,
    });
    return result;
  }
  const workspaceIds = (workspaces ?? []).map((w) => w.id as string).filter(Boolean);
  result.workspaces_scanned = workspaceIds.length;

  for (const workspaceId of workspaceIds) {
    const wr = await processWorkspace(supabase, workspaceId, now, transition);
    result.per_workspace.push(wr);
    if (wr.status === "ok") {
      result.workspaces_processed += 1;
      result.total_retired += wr.retired_age + wr.retired_evaluations;
      result.total_errors += wr.errors;
    }
  }

  logger.info("sku-holdout-stop-condition-sweep: pass complete", {
    workspaces_scanned: result.workspaces_scanned,
    workspaces_processed: result.workspaces_processed,
    retired: result.total_retired,
    errors: result.total_errors,
  });

  return result;
}

async function processWorkspace(
  supabase: SweepSupabaseClient,
  workspaceId: string,
  now: Date,
  transition: typeof applyOutcomeTransition,
): Promise<WorkspaceHoldoutSweepResult> {
  const base: WorkspaceHoldoutSweepResult = {
    workspace_id: workspaceId,
    status: "ok",
    candidates_evaluated: 0,
    retired_age: 0,
    retired_evaluations: 0,
    errors: 0,
    skipped: 0,
    per_candidate: [],
  };

  const pauseCheck = await readWorkspaceEmergencyPause(
    supabase as unknown as EmergencyPauseSupabaseClient,
    workspaceId,
  );
  if (pauseCheck.kind === "error") {
    return { ...base, status: "pause_read_failed", detail: pauseCheck.detail };
  }
  if (pauseCheck.paused) {
    return { ...base, status: "emergency_paused" };
  }

  const ageCutoffIso = new Date(
    now.getTime() - HOLDOUT_AGE_DAYS_CAP * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Candidate set = identity rows in holdout that hit EITHER stop
  // condition. Using `.or()` keeps this one round-trip; the final
  // per-row check in `pickReason()` guarantees we only transition
  // rows that really meet a cap.
  const { data: rows, error } = await supabase
    .from("client_store_product_identity_matches")
    .select(
      "id, workspace_id, org_id, connection_id, variant_id, state_version, evaluation_count, created_at, evidence_snapshot, outcome_state, is_active",
    )
    .eq("workspace_id", workspaceId)
    .eq("outcome_state", "auto_holdout_for_evidence")
    .eq("is_active", true)
    .or(`evaluation_count.gte.${HOLDOUT_EVALUATION_CAP},created_at.lte.${ageCutoffIso}`)
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_LIMIT_PER_WORKSPACE);

  if (error) {
    logger.error("sku-holdout-stop-condition-sweep: candidates read failed", {
      workspace_id: workspaceId,
      detail: error.message,
    });
    return { ...base, status: "candidates_read_failed", detail: error.message };
  }

  const candidates = (rows ?? [])
    .map(parseCandidateRow)
    .filter((row): row is CandidateRow => row !== null);

  if (candidates.length === 0) return base;

  const runId = await openRun(supabase, workspaceId);
  if (runId === null) {
    return { ...base, status: "run_open_failed" };
  }

  for (const row of candidates) {
    base.candidates_evaluated += 1;
    const reason = pickReason(row, now);
    if (reason === null) {
      base.skipped += 1;
      base.per_candidate.push({
        identity_match_id: row.id,
        outcome: "skipped_not_stuck",
        reason_code: null,
      });
      continue;
    }

    const res: ApplyOutcomeTransitionResult = await transition(supabase as unknown as RpcClient, {
      workspaceId: row.workspaceId,
      orgId: row.orgId,
      connectionId: row.connectionId,
      variantId: row.variantId,
      identityMatchId: row.id,
      expectedStateVersion: row.stateVersion,
      from: "auto_holdout_for_evidence",
      to: "auto_reject_non_match",
      trigger: "periodic_revaluation",
      reasonCode: reason,
      evidenceSnapshot: {
        prior: row.evidenceSnapshot,
        sweep: {
          evaluation_count_at_sweep: row.evaluationCount,
          age_days_at_sweep: Math.floor(
            (now.getTime() - new Date(row.createdAt).getTime()) / (24 * 60 * 60 * 1000),
          ),
          entry_point: "sku-holdout-stop-condition-sweep",
        },
      },
      triggeredBy: "sku-holdout-stop-condition-sweep",
    });

    if (!res.ok) {
      base.errors += 1;
      base.per_candidate.push({
        identity_match_id: row.id,
        outcome: "transition_failed",
        reason_code: reason,
        detail: `${res.reason}${res.detail ? `: ${res.detail}` : ""}`,
      });
      await writeDecision(supabase, runId, row, reason, res);
      continue;
    }

    if (reason === "holdout_expired_90_days") base.retired_age += 1;
    else base.retired_evaluations += 1;

    base.per_candidate.push({
      identity_match_id: row.id,
      outcome: "retired",
      reason_code: reason,
    });

    await writeDecision(supabase, runId, row, reason, res);
  }

  await closeRun(supabase, runId, base);
  return base;
}

function parseCandidateRow(raw: Record<string, unknown>): CandidateRow | null {
  const id = raw.id;
  const workspaceId = raw.workspace_id;
  const orgId = raw.org_id;
  const connectionId = raw.connection_id;
  const stateVersion = raw.state_version;
  const evaluationCount = raw.evaluation_count;
  const createdAt = raw.created_at;
  const evidenceSnapshot = raw.evidence_snapshot;

  if (
    typeof id !== "string" ||
    typeof workspaceId !== "string" ||
    typeof orgId !== "string" ||
    typeof connectionId !== "string" ||
    typeof stateVersion !== "number" ||
    typeof evaluationCount !== "number" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  const variantIdRaw = raw.variant_id;
  const variantId = typeof variantIdRaw === "string" ? variantIdRaw : null;
  return {
    id,
    workspaceId,
    orgId,
    connectionId,
    variantId,
    stateVersion,
    evaluationCount,
    createdAt,
    evidenceSnapshot:
      evidenceSnapshot && typeof evidenceSnapshot === "object"
        ? (evidenceSnapshot as Record<string, unknown>)
        : {},
  };
}

/**
 * Return the reason code that retires this row, or null if the row
 * does NOT meet any stop condition (defense-in-depth: the `.or()`
 * query filter may select a row whose criteria the client
 * re-interprets slightly — we double-check here before writing).
 *
 * When BOTH conditions are true we pick `holdout_expired_90_days`
 * because age is the harder rotation guarantee.
 */
function pickReason(
  row: CandidateRow,
  now: Date,
): "holdout_expired_10_evaluations" | "holdout_expired_90_days" | null {
  const ageDays = Math.floor(
    (now.getTime() - new Date(row.createdAt).getTime()) / (24 * 60 * 60 * 1000),
  );
  if (ageDays >= HOLDOUT_AGE_DAYS_CAP) return "holdout_expired_90_days";
  if (row.evaluationCount >= HOLDOUT_EVALUATION_CAP) return "holdout_expired_10_evaluations";
  return null;
}

async function openRun(supabase: SweepSupabaseClient, workspaceId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("sku_autonomous_runs")
    .insert([
      {
        workspace_id: workspaceId,
        connection_id: null,
        trigger_source: "scheduled_periodic",
        dry_run: false,
        feature_flags: { entry_point: "sku-holdout-stop-condition-sweep" },
        triggered_by: "sku-holdout-stop-condition-sweep",
      },
    ])
    .select("id")
    .single();
  if (error || !data || typeof (data as { id?: unknown }).id !== "string") {
    logger.error("sku-holdout-stop-condition-sweep: run open failed", {
      workspace_id: workspaceId,
      detail: error?.message ?? "no_data",
    });
    return null;
  }
  return (data as { id: string }).id;
}

async function closeRun(
  supabase: SweepSupabaseClient,
  runId: string,
  summary: WorkspaceHoldoutSweepResult,
): Promise<void> {
  const { error } = await supabase
    .from("sku_autonomous_runs")
    .update({
      status: summary.errors > 0 ? "failed" : "completed",
      completed_at: new Date().toISOString(),
      variants_evaluated: summary.candidates_evaluated,
      outcomes_breakdown: {
        retired_age: summary.retired_age,
        retired_evaluations: summary.retired_evaluations,
        errors: summary.errors,
        skipped: summary.skipped,
      },
      error_count: summary.errors,
    })
    .eq("id", runId);
  if (error) {
    logger.warn("sku-holdout-stop-condition-sweep: run close failed (non-fatal)", {
      run_id: runId,
      detail: error.message,
    });
  }
}

async function writeDecision(
  supabase: SweepSupabaseClient,
  runId: string,
  row: CandidateRow,
  reason: "holdout_expired_10_evaluations" | "holdout_expired_90_days",
  outcome: ApplyOutcomeTransitionResult,
): Promise<void> {
  const transitionId = outcome.ok ? outcome.transitionId : null;
  const { error } = await supabase.from("sku_autonomous_decisions").insert([
    {
      run_id: runId,
      workspace_id: row.workspaceId,
      connection_id: row.connectionId,
      variant_id: row.variantId,
      outcome_state: outcome.ok ? "auto_reject_non_match" : "auto_holdout_for_evidence",
      previous_outcome_state: "auto_holdout_for_evidence",
      outcome_changed: outcome.ok,
      match_method: null,
      match_confidence: null,
      reason_code: reason,
      evidence_snapshot: {
        prior: row.evidenceSnapshot,
        sweep: {
          evaluation_count_at_sweep: row.evaluationCount,
          entry_point: "sku-holdout-stop-condition-sweep",
        },
        ...(outcome.ok ? {} : { transition_error: outcome.reason, detail: outcome.detail ?? null }),
      },
      evidence_hash: null,
      disqualifiers: outcome.ok ? [] : [outcome.reason],
      top_candidates: [],
      fetch_status: null,
      fetch_completed_at: null,
      fetch_duration_ms: null,
      alias_id: null,
      identity_match_id: row.id,
      transition_id: transitionId,
    },
  ]);
  if (error) {
    logger.warn("sku-holdout-stop-condition-sweep: decision insert failed (non-fatal)", {
      identity_match_id: row.id,
      detail: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Scheduled + manual Trigger bindings
// ─────────────────────────────────────────────────────────────────────

export const skuHoldoutStopConditionSweepScheduledTask = schedules.task({
  id: "sku-holdout-stop-condition-sweep",
  cron: "30 4 * * *",
  maxDuration: 900,
  run: async () => runSkuHoldoutStopConditionSweep(),
});

export const skuHoldoutStopConditionSweepManualTask = task({
  id: "sku-holdout-stop-condition-sweep-manual",
  maxDuration: 900,
  run: async () => runSkuHoldoutStopConditionSweep(),
});
