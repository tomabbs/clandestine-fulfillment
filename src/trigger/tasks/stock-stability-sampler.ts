/**
 * Autonomous SKU matcher — Phase 5.A: stock-stability-sampler Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md → §"stock-stability-sampler".
 *
 * Purpose
 * ───────
 * Populate `stock_stability_readings` every 15 minutes with warehouse
 * ATP snapshots for every variant that is subject to the autonomous
 * stability gate. The gate is consumed by:
 *
 *   1. `rankSkuCandidates()` — identity-match tiebreak between candidates.
 *   2. `sku-alias-promotion` Path B — promote a shadow identity match to
 *      a live alias after the `promotion` stability window passes.
 *   3. `webhook-rehydrate` (SKU-AUTO-24) — re-promote a demoted identity
 *      row after the `boost` stability window passes.
 *
 * Sample universe
 * ───────────────
 * Per workspace, the universe is the UNION of variant IDs referenced by
 * either (a) `client_store_product_identity_matches` rows in non-terminal
 * outcome states OR (b) `client_store_sku_mappings` rows (every variant
 * the workspace has ever pushed to a remote store). Deduped and capped
 * at UNIVERSE_LIMIT_PER_WORKSPACE per run so one badly-behaved workspace
 * cannot starve the others.
 *
 * Idempotency
 * ───────────
 *   * `observed_at` is floored to the 15-minute boundary via
 *     `bucketObservedAt()`. Combined with the UNIQUE
 *     (workspace_id, variant_id, source, observed_at) constraint this
 *     makes Trigger.dev double-deliveries silent no-ops: the second run
 *     in the same bucket collides on the key and ON CONFLICT DO NOTHING
 *     drops it.
 *   * Emergency-pause aware: `workspaces.sku_autonomous_emergency_paused
 *     = true` skips that workspace entirely (no DB writes). Fail-closed
 *     via `isWorkspaceEmergencyPaused()` — a DB read error also skips.
 *
 * Queue policy
 * ────────────
 * Scheduler is NOT pinned to the `bandcamp-api` queue (Rule #9). The
 * sampler reads warehouse inventory only; no external API fanout. Runs
 * on the default Trigger queue.
 *
 * Retention
 * ─────────
 * A sibling schedules.task runs once daily at 03:15 UTC and deletes rows
 * older than SAMPLER_RETENTION_DAYS (30d, per Section H of migration
 * 20260428000001). The sampler never purges inline so a large backlog
 * never steals time from the every-15-minute sampling tick.
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import {
  bucketObservedAt,
  buildPurgeCutoffIso,
  buildWarehouseSampleRows,
  mergeVariantUniverse,
  SAMPLER_RETENTION_DAYS,
  SAMPLER_WAREHOUSE_SOURCE,
} from "@/lib/server/stock-stability-sampler";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  type EmergencyPauseSupabaseClient,
  readWorkspaceEmergencyPause,
} from "@/lib/server/workspace-flags";

/** Per-workspace safety cap. 5_000 is well above any realistic universe. */
const UNIVERSE_LIMIT_PER_WORKSPACE = 5_000;

/** Non-terminal outcome states that still benefit from stability samples. */
const SAMPLED_OUTCOME_STATES = [
  "auto_shadow_identity_match",
  "auto_database_identity_match",
  "auto_holdout_for_evidence",
  "client_stock_exception",
  "manual_review_pending",
  "manual_review_needs_evidence",
] as const;

interface WorkspaceSweepResult {
  workspace_id: string;
  status:
    | "ok"
    | "emergency_paused"
    | "empty_universe"
    | "levels_read_failed"
    | "insert_failed"
    | "universe_read_failed";
  variants_sampled: number;
  rows_attempted: number;
  error?: string;
}

interface SamplerRunResult {
  sampler_run_id: string;
  bucket_observed_at: string;
  workspaces_scanned: number;
  workspaces_sampled: number;
  total_rows_attempted: number;
  per_workspace: WorkspaceSweepResult[];
}

interface PurgeRunResult {
  cutoff: string;
  deleted: number;
  error?: string;
}

/**
 * Injection seam: the pieces of a Supabase client the sampler actually
 * uses. Keeping it structural lets tests pass a hand-rolled fake without
 * importing supabase-js types. Production callers pass the real client
 * produced by `createServiceRoleClient()`.
 */
export type SamplerSupabaseClient = ReturnType<typeof createServiceRoleClient>;

export interface RunStockStabilitySamplerOptions {
  supabase?: SamplerSupabaseClient;
  now?: Date;
}

/** Main sampler routine. Exported for unit testability. */
export async function runStockStabilitySampler(
  options: RunStockStabilitySamplerOptions = {},
): Promise<SamplerRunResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const observedAt = bucketObservedAt(now);
  const samplerRunId = `sampler:${observedAt.toISOString()}`;

  const result: SamplerRunResult = {
    sampler_run_id: samplerRunId,
    bucket_observed_at: observedAt.toISOString(),
    workspaces_scanned: 0,
    workspaces_sampled: 0,
    total_rows_attempted: 0,
    per_workspace: [],
  };

  const { data: workspaces, error: workspacesError } = await supabase
    .from("workspaces")
    .select("id");

  if (workspacesError) {
    logger.error("stock-stability-sampler: workspaces read failed", {
      error: workspacesError.message,
    });
    return result;
  }

  const workspaceIds = (workspaces ?? []).map((w) => w.id as string).filter(Boolean);
  result.workspaces_scanned = workspaceIds.length;

  for (const workspaceId of workspaceIds) {
    const workspaceResult = await sampleWorkspace(supabase, workspaceId, observedAt, samplerRunId);
    result.per_workspace.push(workspaceResult);
    if (workspaceResult.status === "ok") {
      result.workspaces_sampled += 1;
      result.total_rows_attempted += workspaceResult.rows_attempted;
    }
  }

  logger.info("stock-stability-sampler: pass complete", {
    bucket: result.bucket_observed_at,
    scanned: result.workspaces_scanned,
    sampled: result.workspaces_sampled,
    rows: result.total_rows_attempted,
  });

  return result;
}

async function sampleWorkspace(
  supabase: SamplerSupabaseClient,
  workspaceId: string,
  observedAt: Date,
  samplerRunId: string,
): Promise<WorkspaceSweepResult> {
  const pauseCheck = await readWorkspaceEmergencyPause(
    supabase as unknown as EmergencyPauseSupabaseClient,
    workspaceId,
  );
  if (pauseCheck.kind === "error") {
    logger.warn("stock-stability-sampler: emergency-pause read failed; skipping", {
      workspace_id: workspaceId,
      detail: pauseCheck.detail,
    });
    return {
      workspace_id: workspaceId,
      status: "emergency_paused",
      variants_sampled: 0,
      rows_attempted: 0,
      error: pauseCheck.detail,
    };
  }
  if (pauseCheck.paused) {
    return {
      workspace_id: workspaceId,
      status: "emergency_paused",
      variants_sampled: 0,
      rows_attempted: 0,
    };
  }

  const [identityIds, mappingIds] = await Promise.all([
    readIdentityVariantIds(supabase, workspaceId),
    readMappingVariantIds(supabase, workspaceId),
  ]);

  if (identityIds.kind === "error" || mappingIds.kind === "error") {
    const detail =
      identityIds.kind === "error" ? identityIds.detail : (mappingIds as { detail: string }).detail;
    logger.error("stock-stability-sampler: universe read failed", {
      workspace_id: workspaceId,
      detail,
    });
    return {
      workspace_id: workspaceId,
      status: "universe_read_failed",
      variants_sampled: 0,
      rows_attempted: 0,
      error: detail,
    };
  }

  const universe = mergeVariantUniverse(identityIds.ids, mappingIds.ids).slice(
    0,
    UNIVERSE_LIMIT_PER_WORKSPACE,
  );

  if (universe.length === 0) {
    return {
      workspace_id: workspaceId,
      status: "empty_universe",
      variants_sampled: 0,
      rows_attempted: 0,
    };
  }

  const levelsResult = await readWarehouseLevels(supabase, workspaceId, universe);
  if (levelsResult.kind === "error") {
    logger.error("stock-stability-sampler: levels read failed", {
      workspace_id: workspaceId,
      detail: levelsResult.detail,
    });
    return {
      workspace_id: workspaceId,
      status: "levels_read_failed",
      variants_sampled: 0,
      rows_attempted: 0,
      error: levelsResult.detail,
    };
  }

  const rows = buildWarehouseSampleRows({
    workspaceId,
    levels: levelsResult.levels,
    observedAt,
    samplerRunId,
  });

  if (rows.length === 0) {
    return {
      workspace_id: workspaceId,
      status: "empty_universe",
      variants_sampled: 0,
      rows_attempted: 0,
    };
  }

  const { error: insertError } = await supabase.from("stock_stability_readings").upsert(rows, {
    onConflict: "workspace_id,variant_id,source,observed_at",
    ignoreDuplicates: true,
  });

  if (insertError) {
    logger.error("stock-stability-sampler: insert failed", {
      workspace_id: workspaceId,
      detail: insertError.message,
      rows: rows.length,
    });
    return {
      workspace_id: workspaceId,
      status: "insert_failed",
      variants_sampled: 0,
      rows_attempted: rows.length,
      error: insertError.message,
    };
  }

  return {
    workspace_id: workspaceId,
    status: "ok",
    variants_sampled: rows.length,
    rows_attempted: rows.length,
  };
}

interface VariantIdReadOk {
  kind: "ok";
  ids: string[];
}
interface VariantIdReadErr {
  kind: "error";
  detail: string;
}

async function readIdentityVariantIds(
  supabase: SamplerSupabaseClient,
  workspaceId: string,
): Promise<VariantIdReadOk | VariantIdReadErr> {
  const { data, error } = await supabase
    .from("client_store_product_identity_matches")
    .select("variant_id")
    .eq("workspace_id", workspaceId)
    .in("outcome_state", [...SAMPLED_OUTCOME_STATES]);

  if (error) return { kind: "error", detail: error.message };
  return { kind: "ok", ids: (data ?? []).map((r) => r.variant_id as string).filter(Boolean) };
}

async function readMappingVariantIds(
  supabase: SamplerSupabaseClient,
  workspaceId: string,
): Promise<VariantIdReadOk | VariantIdReadErr> {
  const { data, error } = await supabase
    .from("client_store_sku_mappings")
    .select("variant_id")
    .eq("workspace_id", workspaceId)
    .not("variant_id", "is", null);

  if (error) return { kind: "error", detail: error.message };
  return { kind: "ok", ids: (data ?? []).map((r) => r.variant_id as string).filter(Boolean) };
}

interface LevelsReadOk {
  kind: "ok";
  levels: Array<{
    variant_id: string;
    available: number | null;
    committed_quantity: number | null;
  }>;
}
interface LevelsReadErr {
  kind: "error";
  detail: string;
}

async function readWarehouseLevels(
  supabase: SamplerSupabaseClient,
  workspaceId: string,
  variantIds: string[],
): Promise<LevelsReadOk | LevelsReadErr> {
  const { data, error } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id, available, committed_quantity")
    .eq("workspace_id", workspaceId)
    .in("variant_id", variantIds);

  if (error) return { kind: "error", detail: error.message };
  return {
    kind: "ok",
    levels: (data ?? []).map((r) => ({
      variant_id: r.variant_id as string,
      available: typeof r.available === "number" ? r.available : null,
      committed_quantity: typeof r.committed_quantity === "number" ? r.committed_quantity : null,
    })),
  };
}

export interface RunStockStabilityReadingsPurgeOptions {
  supabase?: SamplerSupabaseClient;
  now?: Date;
  retentionDays?: number;
}

/** Purge routine — exported for unit testability. */
export async function runStockStabilityReadingsPurge(
  options: RunStockStabilityReadingsPurgeOptions = {},
): Promise<PurgeRunResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? SAMPLER_RETENTION_DAYS;
  const cutoff = buildPurgeCutoffIso(now, retentionDays);

  const { count, error } = await supabase
    .from("stock_stability_readings")
    .delete({ count: "exact" })
    .lt("created_at", cutoff);

  if (error) {
    logger.error("stock-stability-readings-purge: delete failed", {
      detail: error.message,
      cutoff,
    });
    return { cutoff, deleted: 0, error: error.message };
  }

  const deleted = count ?? 0;
  logger.info("stock-stability-readings-purge: pass complete", {
    cutoff,
    deleted,
  });
  return { cutoff, deleted };
}

export const stockStabilitySamplerScheduledTask = schedules.task({
  id: "stock-stability-sampler",
  cron: "*/15 * * * *",
  maxDuration: 240,
  run: async () => runStockStabilitySampler(),
});

export const stockStabilitySamplerManualTask = task({
  id: "stock-stability-sampler-manual",
  maxDuration: 240,
  run: async () => runStockStabilitySampler(),
});

export const stockStabilityReadingsPurgeScheduledTask = schedules.task({
  id: "stock-stability-readings-purge",
  cron: "15 3 * * *",
  maxDuration: 120,
  run: async () => runStockStabilityReadingsPurge(),
});

export const stockStabilityReadingsPurgeManualTask = task({
  id: "stock-stability-readings-purge-manual",
  maxDuration: 120,
  run: async (payload: { retention_days?: number } = {}) =>
    runStockStabilityReadingsPurge({ retentionDays: payload.retention_days }),
});

export { SAMPLER_WAREHOUSE_SOURCE };
