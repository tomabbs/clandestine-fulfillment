"use server";

/**
 * Bandcamp baseline anomaly + multi-origin push_mode — staff Server Actions.
 *
 * Plan §7.2.7 (forceBaselineScan), Part 9 (operator runbook), TRUTH_LAYER
 * "Bandcamp push_mode contract".
 *
 * - `forceBaselineScan(workspaceId?)` — enqueues `bandcamp-baseline-audit`
 *   on the shared `bandcamp-api` queue (Rule #9 + Rule #48). Never calls
 *   the Bandcamp API or `update_quantities` directly from a Server Action.
 *   If `workspaceId` is omitted, uses the staff member's own workspace.
 *
 * - `setBandcampPushMode({ mappingId, pushMode, reason })` — staff override
 *   for an individual mapping. Records `push_mode_set_by` so the next audit
 *   run preserves the manual decision (`manual_override` is NEVER auto-cleared).
 *
 * - `listBaselineAnomalies(filter?)` — read for the admin dashboard.
 */

import { tasks } from "@trigger.dev/sdk";
import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// ─── forceBaselineScan ───────────────────────────────────────────────────────

const FORCE_INPUT = z
  .object({
    workspaceId: z.string().uuid().optional(),
  })
  .optional();

export interface ForceBaselineScanResult {
  status: "queued";
  taskRunId: string;
  workspaceId: string;
}

export async function forceBaselineScan(
  input?: z.input<typeof FORCE_INPUT>,
): Promise<ForceBaselineScanResult> {
  const parsed = FORCE_INPUT.parse(input);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const targetWorkspace = parsed?.workspaceId ?? ctx.userRecord.workspace_id;
  if (targetWorkspace !== ctx.userRecord.workspace_id) {
    // Cross-workspace force-scan reserved for future multi-tenant superuser
    // tooling; today every staff user is workspace-scoped.
    throw new Error("Cross-workspace audit not permitted");
  }

  // Rule #48: Server Actions never call Bandcamp directly. We always go
  // through the bandcamp-api queue (Rule #9) so OAuth token refresh stays
  // serialized.
  const handle = await tasks.trigger("bandcamp-baseline-audit", {});
  return {
    status: "queued",
    taskRunId: handle.id,
    workspaceId: targetWorkspace,
  };
}

// ─── setBandcampPushMode ─────────────────────────────────────────────────────

const PUSH_MODE_INPUT = z.object({
  mappingId: z.string().uuid(),
  pushMode: z.enum(["normal", "blocked_baseline", "blocked_multi_origin", "manual_override"]),
  reason: z.string().min(1).max(500),
});

export interface SetPushModeResult {
  status: "ok";
  mappingId: string;
  pushMode: string;
}

export async function setBandcampPushMode(
  input: z.input<typeof PUSH_MODE_INPUT>,
): Promise<SetPushModeResult> {
  const parsed = PUSH_MODE_INPUT.parse(input);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();

  // Defense-in-depth — verify the mapping belongs to the staff member's workspace
  // before mutating. RLS would also block cross-workspace writes, but service-role
  // bypasses RLS so we must check explicitly.
  const { data: mapping, error: selErr } = await supabase
    .from("bandcamp_product_mappings")
    .select("id, workspace_id")
    .eq("id", parsed.mappingId)
    .single();

  if (selErr || !mapping) throw new Error("Mapping not found");
  if (mapping.workspace_id !== ctx.userRecord.workspace_id) {
    throw new Error("Mapping belongs to another workspace");
  }

  const { error: updErr } = await supabase
    .from("bandcamp_product_mappings")
    .update({
      push_mode: parsed.pushMode,
      push_mode_reason: parsed.reason,
      push_mode_set_at: new Date().toISOString(),
      push_mode_set_by: ctx.userRecord.id,
    })
    .eq("id", parsed.mappingId);

  if (updErr) throw new Error(updErr.message);

  return { status: "ok", mappingId: parsed.mappingId, pushMode: parsed.pushMode };
}

// ─── listBaselineAnomalies ───────────────────────────────────────────────────

const LIST_FILTER = z
  .object({
    status: z.enum(["open", "resolved", "all"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .optional();

export interface BaselineAnomalyRow {
  id: string;
  workspace_id: string;
  band_id: number;
  package_id: number;
  option_id: number | null;
  sku: string | null;
  baseline_qty: number;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  notes: string | null;
}

export async function listBaselineAnomalies(
  input?: z.input<typeof LIST_FILTER>,
): Promise<BaselineAnomalyRow[]> {
  const parsed = LIST_FILTER.parse(input);
  const ctx = await requireAuth();
  if (!ctx.isStaff) throw new Error("Staff access required");

  const supabase = createServiceRoleClient();
  let query = supabase
    .from("bandcamp_baseline_anomalies")
    .select(
      "id, workspace_id, band_id, package_id, option_id, sku, baseline_qty, detected_at, resolved_at, resolved_by, notes",
    )
    .eq("workspace_id", ctx.userRecord.workspace_id)
    .order("detected_at", { ascending: false })
    .limit(parsed?.limit ?? 200);

  const status = parsed?.status ?? "open";
  if (status === "open") query = query.is("resolved_at", null);
  else if (status === "resolved") query = query.not("resolved_at", "is", null);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as BaselineAnomalyRow[];
}
