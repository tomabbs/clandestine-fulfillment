"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import { requireStaff } from "@/lib/server/auth-context";
import type { TelemetryReasonCode, TelemetrySummary } from "@/lib/server/sku-autonomous-telemetry";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { invalidateWorkspaceFlags, type WorkspaceFlags } from "@/lib/server/workspace-flags";

// ─────────────────────────────────────────────────────────────────────
// Phase 7 — Slice 7.C: rollout Server Actions.
//
// These power the staff rollout page at
// `/admin/settings/sku-matching/rollout` (Slice 7.D). They sit next to
// the existing `flipAutonomousMatchingFlag` action in
// `sku-autonomous-canary.ts` but are deliberately split into a
// separate file so the rollout page has exactly one import surface for
// "read the rollout state" (`getAutonomousRolloutHealth`) and
// "manipulate the canary review" (create / resolve).
//
// Contract:
//   * STAFF-ONLY. Every export starts with `await requireStaff()`.
//   * WORKSPACE-SCOPED. Every query is `eq('workspace_id', ...)` so a
//     leaked service-role grant can never fan across workspaces.
//   * NO AUTONOMOUS SIDE EFFECTS. These actions read or write
//     observability / review-queue rows only; they never flip a flag
//     (that's `flipAutonomousMatchingFlag`) or write to identity
//     rows / aliases / inventory.
//   * IDEMPOTENCY. `createAutonomousCanaryReview` writes a fresh row
//     per call (there is no `group_key` dedup for canary reviews —
//     the operator explicitly opens a new review when starting a new
//     sign-off cycle). `resolveAutonomousCanaryReview` is a no-op on
//     an already-resolved row (returns `{ ok: true, alreadyResolved:
//     true }`).
//   * REVALIDATION. Every write revalidates
//     `/admin/settings/sku-matching/rollout` so the page reflects the
//     new state immediately; the feature-flags page is also
//     revalidated because the canary state gates flag flips.
//
// Doc sync: these action names are added to
// `docs/system_map/API_CATALOG.md` in Slice 7.E.
// ─────────────────────────────────────────────────────────────────────

const CANARY_REVIEW_CATEGORY = "sku_autonomous_canary_review";
const TELEMETRY_SENSOR_NAME = "sku_autonomous.telemetry";

// Mirrored from `sku-autonomous-canary.ts` — deliberate duplication to
// keep that file's RSC-safe export list as narrow as possible. If a
// third consumer appears, we'll move these constants into
// `src/lib/shared/sku-autonomous-flags.ts` (non-"use server") per the
// note at the bottom of `sku-autonomous-canary.ts`.
const LINKAGE_THRESHOLDS = {
  linkage_rate: 0.7,
  verified_rate: 0.6,
  option_rate: 0.4,
} as const;

// ─────────────────────────────────────────────────────────────────────
// getAutonomousRolloutHealth — read model consumed by the rollout page
// ─────────────────────────────────────────────────────────────────────

export interface LinkageMetrics {
  total_canonical_variants: number;
  variants_with_bandcamp_mapping: number;
  variants_with_verified_bandcamp_url: number;
  variants_with_option_evidence: number;
  linkage_rate: number;
  verified_rate: number;
  option_rate: number;
}

export interface RolloutFlagsView {
  sku_identity_autonomy_enabled: boolean;
  sku_live_alias_autonomy_enabled: boolean;
  sku_autonomous_ui_enabled: boolean;
  non_warehouse_order_hold_enabled: boolean;
  non_warehouse_order_client_alerts_enabled: boolean;
  client_stock_exception_reports_enabled: boolean;
}

export interface EmergencyPauseView {
  paused: boolean;
  pausedAt: string | null;
  reason: string | null;
}

export type TelemetryView =
  | {
      kind: "ok";
      status: "healthy" | "warning" | "paused";
      reasons: TelemetryReasonCode[];
      recordedAt: string;
      windowDays: number;
      summary: TelemetrySummary;
      emergencyPausedAtRecord: boolean;
      truncated: { runs: boolean; decisions: boolean; transitions: boolean; hold_events: boolean };
      identityCounts: {
        shadow_candidates: number;
        stock_exception: number;
        holdout: number;
      } | null;
    }
  | { kind: "missing" }
  | { kind: "error"; detail: string };

export type CanaryReviewView =
  | {
      kind: "resolved";
      id: string;
      resolvedAt: string;
      resolvedBy: string | null;
      createdAt: string;
      title: string;
      note: string | null;
      intendedFlag: string | null;
    }
  | {
      kind: "open";
      id: string;
      status: "open" | "in_progress" | "suppressed";
      createdAt: string;
      title: string;
      note: string | null;
      intendedFlag: string | null;
    }
  | { kind: "missing" };

export type LinkageView =
  | {
      kind: "ok";
      metrics: LinkageMetrics;
      thresholds: typeof LINKAGE_THRESHOLDS;
      allClear: boolean;
    }
  | { kind: "unavailable"; detail: string };

export interface AutonomousRolloutHealth {
  workspaceId: string;
  flags: RolloutFlagsView;
  emergencyPause: EmergencyPauseView;
  telemetry: TelemetryView;
  canaryReview: CanaryReviewView;
  linkage: LinkageView;
}

/**
 * Assemble everything the rollout page needs in ONE read so the page
 * can render without client-side fanout. All fetches are scoped to the
 * caller's workspace; a failure in any single read produces a typed
 * error marker in that slot rather than throwing (the page should
 * still render with partial data — an operator diagnosing an outage
 * needs the page to LOAD more than they need every panel to be green).
 */
export async function getAutonomousRolloutHealth(): Promise<AutonomousRolloutHealth> {
  const { workspaceId } = await requireStaff();
  const supabase = await createServerSupabaseClient();

  const workspaceRow = await readWorkspaceRollupRow(supabase, workspaceId);
  const flags: RolloutFlagsView = projectFlags(workspaceRow?.flags ?? {});
  const emergencyPause: EmergencyPauseView = {
    paused: workspaceRow?.emergencyPaused === true,
    pausedAt: workspaceRow?.pausedAt ?? null,
    reason: workspaceRow?.pausedReason ?? null,
  };

  const [telemetry, canaryReview, linkage] = await Promise.all([
    readLatestTelemetry(supabase, workspaceId),
    readLatestCanaryReview(supabase, workspaceId),
    workspaceRow?.orgId
      ? readBandcampLinkageMetrics(supabase, workspaceId, workspaceRow.orgId)
      : Promise.resolve({ kind: "unavailable" as const, detail: "workspace org_id unresolved" }),
  ]);

  return {
    workspaceId,
    flags,
    emergencyPause,
    telemetry,
    canaryReview,
    linkage,
  };
}

// ─────────────────────────────────────────────────────────────────────
// createAutonomousCanaryReview — opens a fresh canary review row
// ─────────────────────────────────────────────────────────────────────

const createCanaryInputSchema = z.object({
  // Which autonomy flag this review signs off on. We don't reject
  // unknown strings here because the canary review category is the
  // source of truth for "something needs sign-off" — the specific
  // flag goes into metadata so the rollout page can render a "this
  // review is about X" header, but the existing flip gate simply
  // looks for the most recent resolved row regardless of flag. If
  // we later tighten the flip gate to match phase-for-phase, the
  // enum stays in sync without a schema migration.
  intendedFlag: z
    .enum([
      "sku_identity_autonomy_enabled",
      "sku_live_alias_autonomy_enabled",
      "non_warehouse_order_hold_enabled",
      "non_warehouse_order_client_alerts_enabled",
    ])
    .optional(),
  title: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(4000).optional(),
});

export type CreateAutonomousCanaryReviewInput = z.input<typeof createCanaryInputSchema>;

export type CreateAutonomousCanaryReviewResult =
  | { ok: true; reviewId: string; createdAt: string }
  | { ok: false; error: string };

export async function createAutonomousCanaryReview(
  rawInput: CreateAutonomousCanaryReviewInput = {},
): Promise<CreateAutonomousCanaryReviewResult> {
  const { workspaceId, userId } = await requireStaff();
  const input = createCanaryInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  const intendedFlag = input.intendedFlag ?? "sku_live_alias_autonomy_enabled";
  const title = input.title ?? titleFor(intendedFlag);

  const { data, error } = await supabase
    .from("warehouse_review_queue")
    .insert({
      workspace_id: workspaceId,
      category: CANARY_REVIEW_CATEGORY,
      severity: "high",
      title,
      description: input.note ?? null,
      status: "open",
      metadata: {
        intended_flag: intendedFlag,
        created_by: userId,
        note: input.note ?? null,
      },
    })
    .select("id, created_at")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert_returned_no_row" };
  }

  revalidatePath("/admin/settings/sku-matching/rollout");
  revalidatePath("/admin/settings/feature-flags");
  return { ok: true, reviewId: data.id as string, createdAt: data.created_at as string };
}

// ─────────────────────────────────────────────────────────────────────
// resolveAutonomousCanaryReview — marks a canary review row resolved
// ─────────────────────────────────────────────────────────────────────

const resolveCanaryInputSchema = z.object({
  reviewId: z.string().uuid(),
  resolutionNote: z.string().trim().max(4000).optional(),
});

export type ResolveAutonomousCanaryReviewInput = z.input<typeof resolveCanaryInputSchema>;

export type ResolveAutonomousCanaryReviewResult =
  | { ok: true; reviewId: string; alreadyResolved: boolean; resolvedAt: string }
  | { ok: false; error: string };

export async function resolveAutonomousCanaryReview(
  rawInput: ResolveAutonomousCanaryReviewInput,
): Promise<ResolveAutonomousCanaryReviewResult> {
  const { workspaceId, userId } = await requireStaff();
  const input = resolveCanaryInputSchema.parse(rawInput);
  const supabase = await createServerSupabaseClient();

  // Read first to enforce workspace ownership + detect already-resolved.
  // We could do this in a single conditional update but the read gives
  // us a better error message when the row doesn't exist or belongs to
  // another workspace.
  const { data: existing, error: readErr } = await supabase
    .from("warehouse_review_queue")
    .select("id, workspace_id, status, resolved_at, category, metadata")
    .eq("id", input.reviewId)
    .eq("workspace_id", workspaceId)
    .eq("category", CANARY_REVIEW_CATEGORY)
    .maybeSingle();

  if (readErr) return { ok: false, error: `review read failed: ${readErr.message}` };
  if (!existing) {
    return {
      ok: false,
      error: "canary review not found for this workspace (may belong to another workspace)",
    };
  }

  if (existing.status === "resolved" && existing.resolved_at) {
    return {
      ok: true,
      reviewId: existing.id as string,
      alreadyResolved: true,
      resolvedAt: existing.resolved_at as string,
    };
  }

  const now = new Date().toISOString();
  const priorMetadata = (existing.metadata as Record<string, unknown> | null) ?? {};

  const { error: updErr } = await supabase
    .from("warehouse_review_queue")
    .update({
      status: "resolved",
      resolved_at: now,
      resolved_by: userId,
      metadata: {
        ...priorMetadata,
        resolution_note: input.resolutionNote ?? null,
        resolved_by_user: userId,
      },
    })
    .eq("id", input.reviewId)
    .eq("workspace_id", workspaceId);

  if (updErr) return { ok: false, error: `review update failed: ${updErr.message}` };

  revalidatePath("/admin/settings/sku-matching/rollout");
  revalidatePath("/admin/settings/feature-flags");
  // The flag-flip action caches flags in-process; the canary gate
  // itself reads the review queue on every call so no cache to bust,
  // but invalidate the flag cache defensively in case any other path
  // memoized state.
  invalidateWorkspaceFlags(workspaceId);

  return { ok: true, reviewId: existing.id as string, alreadyResolved: false, resolvedAt: now };
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers (NOT exported — Rule RSC export constraint)
// ─────────────────────────────────────────────────────────────────────

async function readWorkspaceRollupRow(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
): Promise<
  | {
      orgId: string | null;
      flags: WorkspaceFlags;
      emergencyPaused: boolean;
      pausedAt: string | null;
      pausedReason: string | null;
    }
  | undefined
> {
  const { data, error } = await supabase
    .from("workspaces")
    .select(
      "org_id, flags, sku_autonomous_emergency_paused, sku_autonomous_emergency_paused_at, sku_autonomous_emergency_paused_reason",
    )
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !data) return undefined;
  const row = data as {
    org_id: string | null;
    flags: WorkspaceFlags | null;
    sku_autonomous_emergency_paused: boolean | null;
    sku_autonomous_emergency_paused_at: string | null;
    sku_autonomous_emergency_paused_reason: string | null;
  };
  return {
    orgId: row.org_id,
    flags: (row.flags ?? {}) as WorkspaceFlags,
    emergencyPaused: row.sku_autonomous_emergency_paused === true,
    pausedAt: row.sku_autonomous_emergency_paused_at,
    pausedReason: row.sku_autonomous_emergency_paused_reason,
  };
}

function projectFlags(flags: WorkspaceFlags): RolloutFlagsView {
  return {
    sku_identity_autonomy_enabled: flags.sku_identity_autonomy_enabled === true,
    sku_live_alias_autonomy_enabled: flags.sku_live_alias_autonomy_enabled === true,
    sku_autonomous_ui_enabled: flags.sku_autonomous_ui_enabled === true,
    non_warehouse_order_hold_enabled: flags.non_warehouse_order_hold_enabled === true,
    non_warehouse_order_client_alerts_enabled:
      flags.non_warehouse_order_client_alerts_enabled === true,
    client_stock_exception_reports_enabled: flags.client_stock_exception_reports_enabled === true,
  };
}

async function readLatestTelemetry(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
): Promise<TelemetryView> {
  const { data, error } = await supabase
    .from("sensor_readings")
    .select("status, value, created_at, message")
    .eq("workspace_id", workspaceId)
    .eq("sensor_name", TELEMETRY_SENSOR_NAME)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return { kind: "error", detail: error.message };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { kind: "missing" };

  const value = (row.value as Record<string, unknown> | null) ?? {};
  const summary = (value.summary as TelemetrySummary | undefined) ?? null;
  const identityCounts =
    (value.identity_counts as TelemetryView extends { identityCounts: infer I } ? I : never) ??
    null;
  const truncated =
    (value.truncated as {
      runs?: boolean;
      decisions?: boolean;
      transitions?: boolean;
      hold_events?: boolean;
    } | null) ?? null;

  if (!summary) {
    return { kind: "error", detail: "telemetry row missing `summary` payload" };
  }

  return {
    kind: "ok",
    status: row.status as "healthy" | "warning" | "paused",
    reasons: (summary.reasons as TelemetryReasonCode[] | undefined) ?? [],
    recordedAt: row.created_at as string,
    windowDays: summary.windowDays,
    summary,
    emergencyPausedAtRecord: value.emergency_paused === true,
    truncated: {
      runs: truncated?.runs === true,
      decisions: truncated?.decisions === true,
      transitions: truncated?.transitions === true,
      hold_events: truncated?.hold_events === true,
    },
    identityCounts,
  };
}

async function readLatestCanaryReview(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
): Promise<CanaryReviewView> {
  const { data, error } = await supabase
    .from("warehouse_review_queue")
    .select("id, status, resolved_at, resolved_by, title, description, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("category", CANARY_REVIEW_CATEGORY)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return { kind: "missing" };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { kind: "missing" };

  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  const intendedFlag =
    typeof metadata.intended_flag === "string" ? (metadata.intended_flag as string) : null;
  const note = typeof row.description === "string" ? row.description : null;

  if (row.status === "resolved" && row.resolved_at) {
    return {
      kind: "resolved",
      id: row.id as string,
      resolvedAt: row.resolved_at as string,
      resolvedBy: (row.resolved_by as string | null) ?? null,
      createdAt: row.created_at as string,
      title: (row.title as string) ?? "",
      note,
      intendedFlag,
    };
  }
  return {
    kind: "open",
    id: row.id as string,
    status: (row.status as "open" | "in_progress" | "suppressed") ?? "open",
    createdAt: row.created_at as string,
    title: (row.title as string) ?? "",
    note,
    intendedFlag,
  };
}

async function readBandcampLinkageMetrics(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
  orgId: string,
): Promise<LinkageView> {
  const { data, error } = await supabase.rpc("compute_bandcamp_linkage_metrics", {
    p_workspace_id: workspaceId,
    p_org_id: orgId,
  });
  if (error) return { kind: "unavailable", detail: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { kind: "unavailable", detail: "no_linkage_metrics_returned" };
  const metrics = row as LinkageMetrics;
  const allClear =
    metrics.linkage_rate >= LINKAGE_THRESHOLDS.linkage_rate &&
    metrics.verified_rate >= LINKAGE_THRESHOLDS.verified_rate &&
    metrics.option_rate >= LINKAGE_THRESHOLDS.option_rate;
  return { kind: "ok", metrics, thresholds: LINKAGE_THRESHOLDS, allClear };
}

function titleFor(intendedFlag: string): string {
  switch (intendedFlag) {
    case "sku_identity_autonomy_enabled":
      return "Canary sign-off — enable Phase 2 identity autonomy";
    case "sku_live_alias_autonomy_enabled":
      return "Canary sign-off — enable Phase 7 live-alias autonomy";
    case "non_warehouse_order_hold_enabled":
      return "Canary sign-off — enable Phase 4 order holds";
    case "non_warehouse_order_client_alerts_enabled":
      return "Canary sign-off — enable Phase 5 client alerts";
    default:
      return "Canary sign-off required";
  }
}

// NOTE: Do not re-export constants, types-with-runtime-values, or
// non-async functions from this file. Next.js RSC validates every
// export of a `"use server"` module at build time and rejects anything
// other than async functions (see
// https://nextjs.org/docs/messages/invalid-use-server-value). The
// `LINKAGE_THRESHOLDS` constant above is intentionally NOT exported —
// the rollout page reads the thresholds back through the `linkage.kind
// === 'ok'` view where they're embedded as data, and any non-async
// sharing lives in `src/lib/shared/sku-autonomous-flags.ts` (non-"use
// server") when Phase 7.D needs it.
