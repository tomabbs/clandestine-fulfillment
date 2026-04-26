/**
 * Autonomous SKU matcher — alias promotion wrapper.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Shadow-to-live promotion criteria" (Paths A/B/C) +
 *       §"Autonomous decision audit" (sku_autonomous_decisions) +
 *       §"Stock stability gate" +
 *       release gate SKU-AUTO-8.
 *
 * Scope:
 *   This module is the ONE TS-side entry point for turning an
 *   `auto_database_identity_match` into an `auto_live_inventory_alias`.
 *   Manual staff approval, the daily `sku-shadow-promotion` task, and
 *   any other caller MUST go through `promoteIdentityMatchToAlias()`.
 *   Directly calling the underlying `promote_identity_match_to_alias`
 *   RPC bypasses Path A/B/C policy, emergency-pause, workspace-flag,
 *   and stock-stability gates and will silently defeat SKU-AUTO-8.
 *
 *   The DB function still enforces the narrower invariant set
 *   (pg_advisory_xact_lock, state_version OCC, ATP > 0 re-check,
 *   scope match, cutover/connection status check, Shopify
 *   remote_inventory_item_id presence, `sku_outcome_transitions` row)
 *   as defense-in-depth.
 *
 *   This wrapper is in-process-only. It does NOT enqueue Trigger jobs.
 *   Inventory fanout (Bandcamp, Shopify, ShipStation v2) is handled
 *   downstream by the existing fanout pipeline once the alias row is
 *   visible in `client_store_sku_mappings` — no fanout writes happen
 *   here.
 *
 * Path policy (SKU-AUTO-8):
 *
 *   Path A — new strong evidence.
 *     Acceptable reason codes:
 *       * exact_barcode_match
 *       * exact_sku_match
 *       * verified_bandcamp_option
 *       * stock_positive_promotion  (from a confirmed order-history
 *         match; the caller has already validated the evidence)
 *     Stock stability gate: REQUIRED (4–6h identical warehouse ATP).
 *     Workspace flag gate: REQUIRED
 *       (workspaces.flags.sku_live_alias_autonomy_enabled = true).
 *
 *   Path B — stability over time.
 *     Acceptable reason code: shadow_stability_window_passed.
 *     (stock_positive_promotion is also allowed for legacy callers
 *     rolling Path A-style stock triggers through a stability-validated
 *     entry point.)
 *     Stock stability gate: REQUIRED.
 *     Workspace flag gate: REQUIRED.
 *
 *   Path C — human approval (always available).
 *     Acceptable reason code: human_override.
 *     Stock stability gate: SKIPPED (a human explicitly signed off).
 *     Workspace flag gate: SKIPPED (a human can force-promote before
 *     canary rollout is live; this is intentional — staff may need to
 *     unblock edge cases during the phase 0–6 window).
 *
 * Emergency-pause kill switch:
 *   `workspaces.sku_autonomous_emergency_paused = true` blocks ALL
 *   three paths, including Path C, because emergency pause is the
 *   operator's "stop the world" lever. Staff with a human reason to
 *   promote during an emergency must first reset the kill switch.
 *
 * Decision row (SKU-AUTO-8 + SKU-AUTO-18):
 *   Every successful promotion writes exactly one
 *   `sku_autonomous_decisions` row (outcome_state =
 *   'auto_live_inventory_alias', outcome_changed = true). The caller
 *   MUST supply an open `sku_autonomous_runs.id` — the wrapper refuses
 *   to fabricate a run context because dry-run vs live-run bookkeeping
 *   lives with the orchestrator, not this function.
 */

import type { ReasonCode } from "@/lib/server/sku-outcome-transitions";
import type { StockHistoryReadings, StockSignal } from "@/lib/server/stock-reliability";
import { isStockStableFor } from "@/lib/server/stock-reliability";

/**
 * Promotion paths per plan §"Shadow-to-live promotion criteria".
 * `'A'` = new strong evidence, `'B'` = stability window, `'C'` = human.
 */
export type PromotionPath = "A" | "B" | "C";

/**
 * ReasonCode subset accepted by the promotion wrapper. Callers may not
 * pass arbitrary ReasonCodes — only those that are semantically valid
 * for a shadow → live transition via one of the three documented paths.
 */
export type PromotionReasonCode = Extract<
  ReasonCode,
  | "exact_barcode_match"
  | "exact_sku_match"
  | "verified_bandcamp_option"
  | "stock_positive_promotion"
  | "shadow_stability_window_passed"
  | "human_override"
>;

/**
 * Structured input for a single promotion attempt.
 *   * `runId` must reference an open, live (NOT dry_run) row in
 *     `sku_autonomous_runs`. Dry-run runs MUST NOT promote — the
 *     caller enforces this; the wrapper documents the contract.
 *   * `expectedStateVersion` is the row's state_version read by the
 *     caller. The RPC fails `stale_state_version` if anyone else has
 *     touched the row in the meantime.
 *   * `stockEvidence` is REQUIRED for paths A and B. For path C, it
 *     may be omitted. Providing it on path C is legal but ignored.
 *   * `evidenceSnapshot` + `evidenceHash` are persisted on the
 *     decision row unchanged; the wrapper does not reinterpret them.
 */
export interface PromoteIdentityMatchToAliasInput {
  workspaceId: string;
  connectionId: string;
  runId: string;
  identityMatchId: string;
  variantId: string | null;
  expectedStateVersion: number;
  path: PromotionPath;
  reasonCode: PromotionReasonCode;
  triggeredBy: string;
  evidenceSnapshot?: Record<string, unknown>;
  evidenceHash?: string | null;
  stockEvidence?: {
    signal: StockSignal;
    history: StockHistoryReadings;
  };
  /**
   * Previous outcome state for the decision row's `previous_outcome_state`.
   * Defaults to `"auto_database_identity_match"` (the only legal source
   * state for this transition). Exposed so the audit trail can record
   * an unusual source state if the caller is rehydrating a historical
   * row.
   */
  previousOutcomeState?: "auto_database_identity_match";
}

/**
 * Typed failure reasons. Callers branch on these without string-parsing
 * error messages.
 */
export type PromoteIdentityMatchErrorReason =
  | "workspace_read_failed"
  | "emergency_paused"
  | "autonomy_flag_disabled"
  | "invalid_path_reason_pair"
  | "missing_stock_evidence"
  | "stock_unstable"
  | "rpc_error"
  | "state_version_drift"
  | "identity_match_not_found"
  | "identity_match_not_promotable"
  | "no_canonical_variant"
  | "connection_not_eligible"
  | "scope_mismatch"
  | "atp_not_positive"
  | "shopify_remote_item_missing"
  | "unexpected_response_shape"
  | "decision_insert_failed";

export type PromoteIdentityMatchResult =
  | { ok: true; aliasId: string; decisionId: string }
  | { ok: false; reason: PromoteIdentityMatchErrorReason; detail?: string };

/**
 * Structural subset of supabase-js that the wrapper actually depends
 * on. Narrow enough that tests can mock it with plain objects; broad
 * enough to cover the three operations we perform:
 *   1. `rpc('promote_identity_match_to_alias', …)` — promotion.
 *   2. `from('workspaces').select(…).eq(…).maybeSingle()` — emergency
 *      pause + flag read.
 *   3. `from('sku_autonomous_decisions').insert([…]).select(…).single()`
 *      — decision row write.
 *
 * Using a structural subset (instead of `SupabaseClient<Database>`)
 * keeps this module decoupled from the generated Database types, which
 * this project does not currently import centrally.
 */
export interface PromotionSupabaseClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;

  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    insert(rows: Record<string, unknown>[]): {
      select(cols: string): {
        single(): PromiseLike<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/**
 * Pure predicate: is the `(path, reasonCode)` pair allowed?
 * Exported for unit testing and for callers that want to validate
 * before assembling the rest of the input.
 */
export function isPathReasonPairValid(
  path: PromotionPath,
  reasonCode: PromotionReasonCode,
): boolean {
  switch (path) {
    case "A":
      return (
        reasonCode === "exact_barcode_match" ||
        reasonCode === "exact_sku_match" ||
        reasonCode === "verified_bandcamp_option" ||
        reasonCode === "stock_positive_promotion"
      );
    case "B":
      return (
        reasonCode === "shadow_stability_window_passed" || reasonCode === "stock_positive_promotion"
      );
    case "C":
      return reasonCode === "human_override";
    default:
      return false;
  }
}

/**
 * Map a Postgres exception from `promote_identity_match_to_alias` to a
 * typed error reason. Matching is deliberately tolerant of the prefix
 * so a Supabase wrap of the message does not silently regress.
 */
function mapRpcErrorToReason(message: string): PromoteIdentityMatchErrorReason {
  if (/state_version drift/i.test(message)) return "state_version_drift";
  if (/not found/i.test(message)) return "identity_match_not_found";
  if (/not in promotable state/i.test(message)) return "identity_match_not_promotable";
  if (/no canonical variant/i.test(message)) return "no_canonical_variant";
  if (/connection .* not eligible/i.test(message)) return "connection_not_eligible";
  if (/scope mismatch/i.test(message)) return "scope_mismatch";
  if (/ATP not positive/i.test(message)) return "atp_not_positive";
  if (/missing remote_inventory_item_id/i.test(message)) return "shopify_remote_item_missing";
  return "rpc_error";
}

/**
 * Promote an identity match to a live inventory alias.
 *
 * Order of enforcement (each stage vetos; no retry):
 *   1. Path/reason pair validated.
 *   2. Workspace guard row read (emergency pause + flag).
 *   3. Emergency pause → emergency_paused (blocks all paths).
 *   4. Flag gate (paths A + B only) → autonomy_flag_disabled.
 *   5. Stock-stability gate (paths A + B only) →
 *      stock_unstable | missing_stock_evidence.
 *   6. RPC call. RPC errors are mapped to typed reasons.
 *   7. Decision-row insert. If this step fails the alias is ALREADY
 *      live (the RPC committed); the wrapper surfaces
 *      `decision_insert_failed` so the caller can create a
 *      `warehouse_review_queue` item to backfill the audit trail.
 *      The alias is NOT rolled back — partial audit loss is preferred
 *      over data loss because the `sku_outcome_transitions` row
 *      written by the RPC still captures the truth.
 */
export async function promoteIdentityMatchToAlias(
  supabase: PromotionSupabaseClient,
  input: PromoteIdentityMatchToAliasInput,
): Promise<PromoteIdentityMatchResult> {
  if (!isPathReasonPairValid(input.path, input.reasonCode)) {
    return { ok: false, reason: "invalid_path_reason_pair" };
  }

  const guardRead = await supabase
    .from("workspaces")
    .select("flags, sku_autonomous_emergency_paused")
    .eq("id", input.workspaceId)
    .maybeSingle();

  if (guardRead.error) {
    return {
      ok: false,
      reason: "workspace_read_failed",
      detail: guardRead.error.message,
    };
  }
  if (!guardRead.data) {
    return { ok: false, reason: "workspace_read_failed", detail: "workspace_not_found" };
  }

  const emergencyPaused = guardRead.data.sku_autonomous_emergency_paused === true;
  if (emergencyPaused) {
    return { ok: false, reason: "emergency_paused" };
  }

  const flags = (guardRead.data.flags ?? {}) as {
    sku_live_alias_autonomy_enabled?: boolean;
  };
  const aliasAutonomyEnabled = flags.sku_live_alias_autonomy_enabled === true;

  if (input.path !== "C") {
    if (!aliasAutonomyEnabled) {
      return { ok: false, reason: "autonomy_flag_disabled" };
    }
    if (!input.stockEvidence) {
      return { ok: false, reason: "missing_stock_evidence" };
    }
    if (!isStockStableFor("promotion", input.stockEvidence.signal, input.stockEvidence.history)) {
      return { ok: false, reason: "stock_unstable" };
    }
  }

  const rpcResult = await supabase.rpc("promote_identity_match_to_alias", {
    p_identity_match_id: input.identityMatchId,
    p_expected_state_version: input.expectedStateVersion,
    p_reason_code: input.reasonCode,
    p_triggered_by: input.triggeredBy,
  });

  if (rpcResult.error) {
    return {
      ok: false,
      reason: mapRpcErrorToReason(rpcResult.error.message),
      detail: rpcResult.error.message,
    };
  }

  const aliasId = extractAliasId(rpcResult.data);
  if (!aliasId) {
    return { ok: false, reason: "unexpected_response_shape" };
  }

  const decisionInsert = await supabase
    .from("sku_autonomous_decisions")
    .insert([
      {
        run_id: input.runId,
        workspace_id: input.workspaceId,
        connection_id: input.connectionId,
        variant_id: input.variantId,
        outcome_state: "auto_live_inventory_alias",
        previous_outcome_state: input.previousOutcomeState ?? "auto_database_identity_match",
        outcome_changed: true,
        match_method: null,
        match_confidence: null,
        reason_code: input.reasonCode,
        evidence_snapshot: input.evidenceSnapshot ?? {},
        evidence_hash: input.evidenceHash ?? null,
        disqualifiers: [],
        top_candidates: [],
        fetch_status: null,
        fetch_completed_at: null,
        fetch_duration_ms: null,
        alias_id: aliasId,
        identity_match_id: input.identityMatchId,
        transition_id: null,
      },
    ])
    .select("id")
    .single();

  if (decisionInsert.error || !decisionInsert.data) {
    return {
      ok: false,
      reason: "decision_insert_failed",
      detail: decisionInsert.error?.message ?? "no data returned",
    };
  }

  const decisionId = decisionInsert.data.id;
  if (typeof decisionId !== "string") {
    return { ok: false, reason: "unexpected_response_shape" };
  }

  return { ok: true, aliasId, decisionId };
}

/**
 * `promote_identity_match_to_alias` returns a single `uuid` value. In
 * PostgREST this surfaces as either the bare string or a one-element
 * array of strings depending on version / RPC declaration form. The
 * helper normalises both shapes.
 */
function extractAliasId(data: unknown): string | null {
  if (typeof data === "string" && data.length > 0) return data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "string" && first.length > 0) return first;
    if (first && typeof first === "object" && "promote_identity_match_to_alias" in first) {
      const v = (first as Record<string, unknown>).promote_identity_match_to_alias;
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  if (data && typeof data === "object") {
    const maybe = (data as Record<string, unknown>).promote_identity_match_to_alias;
    if (typeof maybe === "string" && maybe.length > 0) return maybe;
  }
  return null;
}
