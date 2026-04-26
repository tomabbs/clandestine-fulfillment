"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import {
  getWorkspaceFlags,
  invalidateWorkspaceFlags,
  type WorkspaceFlags,
} from "@/lib/server/workspace-flags";

// Phase 6 — Slice 6.G
// Canary sign-off + flag-flip Server Action.
//
// Contract (SKU-AUTO-19):
//   * STAFF-ONLY. `requireStaff()` gates every action.
//   * Before flipping `sku_identity_autonomy_enabled` (Phase 2) or
//     `sku_live_alias_autonomy_enabled` (Phase 7) the action MUST find
//     a RESOLVED `warehouse_review_queue` row in the caller's workspace
//     with category `sku_autonomous_canary_review`. Finding an OPEN
//     review row blocks the flip — the action reports back the row id
//     so the UI can link directly to the pending item.
//   * Phase 7 (live-alias) ALSO requires the current
//     `compute_bandcamp_linkage_metrics` output to clear the three
//     hard thresholds (70% linkage / 60% verified / 40% option). These
//     thresholds come from the plan §"Phase 7 preflight" and are
//     mirrored in the DEFERRED_FOLLOWUPS entry for Phase 7.
//   * Turning a flag OFF ("rollback") is unconditional: any staff
//     member can pull the kill switch at any time. We never gate the
//     off-flip behind the canary review or the linkage metrics — the
//     point of rollback is to be fast.
//   * The action writes to `workspaces.flags` via service-role, then
//     invalidates the in-process flag cache so downstream reads (the
//     Trigger tasks + webhook handlers) pick up the change on next tick.

const CANARY_REVIEW_CATEGORY = "sku_autonomous_canary_review";

const FLIP_FLAG_NAMES = [
  "sku_identity_autonomy_enabled",
  "sku_live_alias_autonomy_enabled",
  "non_warehouse_order_hold_enabled",
  "non_warehouse_order_client_alerts_enabled",
  "sku_autonomous_ui_enabled",
  "client_stock_exception_reports_enabled",
] as const;

type FlipFlagName = (typeof FLIP_FLAG_NAMES)[number];

/**
 * Flags that require the SKU-AUTO-19 canary-review preflight before
 * being turned ON. Other flags (UI surface flag, client-facing report
 * flag) are UI-only and don't need a canary gate.
 */
const CANARY_GATED_FLAGS: readonly FlipFlagName[] = [
  "sku_identity_autonomy_enabled",
  "sku_live_alias_autonomy_enabled",
];

/**
 * Flags that additionally require the Bandcamp linkage metrics to clear
 * the Phase 7 thresholds before being turned ON.
 */
const LINKAGE_GATED_FLAGS: readonly FlipFlagName[] = ["sku_live_alias_autonomy_enabled"];

/**
 * Phase 7 linkage thresholds. If any single metric is below its
 * threshold the flip is blocked.
 */
const LINKAGE_THRESHOLDS = {
  linkage_rate: 0.7,
  verified_rate: 0.6,
  option_rate: 0.4,
} as const;

const flipFlagInputSchema = z
  .object({
    flag: z.enum(FLIP_FLAG_NAMES),
    enabled: z.boolean(),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.enabled && (CANARY_GATED_FLAGS as readonly string[]).includes(val.flag)) {
      const note = val.note?.trim() ?? "";
      if (note.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Enabling an autonomy flag requires a sign-off note",
          path: ["note"],
        });
      }
    }
  });

export type FlipFlagInput = z.input<typeof flipFlagInputSchema>;

export type FlipFlagBlockReason =
  | {
      kind: "canary_review_missing";
      detail: string;
    }
  | {
      kind: "canary_review_unresolved";
      reviewQueueId: string;
      status: string;
    }
  | {
      kind: "linkage_metrics_below_threshold";
      metrics: LinkageMetrics;
      thresholds: typeof LINKAGE_THRESHOLDS;
    }
  | {
      kind: "linkage_metrics_unavailable";
      detail: string;
    }
  | {
      kind: "workspace_emergency_paused";
      pausedAt: string | null;
      reason: string | null;
    };

export type FlipFlagResult =
  | {
      ok: true;
      flag: FlipFlagName;
      enabled: boolean;
      previousValue: boolean;
    }
  | {
      ok: false;
      flag: FlipFlagName;
      block: FlipFlagBlockReason;
    };

export interface LinkageMetrics {
  total_canonical_variants: number;
  variants_with_bandcamp_mapping: number;
  variants_with_verified_bandcamp_url: number;
  variants_with_option_evidence: number;
  linkage_rate: number;
  verified_rate: number;
  option_rate: number;
}

/**
 * Query the canary review queue row for the caller's workspace. Returns
 * either the resolved row (ok), the open row (unresolved), or absent
 * (missing). The caller uses this to emit a typed block reason.
 */
async function readCanaryReviewQueueRow(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
): Promise<
  | { kind: "resolved"; id: string; resolvedAt: string }
  | { kind: "unresolved"; id: string; status: string }
  | { kind: "missing" }
  | { kind: "error"; detail: string }
> {
  const { data, error } = await supabase
    .from("warehouse_review_queue")
    .select("id, status, resolved_at")
    .eq("workspace_id", workspaceId)
    .eq("category", CANARY_REVIEW_CATEGORY)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) return { kind: "error", detail: error.message };

  const rows = (data ?? []) as Array<{
    id: string;
    status: string;
    resolved_at: string | null;
  }>;

  if (rows.length === 0) return { kind: "missing" };

  const row = rows[0];
  if (row && row.status === "resolved" && row.resolved_at) {
    return { kind: "resolved", id: row.id, resolvedAt: row.resolved_at };
  }

  if (row) {
    return { kind: "unresolved", id: row.id, status: row.status };
  }
  return { kind: "missing" };
}

async function readBandcampLinkageMetrics(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
  orgId: string,
): Promise<{ kind: "ok"; metrics: LinkageMetrics } | { kind: "error"; detail: string }> {
  const { data, error } = await supabase.rpc("compute_bandcamp_linkage_metrics", {
    p_workspace_id: workspaceId,
    p_org_id: orgId,
  });
  if (error) return { kind: "error", detail: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { kind: "error", detail: "no_linkage_metrics_returned" };
  return { kind: "ok", metrics: row as LinkageMetrics };
}

async function readWorkspaceOrg(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
): Promise<{
  orgId: string | null;
  emergencyPaused: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
} | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select(
      "org_id, flags, sku_autonomous_emergency_paused, sku_autonomous_emergency_paused_at, sku_autonomous_emergency_paused_reason",
    )
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    org_id: string | null;
    sku_autonomous_emergency_paused: boolean | null;
    sku_autonomous_emergency_paused_at: string | null;
    sku_autonomous_emergency_paused_reason: string | null;
  };
  return {
    orgId: row.org_id,
    emergencyPaused: row.sku_autonomous_emergency_paused === true,
    pausedAt: row.sku_autonomous_emergency_paused_at,
    pausedReason: row.sku_autonomous_emergency_paused_reason,
  };
}

/**
 * Flip an autonomous-matching feature flag. Enforces SKU-AUTO-19
 * (canary review must be resolved) and the Phase 7 linkage thresholds
 * for `sku_live_alias_autonomy_enabled`.
 *
 * Rolling OFF a flag never checks the canary review or linkage metrics —
 * the off-flip is the emergency-rollback path and must remain fast.
 *
 * If any gate fails the action returns `{ ok: false, block }` without
 * writing anything; the UI inspects `block.kind` to route the operator
 * to the relevant review queue row or linkage metrics report.
 */
export async function flipAutonomousMatchingFlag(rawInput: FlipFlagInput): Promise<FlipFlagResult> {
  const { workspaceId, userId } = await requireStaff();
  const input = flipFlagInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  const currentFlags = await getWorkspaceFlags(workspaceId);
  const previousValue = currentFlags[input.flag] === true;

  if (input.enabled) {
    // Canary gate
    if ((CANARY_GATED_FLAGS as readonly string[]).includes(input.flag)) {
      const review = await readCanaryReviewQueueRow(supabase, workspaceId);
      if (review.kind === "error") {
        return {
          ok: false,
          flag: input.flag,
          block: {
            kind: "canary_review_missing",
            detail: `review queue read failed: ${review.detail}`,
          },
        };
      }
      if (review.kind === "missing") {
        return {
          ok: false,
          flag: input.flag,
          block: {
            kind: "canary_review_missing",
            detail: `No warehouse_review_queue row with category=${CANARY_REVIEW_CATEGORY} exists for this workspace`,
          },
        };
      }
      if (review.kind === "unresolved") {
        return {
          ok: false,
          flag: input.flag,
          block: {
            kind: "canary_review_unresolved",
            reviewQueueId: review.id,
            status: review.status,
          },
        };
      }
    }

    // Phase 7 linkage gate (live-alias only)
    if ((LINKAGE_GATED_FLAGS as readonly string[]).includes(input.flag)) {
      const workspace = await readWorkspaceOrg(supabase, workspaceId);
      if (!workspace || !workspace.orgId) {
        return {
          ok: false,
          flag: input.flag,
          block: {
            kind: "linkage_metrics_unavailable",
            detail: "workspace org_id not found",
          },
        };
      }

      // Hard-block enabling autonomous writes on an emergency-paused
      // workspace. Rollbacks (off-flips) are still allowed — this only
      // fires on `enabled === true`.
      if (workspace.emergencyPaused) {
        return {
          ok: false,
          flag: input.flag,
          block: {
            kind: "workspace_emergency_paused",
            pausedAt: workspace.pausedAt,
            reason: workspace.pausedReason,
          },
        };
      }

      const linkage = await readBandcampLinkageMetrics(supabase, workspaceId, workspace.orgId);
      if (linkage.kind === "error") {
        return {
          ok: false,
          flag: input.flag,
          block: { kind: "linkage_metrics_unavailable", detail: linkage.detail },
        };
      }

      const { metrics } = linkage;
      if (
        metrics.linkage_rate < LINKAGE_THRESHOLDS.linkage_rate ||
        metrics.verified_rate < LINKAGE_THRESHOLDS.verified_rate ||
        metrics.option_rate < LINKAGE_THRESHOLDS.option_rate
      ) {
        return {
          ok: false,
          flag: input.flag,
          block: {
            kind: "linkage_metrics_below_threshold",
            metrics,
            thresholds: LINKAGE_THRESHOLDS,
          },
        };
      }
    }
  }

  // All gates cleared (or we're turning OFF). Write the flag.
  const nextFlags: WorkspaceFlags = { ...currentFlags, [input.flag]: input.enabled };

  const { error: updErr } = await supabase
    .from("workspaces")
    .update({ flags: nextFlags })
    .eq("id", workspaceId);
  if (updErr) {
    throw new Error(`flipAutonomousMatchingFlag update failed: ${updErr.message}`);
  }

  invalidateWorkspaceFlags(workspaceId);

  // Audit trail — best-effort. If the audit insert fails we still
  // return success on the flag flip (the DB is the source of truth and
  // the flag change already landed). A failing audit is itself surfaced
  // through the review queue by ops monitoring.
  await supabase
    .from("warehouse_review_queue")
    .insert({
      workspace_id: workspaceId,
      category: "sku_autonomous_flag_flip_audit",
      severity: "low",
      title: `Flag ${input.flag} → ${input.enabled ? "ON" : "OFF"}`,
      description: input.note ?? null,
      status: "resolved",
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
      metadata: {
        flag: input.flag,
        previous_value: previousValue,
        new_value: input.enabled,
        note: input.note ?? null,
      },
    })
    .then(
      () => undefined,
      () => undefined,
    );

  revalidatePath("/admin/settings/sku-matching");
  revalidatePath("/admin/settings/feature-flags");

  return {
    ok: true,
    flag: input.flag,
    enabled: input.enabled,
    previousValue,
  };
}

// NOTE: Do not re-export constants, types-with-runtime-values, or
// non-async functions from this file. Next.js RSC validates every
// export of a `"use server"` module at build time and rejects anything
// other than async functions (see
// https://nextjs.org/docs/messages/invalid-use-server-value). The
// Phase 7 rollout page (`/admin/settings/sku-matching/rollout`) reads
// FLIP_FLAG_NAMES / CANARY_GATED_FLAGS / LINKAGE_GATED_FLAGS /
// LINKAGE_THRESHOLDS through a non-"use server" shim — see
// `src/lib/shared/sku-autonomous-flags.ts` — never through this file.
