"use server";

import { z } from "zod/v4";
import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// Phase 6 — Slice 6.A
// Staff read model over `sku_autonomous_runs` + `sku_autonomous_decisions`
// (written by Phase 1/2/3/5 tasks and wrappers).
//
// Contract:
//   * STAFF-ONLY surface — `requireStaff()` gates every action. RLS on both
//     tables limits `authenticated` reads to staff, but we add
//     `workspace_id=:caller` as defense in depth so a leaked service-role
//     grant cannot accidentally fan a query across workspaces.
//   * READ-ONLY. No mutations here. Canary sign-off / flag flips / cancellation
//     live in separate Server Action files (Slice 6.G).
//   * ID-only join boundary. The list endpoint returns rows with
//     `connection_id`; callers that need connection names, store URLs, org
//     names, etc. query the dedicated actions in `store-connections.ts`.
//     This keeps the list query cheap (no N+1 joins in the detail drawer).
//   * Bounded page sizes. `listAutonomousRuns` caps at 100 rows; `getAutonomousRunDetail`
//     caps at 500 decision rows per request (the UI lazy-loads the rest if needed).

const LIST_MAX_LIMIT = 100;
const DETAIL_MAX_DECISIONS = 500;

const listAutonomousRunsInputSchema = z.object({
  connectionId: z.string().uuid().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
  dryRun: z.boolean().optional(),
  triggerSource: z
    .enum([
      "scheduled_periodic",
      "connection_added",
      "manual_admin",
      "evidence_change_trigger",
      "stock_change_trigger",
    ])
    .optional(),
  startedAfter: z.string().datetime().optional(),
  startedBefore: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(25),
  offset: z.number().int().min(0).default(0),
});

export type ListAutonomousRunsInput = z.input<typeof listAutonomousRunsInputSchema>;

export interface AutonomousRunListRow {
  id: string;
  workspace_id: string;
  connection_id: string | null;
  trigger_source: string;
  dry_run: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at: string | null;
  variants_evaluated: number;
  outcomes_breakdown: Record<string, number>;
  candidates_with_no_match: number;
  candidates_held_for_evidence: number;
  candidates_with_disqualifiers: number;
  total_duration_ms: number | null;
  avg_per_variant_ms: number | null;
  error_count: number;
  cancellation_requested_at: string | null;
  triggered_by: string | null;
}

export interface ListAutonomousRunsResult {
  rows: AutonomousRunListRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function listAutonomousRuns(
  rawInput: ListAutonomousRunsInput,
): Promise<ListAutonomousRunsResult> {
  const { workspaceId } = await requireStaff();
  const input = listAutonomousRunsInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("sku_autonomous_runs")
    .select(
      "id, workspace_id, connection_id, trigger_source, dry_run, status, started_at, completed_at, variants_evaluated, outcomes_breakdown, candidates_with_no_match, candidates_held_for_evidence, candidates_with_disqualifiers, total_duration_ms, avg_per_variant_ms, error_count, cancellation_requested_at, triggered_by",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId);

  if (input.connectionId !== undefined) {
    query = query.eq("connection_id", input.connectionId);
  }
  if (input.status !== undefined) {
    query = query.eq("status", input.status);
  }
  if (input.dryRun !== undefined) {
    query = query.eq("dry_run", input.dryRun);
  }
  if (input.triggerSource !== undefined) {
    query = query.eq("trigger_source", input.triggerSource);
  }
  if (input.startedAfter !== undefined) {
    query = query.gte("started_at", input.startedAfter);
  }
  if (input.startedBefore !== undefined) {
    query = query.lte("started_at", input.startedBefore);
  }

  const { data, count, error } = await query
    .order("started_at", { ascending: false })
    .range(input.offset, input.offset + input.limit - 1);

  if (error) {
    throw new Error(`listAutonomousRuns failed: ${error.message}`);
  }

  return {
    rows: (data ?? []) as AutonomousRunListRow[],
    total: count ?? 0,
    limit: input.limit,
    offset: input.offset,
  };
}

const getAutonomousRunDetailInputSchema = z.object({
  runId: z.string().uuid(),
  decisionsLimit: z.number().int().min(1).max(DETAIL_MAX_DECISIONS).default(100),
  decisionsOffset: z.number().int().min(0).default(0),
});

export type GetAutonomousRunDetailInput = z.input<typeof getAutonomousRunDetailInputSchema>;

export interface AutonomousRunDetail extends AutonomousRunListRow {
  feature_flags: Record<string, unknown>;
  error_log: unknown[];
  cancellation_requested_by: string | null;
  cancellation_reason: string | null;
}

export interface AutonomousDecisionRow {
  id: string;
  run_id: string;
  workspace_id: string;
  connection_id: string;
  variant_id: string | null;
  outcome_state: string;
  previous_outcome_state: string | null;
  outcome_changed: boolean;
  match_method: string | null;
  match_confidence: string | null;
  reason_code: string | null;
  evidence_snapshot: Record<string, unknown>;
  evidence_hash: string | null;
  disqualifiers: unknown[];
  top_candidates: unknown[];
  fetch_status: string | null;
  fetch_completed_at: string | null;
  fetch_duration_ms: number | null;
  alias_id: string | null;
  identity_match_id: string | null;
  transition_id: string | null;
  decided_at: string;
}

export interface GetAutonomousRunDetailResult {
  run: AutonomousRunDetail;
  decisions: AutonomousDecisionRow[];
  decisionsTotal: number;
  decisionsLimit: number;
  decisionsOffset: number;
}

export async function getAutonomousRunDetail(
  rawInput: GetAutonomousRunDetailInput,
): Promise<GetAutonomousRunDetailResult> {
  const { workspaceId } = await requireStaff();
  const input = getAutonomousRunDetailInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  const { data: runRow, error: runErr } = await supabase
    .from("sku_autonomous_runs")
    .select(
      "id, workspace_id, connection_id, trigger_source, dry_run, feature_flags, status, started_at, completed_at, variants_evaluated, outcomes_breakdown, candidates_with_no_match, candidates_held_for_evidence, candidates_with_disqualifiers, total_duration_ms, avg_per_variant_ms, error_count, error_log, cancellation_requested_at, cancellation_requested_by, cancellation_reason, triggered_by",
    )
    .eq("id", input.runId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (runErr) {
    throw new Error(`getAutonomousRunDetail run read failed: ${runErr.message}`);
  }
  if (!runRow) {
    throw new Error("Run not found");
  }

  const {
    data: decisionRows,
    count,
    error: decErr,
  } = await supabase
    .from("sku_autonomous_decisions")
    .select(
      "id, run_id, workspace_id, connection_id, variant_id, outcome_state, previous_outcome_state, outcome_changed, match_method, match_confidence, reason_code, evidence_snapshot, evidence_hash, disqualifiers, top_candidates, fetch_status, fetch_completed_at, fetch_duration_ms, alias_id, identity_match_id, transition_id, decided_at",
      { count: "exact" },
    )
    .eq("run_id", input.runId)
    .eq("workspace_id", workspaceId)
    .order("decided_at", { ascending: true })
    .range(input.decisionsOffset, input.decisionsOffset + input.decisionsLimit - 1);

  if (decErr) {
    throw new Error(`getAutonomousRunDetail decisions read failed: ${decErr.message}`);
  }

  return {
    run: runRow as AutonomousRunDetail,
    decisions: (decisionRows ?? []) as AutonomousDecisionRow[],
    decisionsTotal: count ?? 0,
    decisionsLimit: input.decisionsLimit,
    decisionsOffset: input.decisionsOffset,
  };
}

const getVariantDecisionHistoryInputSchema = z.object({
  variantId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type GetVariantDecisionHistoryInput = z.input<typeof getVariantDecisionHistoryInputSchema>;

export interface VariantDecisionHistoryRow extends AutonomousDecisionRow {
  run_trigger_source: string | null;
  run_dry_run: boolean | null;
}

export async function getVariantDecisionHistory(
  rawInput: GetVariantDecisionHistoryInput,
): Promise<VariantDecisionHistoryRow[]> {
  const { workspaceId } = await requireStaff();
  const input = getVariantDecisionHistoryInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("sku_autonomous_decisions")
    .select(
      "id, run_id, workspace_id, connection_id, variant_id, outcome_state, previous_outcome_state, outcome_changed, match_method, match_confidence, reason_code, evidence_snapshot, evidence_hash, disqualifiers, top_candidates, fetch_status, fetch_completed_at, fetch_duration_ms, alias_id, identity_match_id, transition_id, decided_at, sku_autonomous_runs(trigger_source, dry_run)",
    )
    .eq("variant_id", input.variantId)
    .eq("workspace_id", workspaceId)
    .order("decided_at", { ascending: false })
    .limit(input.limit);

  if (error) {
    throw new Error(`getVariantDecisionHistory failed: ${error.message}`);
  }

  type RawRow = AutonomousDecisionRow & {
    sku_autonomous_runs:
      | { trigger_source: string; dry_run: boolean }
      | { trigger_source: string; dry_run: boolean }[]
      | null;
  };

  return (data ?? []).map((row): VariantDecisionHistoryRow => {
    const rawRow = row as unknown as RawRow;
    const runJoin = Array.isArray(rawRow.sku_autonomous_runs)
      ? (rawRow.sku_autonomous_runs[0] ?? null)
      : rawRow.sku_autonomous_runs;
    const { sku_autonomous_runs: _drop, ...rest } = rawRow;
    void _drop;
    return {
      ...rest,
      run_trigger_source: runJoin?.trigger_source ?? null,
      run_dry_run: runJoin?.dry_run ?? null,
    };
  });
}
