"use server";

/**
 * Phase 5 — admin monitoring Server Actions for the ShipStation v2 ↔ DB
 * reconcile sensor (`shipstation-bandcamp-reconcile-{hot,warm,cold}`).
 *
 * Three staff-only verbs:
 *   - `getReconcileDriftSummary({ workspaceId })` — open inventory_drift
 *     review queue rows grouped by severity, plus the latest reconcile
 *     run per tier from `channel_sync_log`. Drives the top-of-page health
 *     cards on `/admin/settings/shipstation-inventory`.
 *   - `listReconcileRuns({ workspaceId, tier? })` — paginated list of
 *     reconcile runs for the "Recent runs" panel. Reads `channel_sync_log`
 *     filtered to `channel='shipstation_v2'` AND `sync_type LIKE 'reconcile_%'`.
 *   - `getSkuSyncStatus({ workspaceId, sku })` — single-row spot-lookup
 *     against the `sku_sync_status` view (Phase 5 §7.1.13 migration).
 *     Drives the per-SKU drill-down card.
 *   - `triggerReconcileRun({ workspaceId, tier })` — staff "rerun now"
 *     button. Enqueues `shipstation-bandcamp-reconcile` with the chosen
 *     tier scoped to a single workspace.
 *
 * Rule #41: every read stays bounded; the trigger verb fires Trigger.dev
 * and returns the run id immediately. Rule #48: no direct ShipStation
 * calls from Server Actions — we only enqueue.
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function assertStaffOwnsWorkspace(workspaceId: string): Promise<void> {
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");
  if (workspaceId !== ctx.userRecord.workspace_id) {
    throw new Error("Cross-workspace inventory monitoring not permitted");
  }
}

// ─── Drift summary (review queue + latest run per tier) ─────────────────────

const SUMMARY_INPUT = z.object({ workspaceId: z.string().uuid() });

export interface DriftSeveritySummary {
  severity: "low" | "medium" | "high" | "critical";
  open_count: number;
}

export interface ReconcileTierLatest {
  tier: "hot" | "warm" | "cold";
  last_run_at: string | null;
  last_status: string | null;
  last_drift_count: number | null;
}

export interface DriftSummaryResult {
  bySeverity: DriftSeveritySummary[];
  byTier: ReconcileTierLatest[];
  totalOpen: number;
}

export async function getReconcileDriftSummary(
  input: z.input<typeof SUMMARY_INPUT>,
): Promise<DriftSummaryResult> {
  const parsed = SUMMARY_INPUT.parse(input);
  await assertStaffOwnsWorkspace(parsed.workspaceId);

  const supabase = createServiceRoleClient();

  // Open inventory_drift review queue rows (Phase 5 + Phase 2.5(c) bundle.derived_drift).
  const { data: openRows, error: openErr } = await supabase
    .from("warehouse_review_queue")
    .select("severity")
    .eq("workspace_id", parsed.workspaceId)
    .eq("category", "inventory_drift")
    .eq("status", "open");
  if (openErr) throw new Error(openErr.message);

  const counts = new Map<DriftSeveritySummary["severity"], number>();
  for (const row of (openRows ?? []) as Array<{ severity: DriftSeveritySummary["severity"] }>) {
    counts.set(row.severity, (counts.get(row.severity) ?? 0) + 1);
  }
  const bySeverity: DriftSeveritySummary[] = (["critical", "high", "medium", "low"] as const).map(
    (severity) => ({
      severity,
      open_count: counts.get(severity) ?? 0,
    }),
  );

  // Latest run per tier (one row each).
  const tierResults: ReconcileTierLatest[] = [];
  for (const tier of ["hot", "warm", "cold"] as const) {
    const { data, error } = await supabase
      .from("channel_sync_log")
      .select("status, started_at, completed_at, items_processed, items_failed")
      .eq("workspace_id", parsed.workspaceId)
      .eq("channel", "shipstation_v2")
      .eq("sync_type", `reconcile_${tier}`)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);

    tierResults.push({
      tier,
      last_run_at:
        (data?.completed_at as string | null) ?? (data?.started_at as string | null) ?? null,
      last_status: (data?.status as string | null) ?? null,
      last_drift_count: (data?.items_failed as number | null) ?? null,
    });
  }

  return {
    bySeverity,
    byTier: tierResults,
    totalOpen: bySeverity.reduce((acc, b) => acc + b.open_count, 0),
  };
}

// ─── Reconcile runs list ─────────────────────────────────────────────────────

const RUNS_INPUT = z.object({
  workspaceId: z.string().uuid(),
  tier: z.enum(["hot", "warm", "cold"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export interface ReconcileRunRow {
  id: string;
  sync_type: string;
  status: string;
  items_processed: number | null;
  items_failed: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export async function listReconcileRuns(
  input: z.input<typeof RUNS_INPUT>,
): Promise<ReconcileRunRow[]> {
  const parsed = RUNS_INPUT.parse(input);
  await assertStaffOwnsWorkspace(parsed.workspaceId);

  const supabase = createServiceRoleClient();
  const builder = supabase
    .from("channel_sync_log")
    .select(
      "id, sync_type, status, items_processed, items_failed, started_at, completed_at, error_message",
    )
    .eq("workspace_id", parsed.workspaceId)
    .eq("channel", "shipstation_v2")
    .order("started_at", { ascending: false })
    .limit(parsed.limit ?? 20);

  const { data, error } = parsed.tier
    ? await builder.eq("sync_type", `reconcile_${parsed.tier}`)
    : await builder.like("sync_type", "reconcile_%");

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ReconcileRunRow[];
}

// ─── Per-SKU spot-lookup against sku_sync_status view ────────────────────────

const SKU_LOOKUP_INPUT = z.object({
  workspaceId: z.string().uuid(),
  sku: z.string().min(1).max(128),
});

export interface SkuSyncStatusRow {
  variant_id: string;
  workspace_id: string;
  org_id: string | null;
  sku: string;
  is_distro: boolean;
  has_bandcamp_mapping: boolean;
  bandcamp_push_mode: string;
  bandcamp_push_blocked: boolean;
  baseline_anomaly_open: boolean;
  sku_conflict_open: boolean;
  last_shipstation_push_at: string | null;
  last_bandcamp_push_at: string | null;
  last_external_error: string | null;
  available: number | null;
  last_internal_write_at: string | null;
}

export async function getSkuSyncStatus(
  input: z.input<typeof SKU_LOOKUP_INPUT>,
): Promise<SkuSyncStatusRow | null> {
  const parsed = SKU_LOOKUP_INPUT.parse(input);
  await assertStaffOwnsWorkspace(parsed.workspaceId);

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("sku_sync_status")
    .select("*")
    .eq("workspace_id", parsed.workspaceId)
    .eq("sku", parsed.sku)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as unknown as SkuSyncStatusRow | null) ?? null;
}

// ─── Manual rerun trigger ────────────────────────────────────────────────────

const TRIGGER_INPUT = z.object({
  workspaceId: z.string().uuid(),
  tier: z.enum(["hot", "warm", "cold"]),
});

export interface TriggerReconcileResult {
  status: "queued";
  taskRunId: string;
  workspaceId: string;
  tier: "hot" | "warm" | "cold";
}

export async function triggerReconcileRun(
  input: z.input<typeof TRIGGER_INPUT>,
): Promise<TriggerReconcileResult> {
  const parsed = TRIGGER_INPUT.parse(input);
  await assertStaffOwnsWorkspace(parsed.workspaceId);

  const handle = await tasks.trigger("shipstation-bandcamp-reconcile", {
    tier: parsed.tier,
    workspaceIds: [parsed.workspaceId],
  });

  return {
    status: "queued",
    taskRunId: handle.id,
    workspaceId: parsed.workspaceId,
    tier: parsed.tier,
  };
}
