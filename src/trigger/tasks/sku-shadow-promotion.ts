/**
 * Autonomous SKU matcher — Phase 5.B: sku-shadow-promotion Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Shadow-to-live promotion criteria" +
 *       §"sku-shadow-promotion" (Rollout checklist Phase 7) +
 *       Rule #9 / #60 (queue isolation: NOT bandcamp-api) +
 *       SKU-AUTO-8 (promotion only via `promoteIdentityMatchToAlias`).
 *
 * Scope
 * ─────
 * Daily scheduled job that evaluates `auto_database_identity_match`
 * rows with positive `warehouse_stock_at_match` against Promotion
 * Paths A and B (Path C is a human-driven path; this task never
 * simulates it). Promotion is delegated to
 * `promoteIdentityMatchToAlias()` — the single legal TS entry point
 * for the underlying `promote_identity_match_to_alias` RPC — so
 * emergency-pause, autonomy-flag, and stock-stability gates are all
 * enforced consistently with the webhook-rehydrate path.
 *
 * Per candidate the task:
 *
 *   1. Derives Path A evidence flags from the identity row's
 *      `evidence_snapshot` (verified Bandcamp option, exact barcode
 *      match, exact SKU match with safety constraints).
 *   2. Counts prior `auto_database_identity_match` decision rows for
 *      this identity_match for the Path B decision-count gate.
 *   3. Reads current warehouse ATP from `warehouse_inventory_levels`.
 *   4. Reads the 24h stability history from `stock_stability_readings`
 *      where `source = SAMPLER_WAREHOUSE_SOURCE` (the rows the
 *      `stock-stability-sampler` writes).
 *   5. Runs the pure `shouldPromoteShadow()` policy.
 *   6a. On `promote`: calls `promoteIdentityMatchToAlias()`. The
 *       wrapper writes its own `sku_autonomous_decisions` row and
 *       its own `sku_outcome_transitions` row via the RPC.
 *   6b. On `bump`: increments `evaluation_count` + `state_version`,
 *       updates `last_evaluated_at`, and writes a single
 *       `sku_autonomous_decisions` row with `outcome_changed=false`
 *       so the stability window can advance next cycle and the audit
 *       trail records why promotion was declined.
 *
 * Run accounting
 * ──────────────
 * One `sku_autonomous_runs` row per workspace per pass. Using a
 * workspace-wide run (rather than one run per candidate) keeps the
 * audit volume bounded and mirrors the existing pattern used by the
 * matching-monitor task.
 *
 * Queue policy
 * ────────────
 * Not pinned to `bandcamp-api` (Rule #9). The task reads from
 * Postgres and Redis-agnostic helpers; the promotion RPC itself never
 * hits external APIs. Default Trigger queue is fine.
 *
 * Idempotency
 * ───────────
 * Promotion is serialized by the advisory lock inside
 * `promote_identity_match_to_alias`. The bump path is
 * optimistic-concurrency-controlled via `state_version`. A double
 * delivery therefore either re-races the advisory lock (one wins,
 * the other returns `state_version_drift`) or re-races the OCC UPDATE
 * (one updates, the other writes 0 rows).
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import {
  type PromoteIdentityMatchResult,
  type PromotionSupabaseClient,
  promoteIdentityMatchToAlias,
} from "@/lib/server/sku-alias-promotion";
import {
  type PathAEvidenceFlags,
  type ShadowPromotionDecision,
  type ShadowPromotionDisqualifier,
  shouldPromoteShadow,
} from "@/lib/server/sku-shadow-promotion-policy";
import type { StockHistoryReadings, StockSignal } from "@/lib/server/stock-reliability";
import { SAMPLER_WAREHOUSE_SOURCE } from "@/lib/server/stock-stability-sampler";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  type EmergencyPauseSupabaseClient,
  readWorkspaceEmergencyPause,
} from "@/lib/server/workspace-flags";

const CANDIDATE_LIMIT_PER_WORKSPACE = 2_000;
const STABILITY_HISTORY_LIMIT = 24;

// ─────────────────────────────────────────────────────────────────────
// Structural subset of the Supabase client used by this task. Kept
// narrow so tests can mock it without pulling supabase-js types.
// ─────────────────────────────────────────────────────────────────────
type ShadowSupabaseClient = ReturnType<typeof createServiceRoleClient>;

// ─────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────

export interface RunSkuShadowPromotionOptions {
  supabase?: ShadowSupabaseClient;
  now?: Date;
  /**
   * Test-only override — pass a stub promoter to avoid round-tripping
   * through the RPC. Production passes the real
   * `promoteIdentityMatchToAlias`.
   */
  promoter?: typeof promoteIdentityMatchToAlias;
}

export interface WorkspaceShadowPromotionResult {
  workspace_id: string;
  status:
    | "ok"
    | "emergency_paused"
    | "pause_read_failed"
    | "candidates_read_failed"
    | "run_open_failed";
  candidates_evaluated: number;
  promoted: number;
  bumped: number;
  promotion_blocked: number;
  errors: number;
  run_id?: string;
  detail?: string;
}

export interface ShadowPromotionRunResult {
  started_at: string;
  workspaces_scanned: number;
  workspaces_processed: number;
  total_candidates_evaluated: number;
  total_promoted: number;
  total_bumped: number;
  total_promotion_blocked: number;
  total_errors: number;
  per_workspace: WorkspaceShadowPromotionResult[];
}

export async function runSkuShadowPromotion(
  options: RunSkuShadowPromotionOptions = {},
): Promise<ShadowPromotionRunResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const promoter = options.promoter ?? promoteIdentityMatchToAlias;

  const result: ShadowPromotionRunResult = {
    started_at: now.toISOString(),
    workspaces_scanned: 0,
    workspaces_processed: 0,
    total_candidates_evaluated: 0,
    total_promoted: 0,
    total_bumped: 0,
    total_promotion_blocked: 0,
    total_errors: 0,
    per_workspace: [],
  };

  const { data: workspaces, error: wsError } = await supabase.from("workspaces").select("id");
  if (wsError) {
    logger.error("sku-shadow-promotion: workspaces read failed", { error: wsError.message });
    return result;
  }

  const workspaceIds = (workspaces ?? []).map((w) => w.id as string).filter(Boolean);
  result.workspaces_scanned = workspaceIds.length;

  for (const workspaceId of workspaceIds) {
    const wr = await processWorkspace(supabase, workspaceId, now, promoter);
    result.per_workspace.push(wr);
    if (wr.status === "ok") {
      result.workspaces_processed += 1;
      result.total_candidates_evaluated += wr.candidates_evaluated;
      result.total_promoted += wr.promoted;
      result.total_bumped += wr.bumped;
      result.total_promotion_blocked += wr.promotion_blocked;
      result.total_errors += wr.errors;
    }
  }

  logger.info("sku-shadow-promotion: pass complete", {
    workspaces_scanned: result.workspaces_scanned,
    workspaces_processed: result.workspaces_processed,
    candidates: result.total_candidates_evaluated,
    promoted: result.total_promoted,
    bumped: result.total_bumped,
    blocked: result.total_promotion_blocked,
    errors: result.total_errors,
  });

  return result;
}

async function processWorkspace(
  supabase: ShadowSupabaseClient,
  workspaceId: string,
  now: Date,
  promoter: typeof promoteIdentityMatchToAlias,
): Promise<WorkspaceShadowPromotionResult> {
  const base: WorkspaceShadowPromotionResult = {
    workspace_id: workspaceId,
    status: "ok",
    candidates_evaluated: 0,
    promoted: 0,
    bumped: 0,
    promotion_blocked: 0,
    errors: 0,
  };

  const pauseCheck = await readWorkspaceEmergencyPause(
    supabase as unknown as EmergencyPauseSupabaseClient,
    workspaceId,
  );
  if (pauseCheck.kind === "error") {
    logger.warn("sku-shadow-promotion: pause read failed; skipping", {
      workspace_id: workspaceId,
      detail: pauseCheck.detail,
    });
    return { ...base, status: "pause_read_failed", detail: pauseCheck.detail };
  }
  if (pauseCheck.paused) {
    return { ...base, status: "emergency_paused" };
  }

  // Query the promotion-candidate index.
  const { data: candidates, error: candErr } = await supabase
    .from("client_store_product_identity_matches")
    .select(
      "id, workspace_id, connection_id, variant_id, outcome_state, state_version, evaluation_count, evidence_snapshot, warehouse_stock_at_match, created_at, is_active",
    )
    .eq("workspace_id", workspaceId)
    .eq("outcome_state", "auto_database_identity_match")
    .eq("is_active", true)
    .gt("warehouse_stock_at_match", 0)
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_LIMIT_PER_WORKSPACE);

  if (candErr) {
    logger.error("sku-shadow-promotion: candidates read failed", {
      workspace_id: workspaceId,
      detail: candErr.message,
    });
    return { ...base, status: "candidates_read_failed", detail: candErr.message };
  }

  const rows = (candidates ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    return base;
  }

  const runId = await openRun(supabase, workspaceId);
  if (runId === null) {
    return { ...base, status: "run_open_failed" };
  }
  base.run_id = runId;

  for (const rawRow of rows) {
    const row = parseCandidateRow(rawRow);
    if (row === null) continue;
    base.candidates_evaluated += 1;

    try {
      const outcome = await evaluateAndApply(supabase, runId, row, workspaceId, now, promoter);
      if (outcome === "promoted") base.promoted += 1;
      else if (outcome === "promotion_blocked") base.promotion_blocked += 1;
      else base.bumped += 1;
    } catch (err) {
      base.errors += 1;
      logger.error("sku-shadow-promotion: candidate evaluation threw", {
        workspace_id: workspaceId,
        identity_match_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await closeRun(supabase, runId, base);
  return base;
}

// ─────────────────────────────────────────────────────────────────────
// Candidate evaluation
// ─────────────────────────────────────────────────────────────────────

interface CandidateRow {
  id: string;
  workspaceId: string;
  connectionId: string;
  variantId: string | null;
  outcomeState: string;
  stateVersion: number;
  evaluationCount: number;
  evidenceSnapshot: Record<string, unknown>;
  warehouseStockAtMatch: number | null;
  createdAt: string;
}

function parseCandidateRow(row: Record<string, unknown>): CandidateRow | null {
  if (typeof row.id !== "string") return null;
  if (typeof row.workspace_id !== "string") return null;
  if (typeof row.connection_id !== "string") return null;
  if (typeof row.outcome_state !== "string") return null;
  if (typeof row.state_version !== "number") return null;
  if (typeof row.created_at !== "string") return null;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    variantId: typeof row.variant_id === "string" ? row.variant_id : null,
    outcomeState: row.outcome_state,
    stateVersion: row.state_version,
    evaluationCount: typeof row.evaluation_count === "number" ? row.evaluation_count : 0,
    evidenceSnapshot:
      row.evidence_snapshot && typeof row.evidence_snapshot === "object"
        ? (row.evidence_snapshot as Record<string, unknown>)
        : {},
    warehouseStockAtMatch:
      typeof row.warehouse_stock_at_match === "number" ? row.warehouse_stock_at_match : null,
    createdAt: row.created_at,
  };
}

type CandidateOutcome = "promoted" | "promotion_blocked" | "bumped";

async function evaluateAndApply(
  supabase: ShadowSupabaseClient,
  runId: string,
  row: CandidateRow,
  workspaceId: string,
  now: Date,
  promoter: typeof promoteIdentityMatchToAlias,
): Promise<CandidateOutcome> {
  const pathAEvidence = derivePathAEvidence(row.evidenceSnapshot);
  const [priorCount, atp, history] = await Promise.all([
    countPriorDatabaseIdentityDecisions(supabase, row.id),
    row.variantId ? readWarehouseAtp(supabase, row.variantId) : Promise.resolve(null),
    row.variantId
      ? readStabilityHistory(supabase, workspaceId, row.variantId)
      : Promise.resolve({ readings: [] } as StockHistoryReadings),
  ]);

  const stockSignal = buildStockSignal(atp, now);

  const decision = shouldPromoteShadow(
    {
      identityMatchId: row.id,
      workspaceId: row.workspaceId,
      connectionId: row.connectionId,
      variantId: row.variantId,
      outcomeState: row.outcomeState,
      stateVersion: row.stateVersion,
      createdAt: row.createdAt,
      evaluationCount: row.evaluationCount,
      warehouseStockAtMatch: row.warehouseStockAtMatch,
      pathAEvidence,
      priorDatabaseIdentityDecisionCount: priorCount,
      warehouseAtpNow: atp,
      stockSignal,
      stabilityHistory: history,
    },
    now,
  );

  if (decision.action === "bump") {
    await writeBump(supabase, runId, row, decision, pathAEvidence);
    return "bumped";
  }

  const promoRes: PromoteIdentityMatchResult = await promoter(
    supabase as unknown as PromotionSupabaseClient,
    {
      workspaceId: row.workspaceId,
      connectionId: row.connectionId,
      runId,
      identityMatchId: row.id,
      variantId: row.variantId,
      expectedStateVersion: row.stateVersion,
      path: decision.path,
      reasonCode: decision.reasonCode,
      triggeredBy: "sku-shadow-promotion",
      evidenceSnapshot: {
        prior: row.evidenceSnapshot,
        path: decision.path,
        reason_code: decision.reasonCode,
        path_a_evidence: pathAEvidence,
        warehouse_atp_now: atp,
        warehouse_stock_at_match: row.warehouseStockAtMatch,
        prior_database_identity_decision_count: priorCount,
        entry_point: "sku-shadow-promotion",
      },
      stockEvidence: stockSignal ? { signal: stockSignal, history } : undefined,
      previousOutcomeState: "auto_database_identity_match",
    },
  );

  if (promoRes.ok) {
    return "promoted";
  }

  logger.warn("sku-shadow-promotion: promotion blocked", {
    workspace_id: row.workspaceId,
    identity_match_id: row.id,
    path: decision.path,
    reason: promoRes.reason,
    detail: promoRes.detail,
  });

  // Also bump so the stability window advances next cycle.
  await writeBump(
    supabase,
    runId,
    row,
    {
      action: "bump",
      disqualifiers: [`promotion_blocked_${promoRes.reason}` as ShadowPromotionDisqualifier],
    },
    pathAEvidence,
  );
  return "promotion_blocked";
}

// ─────────────────────────────────────────────────────────────────────
// Path A evidence derivation
// ─────────────────────────────────────────────────────────────────────
//
// The evidence snapshot is free-form JSONB. We probe a few defensively
// documented shapes:
//   * `identity.exactBarcode === true` → exactBarcodeMatch.
//   * `identity.exactSku === true && identity.exactSkuSafe === true`
//     → exactSkuMatchSafe.
//   * `identity.verifiedBandcampOption === true` → verifiedBandcampOption.
// Unknown shapes default to false — a missing flag is never evidence.

function derivePathAEvidence(snapshot: Record<string, unknown>): PathAEvidenceFlags {
  const identity =
    snapshot && typeof snapshot === "object" && "identity" in snapshot
      ? (snapshot as { identity?: unknown }).identity
      : null;
  if (!identity || typeof identity !== "object") {
    return {};
  }
  const id = identity as Record<string, unknown>;
  return {
    verifiedBandcampOption: id.verifiedBandcampOption === true,
    exactBarcodeMatch: id.exactBarcode === true,
    exactSkuMatchSafe: id.exactSku === true && id.exactSkuSafe === true,
  };
}

// ─────────────────────────────────────────────────────────────────────
// DB helpers (structurally typed against SamplerSupabaseClient)
// ─────────────────────────────────────────────────────────────────────

async function countPriorDatabaseIdentityDecisions(
  supabase: ShadowSupabaseClient,
  identityMatchId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("sku_autonomous_decisions")
    .select("id", { count: "exact", head: true })
    .eq("identity_match_id", identityMatchId)
    .eq("outcome_state", "auto_database_identity_match");
  if (error) return 0;
  return typeof count === "number" ? count : 0;
}

async function readWarehouseAtp(
  supabase: ShadowSupabaseClient,
  variantId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, committed_quantity")
    .eq("variant_id", variantId)
    .maybeSingle();
  if (error || !data) return null;
  const available = typeof data.available === "number" ? data.available : 0;
  const committed =
    typeof data.committed_quantity === "number" ? Math.max(0, data.committed_quantity) : 0;
  return Math.max(0, available - committed);
}

async function readStabilityHistory(
  supabase: ShadowSupabaseClient,
  workspaceId: string,
  variantId: string,
): Promise<StockHistoryReadings> {
  const { data, error } = await supabase
    .from("stock_stability_readings")
    .select("observed_at, available")
    .eq("workspace_id", workspaceId)
    .eq("variant_id", variantId)
    .eq("source", SAMPLER_WAREHOUSE_SOURCE)
    .order("observed_at", { ascending: false })
    .limit(STABILITY_HISTORY_LIMIT);

  if (error) return { readings: [] };

  const rawRows = (data ?? []) as Array<Record<string, unknown>>;
  const readings = rawRows
    .map((r) => {
      const observedAt = typeof r.observed_at === "string" ? r.observed_at : null;
      const available =
        typeof r.available === "number" ? r.available : r.available === null ? null : undefined;
      if (observedAt === null || available === undefined) return null;
      return { observedAt, value: available };
    })
    .filter(
      (
        x: { observedAt: string; value: number | null } | null,
      ): x is {
        observedAt: string;
        value: number | null;
      } => x !== null,
    );
  return { readings };
}

function buildStockSignal(atp: number | null, now: Date): StockSignal | null {
  if (atp === null) return null;
  const iso = now.toISOString();
  return {
    value: atp,
    observedAt: iso,
    observedAtLocal: iso,
    source: "warehouse_inventory_levels",
    tier: "authoritative",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Run lifecycle + decision writes
// ─────────────────────────────────────────────────────────────────────

async function openRun(
  supabase: ShadowSupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("sku_autonomous_runs")
    .insert([
      {
        workspace_id: workspaceId,
        connection_id: null,
        trigger_source: "scheduled_periodic",
        dry_run: false,
        feature_flags: { entry_point: "sku-shadow-promotion" },
        triggered_by: "sku-shadow-promotion",
      },
    ])
    .select("id")
    .single();
  if (error || !data || typeof data.id !== "string") {
    logger.error("sku-shadow-promotion: run open failed", {
      workspace_id: workspaceId,
      detail: error?.message ?? "no_data",
    });
    return null;
  }
  return data.id;
}

async function closeRun(
  supabase: ShadowSupabaseClient,
  runId: string,
  summary: WorkspaceShadowPromotionResult,
): Promise<void> {
  const { error } = await supabase
    .from("sku_autonomous_runs")
    .update({
      status: summary.errors > 0 ? "failed" : "completed",
      completed_at: new Date().toISOString(),
      variants_evaluated: summary.candidates_evaluated,
      outcomes_breakdown: {
        promoted: summary.promoted,
        bumped: summary.bumped,
        promotion_blocked: summary.promotion_blocked,
        errors: summary.errors,
      },
      error_count: summary.errors,
    })
    .eq("id", runId);
  if (error) {
    logger.warn("sku-shadow-promotion: run close failed (non-fatal)", {
      run_id: runId,
      detail: error.message,
    });
  }
}

async function writeBump(
  supabase: ShadowSupabaseClient,
  runId: string,
  row: CandidateRow,
  decision: Extract<ShadowPromotionDecision, { action: "bump" }>,
  pathAEvidence: PathAEvidenceFlags,
): Promise<void> {
  // OCC bump on the identity row — increments state_version and
  // refreshes evaluation counters. A losing race surfaces as
  // 0 rows affected, which is fine; the winning worker wrote.
  const { error: updateError } = await supabase
    .from("client_store_product_identity_matches")
    .update({
      evaluation_count: row.evaluationCount + 1,
      last_evaluated_at: new Date().toISOString(),
      state_version: row.stateVersion + 1,
    })
    .eq("id", row.id)
    .eq("state_version", row.stateVersion);

  if (updateError) {
    logger.warn("sku-shadow-promotion: identity row bump failed", {
      identity_match_id: row.id,
      detail: updateError.message,
    });
  }

  const { error: decError } = await supabase.from("sku_autonomous_decisions").insert([
    {
      run_id: runId,
      workspace_id: row.workspaceId,
      connection_id: row.connectionId,
      variant_id: row.variantId,
      outcome_state: row.outcomeState,
      previous_outcome_state: row.outcomeState,
      outcome_changed: false,
      match_method: null,
      match_confidence: null,
      reason_code: null,
      evidence_snapshot: {
        prior: row.evidenceSnapshot,
        path_a_evidence: pathAEvidence,
        entry_point: "sku-shadow-promotion",
      },
      evidence_hash: null,
      disqualifiers: decision.disqualifiers,
      top_candidates: [],
      fetch_status: null,
      fetch_completed_at: null,
      fetch_duration_ms: null,
      alias_id: null,
      identity_match_id: row.id,
      transition_id: null,
    },
  ]);
  if (decError) {
    logger.warn("sku-shadow-promotion: decision insert failed (non-fatal)", {
      identity_match_id: row.id,
      detail: decError.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Scheduled + manual Trigger bindings
// ─────────────────────────────────────────────────────────────────────

export const skuShadowPromotionScheduledTask = schedules.task({
  id: "sku-shadow-promotion",
  // Daily at 02:30 UTC — off-peak vs. webhook traffic and the
  // stock-stability-sampler's 15-min cadence.
  cron: "30 2 * * *",
  maxDuration: 900,
  run: async () => runSkuShadowPromotion(),
});

export const skuShadowPromotionManualTask = task({
  id: "sku-shadow-promotion-manual",
  maxDuration: 900,
  run: async () => runSkuShadowPromotion(),
});
