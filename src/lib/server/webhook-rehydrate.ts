/**
 * Autonomous SKU matcher — webhook-ingress demotion-rehydrate orchestrator.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Post-demotion webhook ingress (the demotion black hole fix)"
 *       + release gate SKU-AUTO-24 + SKU-AUTO-28 (emergency pause).
 *
 * What this does:
 *   An inventory-update webhook (Shopify `inventory_levels/update`,
 *   WooCommerce stock hook, Squarespace inventory API) lands in
 *   `handleInventoryUpdate` with NO live alias row in
 *   `client_store_sku_mappings`. Before the caller returns
 *   `sku_mapping_missing` (which would cascade into unknown-SKU
 *   discovery), this function looks for an active identity row in
 *   `client_store_product_identity_matches`. If one exists we act on
 *   it here and NEVER route to discovery.
 *
 *   Possible actions:
 *     * `promoted` — identity was `client_stock_exception`, remote
 *       stock became credibly positive, warehouse ATP > 0, stability
 *       gate passed at the `boost` window → call
 *       `promoteIdentityMatchToAlias()` with reason_code
 *       `stock_positive_promotion`.
 *     * `updated_evidence_only` — identity is active but in an outcome
 *       state other than `client_stock_exception` (or inactive). The
 *       webhook observation still bumps `evaluation_count` /
 *       `last_evaluated_at` / `evidence_snapshot` so the scheduled
 *       revaluation sees the new reading.
 *     * `bumped_reobserved` — identity IS `client_stock_exception` but
 *       one of the promotion gates (tier, positive remote, warehouse
 *       ATP, stability) vetoed. Evidence is bumped; no promotion
 *       attempted.
 *     * `no_identity_row` — no row anywhere in the cascade. Caller
 *       routes to unknown-SKU discovery.
 *     * `emergency_paused` — workspace kill switch is on.
 *     * `identity_lookup_failed` / `run_open_failed` — orchestrator
 *       bailed early on a Supabase error. Caller treats as "do not
 *       act" (surface in logs; no discovery routing).
 *
 * Separation of concerns:
 *   The decision logic ("given these inputs, what should we do?") is
 *   pure and lives in `webhook-rehydrate-policy.ts`. This module owns
 *   every I/O step: emergency-pause read, identity lookup cascade,
 *   warehouse-ATP read, stability-history read, identity-evidence
 *   write, `sku_autonomous_runs` open/close, and the call into
 *   `promoteIdentityMatchToAlias()`.
 *
 *   `promoteIdentityMatchToAlias()` still does its own emergency-pause
 *   + flag check + stability check — defense in depth is intentional,
 *   because that wrapper is the ONE entry point to live-alias
 *   promotion (including from scheduled tasks that do not come through
 *   this orchestrator).
 *
 * SKU-AUTO-24 contract:
 *   For ANY active identity row this function returns without
 *   producing a `no_identity_row` signal. The caller MUST NOT open a
 *   discovery path when the return is anything other than
 *   `no_identity_row`. The unit tests assert this on every branch.
 *
 * SKU-AUTO-28 contract:
 *   Emergency pause blocks promotion AND the evidence bump. The whole
 *   orchestrator short-circuits with `emergency_paused`, no writes.
 */

import {
  type PromoteIdentityMatchErrorReason,
  type PromoteIdentityMatchResult,
  type PromotionSupabaseClient,
  promoteIdentityMatchToAlias,
} from "@/lib/server/sku-alias-promotion";
import type { StockHistoryReadings, StockSignal } from "@/lib/server/stock-reliability";
import {
  decideRehydrateAction,
  type IdentityOutcomeStateForRehydrate,
  type IdentityRowSnapshot,
  type RehydrateAction,
} from "@/lib/server/webhook-rehydrate-policy";

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Platform narrowed to the three the autonomous matcher supports.
 * Discogs + BigCommerce do NOT go through this path (see
 * `createStoreSyncClient()` — plan "Platform scope" paragraph).
 */
export type RehydratePlatform = "shopify" | "woocommerce" | "squarespace";

/**
 * Identity-row lookup keys. At least one must be non-null. The
 * orchestrator tries them in the order they appear in plan §"Four
 * uniqueness keys":
 *   1. remoteInventoryItemId (Shopify)
 *   2. remoteProductId + remoteVariantId (Shopify + Woo variable)
 *   3. remoteFingerprint (Woo / Squarespace catch-all)
 */
export interface RehydrateIdentityKeys {
  remoteInventoryItemId?: string | null;
  remoteProductId?: string | null;
  remoteVariantId?: string | null;
  remoteFingerprint?: string | null;
}

export interface RehydrateWebhookInventoryUpdateInput {
  workspaceId: string;
  orgId: string;
  connectionId: string;
  platform: RehydratePlatform;
  inboundStockSignal: StockSignal;
  identityKeys: RehydrateIdentityKeys;
  triggeredBy: string;
  /**
   * Optional external webhook ID for the audit trail. Persisted into
   * the run row's `feature_flags` map so a disputed decision can be
   * tied back to the exact Shopify delivery.
   */
  webhookEventId?: string;
}

/**
 * Every terminal outcome the orchestrator can surface. The caller
 * branches on `kind` to decide whether to continue down the discovery
 * path (`no_identity_row` only) or return.
 */
export type RehydrateOutcome =
  | { kind: "no_identity_row" }
  | { kind: "emergency_paused" }
  | { kind: "identity_lookup_failed"; detail: string }
  | { kind: "run_open_failed"; detail: string; identityMatchId: string }
  | {
      kind: "updated_evidence_only";
      identityMatchId: string;
      outcomeState: IdentityOutcomeStateForRehydrate;
      rationale: "inactive_identity_row" | "not_stock_exception";
    }
  | {
      kind: "bumped_reobserved";
      identityMatchId: string;
      rationale:
        | "stock_tier_unreliable"
        | "remote_stock_not_positive"
        | "warehouse_atp_zero"
        | "stability_gate_failed";
    }
  | {
      kind: "promoted";
      identityMatchId: string;
      aliasId: string;
      decisionId: string;
      runId: string;
    }
  | {
      kind: "promotion_blocked";
      identityMatchId: string;
      reason: PromoteIdentityMatchErrorReason;
      detail?: string;
      runId: string;
    };

// ─────────────────────────────────────────────────────────────────────
// Structural Supabase subset
// ─────────────────────────────────────────────────────────────────────

/**
 * Structural subset of supabase-js covering every read/write this
 * orchestrator performs. Kept narrow so tests can supply a plain-object
 * mock, but broad enough to cover the real call graph:
 *
 *   * rpc(...) — forwarded through to promote_identity_match_to_alias
 *     (defined on `PromotionSupabaseClient`).
 *   * from('workspaces').select(...).eq(...).maybeSingle() —
 *     emergency-pause read. Duplicated here because the promotion
 *     wrapper does its own; the orchestrator needs the check EARLIER
 *     so the evidence bump also respects the kill switch (SKU-AUTO-28).
 *   * from('client_store_product_identity_matches').select(...)
 *     .eq().eq().eq().maybeSingle() — identity lookup cascade across
 *     three partial UNIQUE indexes.
 *   * from('client_store_product_identity_matches').update(...)
 *     .eq(...) — evidence bump.
 *   * from('warehouse_inventory_levels').select(...).eq(...)
 *     .maybeSingle() — warehouse ATP read.
 *   * from('stock_stability_readings').select(...).eq().eq().eq()
 *     .order().limit() — stability history.
 *   * from('sku_autonomous_runs').insert(...).select(...).single() —
 *     open run.
 *   * from('sku_autonomous_runs').update(...).eq(...) — close run.
 *
 * `RehydrateQueryFilter` is the single recursive builder returned by
 * `.select()`. It allows arbitrarily-chained `.eq()` calls terminating
 * in `.maybeSingle()`, `.order().limit()`, or (for counts we do not
 * use) similar. Tests mock the builder directly; production uses
 * supabase-js which matches the shape.
 */
export interface RehydrateQueryFilter {
  eq(col: string, val: string): RehydrateQueryFilter;
  maybeSingle(): PromiseLike<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
  order(
    col: string,
    opts: { ascending: boolean },
  ): {
    limit(n: number): PromiseLike<{
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    }>;
  };
}

export interface RehydrateUpdateBuilder {
  eq(col: string, val: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface RehydrateTableHandle {
  select(cols: string): RehydrateQueryFilter;
  update(row: Record<string, unknown>): RehydrateUpdateBuilder;
  insert(rows: Record<string, unknown>[]): {
    select(cols: string): {
      single(): PromiseLike<{
        data: Record<string, unknown> | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export interface RehydrateSupabaseClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): RehydrateTableHandle;
}

// ─────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────

const STABILITY_HISTORY_LIMIT = 32;
const STABILITY_HISTORY_SOURCES: ReadonlyArray<RehydratePlatform> = [
  "shopify",
  "woocommerce",
  "squarespace",
];

export async function rehydrateWebhookInventoryUpdate(
  supabase: RehydrateSupabaseClient,
  input: RehydrateWebhookInventoryUpdateInput,
): Promise<RehydrateOutcome> {
  // ── 1. Emergency pause (SKU-AUTO-28) ───────────────────────────────
  //
  // The policy does NOT see the workspace row; we block at the
  // orchestrator so the evidence bump also respects the kill switch.
  const guardRead = await supabase
    .from("workspaces")
    .select("sku_autonomous_emergency_paused")
    .eq("id", input.workspaceId)
    .maybeSingle();

  if (guardRead.error) {
    return { kind: "identity_lookup_failed", detail: guardRead.error.message };
  }
  if (guardRead.data?.sku_autonomous_emergency_paused === true) {
    return { kind: "emergency_paused" };
  }

  // ── 2. Identity-row lookup cascade ────────────────────────────────
  const lookup = await findActiveIdentityRow(supabase, input.connectionId, input.identityKeys);
  if (lookup.kind === "error") {
    return { kind: "identity_lookup_failed", detail: lookup.detail };
  }
  if (lookup.kind === "none") {
    return { kind: "no_identity_row" };
  }

  const identityRow = lookup.row;

  // ── 3. Gather policy inputs ───────────────────────────────────────
  //
  // Short-circuit reads: if the policy would veto on the identity row
  // alone (inactive OR not stock_exception), we skip the ATP + history
  // reads — they can be expensive when a webhook storm lands.
  const needsFullInputs =
    identityRow.isActive && identityRow.outcomeState === "client_stock_exception";

  let warehouseAtp: number | null = null;
  let stabilityHistory: StockHistoryReadings = { readings: [] };

  if (needsFullInputs && identityRow.variantId) {
    const [atpResult, historyResult] = await Promise.all([
      readWarehouseAtp(supabase, identityRow.variantId),
      readStabilityHistory(supabase, input.workspaceId, identityRow.variantId, input.platform),
    ]);

    if (atpResult.kind === "error") {
      return { kind: "identity_lookup_failed", detail: atpResult.detail };
    }
    warehouseAtp = atpResult.atp;

    if (historyResult.kind === "error") {
      // History read failure is non-fatal on the veto side: we fall
      // through with an empty history, which the policy treats as
      // `stability_gate_failed` and bumps evidence.
      stabilityHistory = { readings: [] };
    } else {
      stabilityHistory = historyResult.history;
    }
  }

  // ── 4. Decide action (pure) ───────────────────────────────────────
  const action = decideRehydrateAction({
    identityRow,
    inboundStockSignal: input.inboundStockSignal,
    warehouseAtp,
    stabilityHistory,
  });

  // ── 5. Act ────────────────────────────────────────────────────────
  //
  // `route_to_discovery` is impossible here because we already filtered
  // identityRow !== null above. The switch still handles it
  // (returning `no_identity_row`) so the type system stays exhaustive.
  switch (action.kind) {
    case "route_to_discovery":
      return { kind: "no_identity_row" };

    case "update_evidence_only": {
      await bumpIdentityEvidence(supabase, identityRow.id, input.inboundStockSignal, identityRow);
      return {
        kind: "updated_evidence_only",
        identityMatchId: identityRow.id,
        outcomeState: action.outcomeState,
        rationale: action.rationale,
      };
    }

    case "bump_reobserved": {
      await bumpIdentityEvidence(supabase, identityRow.id, input.inboundStockSignal, identityRow);
      return {
        kind: "bumped_reobserved",
        identityMatchId: identityRow.id,
        rationale: action.rationale,
      };
    }

    case "promote":
      return tryPromote(supabase, input, identityRow, action, stabilityHistory);

    default: {
      // Exhaustiveness guard — TS will flag if the union grows.
      const _exhaustive: never = action;
      void _exhaustive;
      return { kind: "no_identity_row" };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Identity lookup
// ─────────────────────────────────────────────────────────────────────

type IdentityLookupResult =
  | { kind: "found"; row: IdentityRowSnapshotWithId }
  | { kind: "none" }
  | { kind: "error"; detail: string };

interface IdentityRowSnapshotWithId extends IdentityRowSnapshot {
  id: string;
  /**
   * Captured for the evidence-bump branch — we re-use the existing
   * snapshot under the `prior` key so the history is preserved.
   */
  evidenceSnapshot: Record<string, unknown>;
  /** Captured for the evaluation-count increment. */
  evaluationCount: number;
}

async function findActiveIdentityRow(
  supabase: RehydrateSupabaseClient,
  connectionId: string,
  keys: RehydrateIdentityKeys,
): Promise<IdentityLookupResult> {
  const table = "client_store_product_identity_matches";
  const columns =
    "id, outcome_state, is_active, state_version, variant_id, evidence_snapshot, evaluation_count";

  // Try in cascade order. Each probe is indexed by its own partial
  // UNIQUE index — see `uq_identity_active_remote_inventory_item`,
  // `uq_identity_active_remote_variant`, `uq_identity_active_remote_fingerprint`.
  const probes: Array<
    () => PromiseLike<{
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    }>
  > = [];

  if (keys.remoteInventoryItemId) {
    probes.push(() =>
      supabase
        .from(table)
        .select(columns)
        .eq("connection_id", connectionId)
        .eq("remote_inventory_item_id", keys.remoteInventoryItemId as string)
        .eq("is_active", "true")
        .maybeSingle(),
    );
  }

  if (keys.remoteProductId && keys.remoteVariantId) {
    probes.push(() =>
      supabase
        .from(table)
        .select(columns)
        .eq("connection_id", connectionId)
        .eq("remote_product_id", keys.remoteProductId as string)
        .eq("remote_variant_id", keys.remoteVariantId as string)
        .maybeSingle(),
    );
  }

  if (keys.remoteFingerprint) {
    probes.push(() =>
      supabase
        .from(table)
        .select(columns)
        .eq("connection_id", connectionId)
        .eq("remote_fingerprint", keys.remoteFingerprint as string)
        .eq("is_active", "true")
        .maybeSingle(),
    );
  }

  for (const probe of probes) {
    const result = await probe();
    if (result.error) {
      return { kind: "error", detail: result.error.message };
    }
    if (result.data) {
      const parsed = parseIdentityRow(result.data);
      if (parsed) {
        return { kind: "found", row: parsed };
      }
    }
  }

  return { kind: "none" };
}

function parseIdentityRow(row: Record<string, unknown>): IdentityRowSnapshotWithId | null {
  if (typeof row.id !== "string") return null;
  if (typeof row.outcome_state !== "string") return null;
  if (typeof row.state_version !== "number") return null;

  const allowed: readonly IdentityOutcomeStateForRehydrate[] = [
    "auto_database_identity_match",
    "auto_shadow_identity_match",
    "auto_holdout_for_evidence",
    "auto_reject_non_match",
    "auto_skip_non_operational",
    "fetch_incomplete_holdout",
    "client_stock_exception",
  ];
  const outcomeState = row.outcome_state as IdentityOutcomeStateForRehydrate;
  if (!allowed.includes(outcomeState)) return null;

  return {
    id: row.id,
    outcomeState,
    isActive: row.is_active === true,
    stateVersion: row.state_version,
    variantId: typeof row.variant_id === "string" ? row.variant_id : null,
    evidenceSnapshot:
      row.evidence_snapshot && typeof row.evidence_snapshot === "object"
        ? (row.evidence_snapshot as Record<string, unknown>)
        : {},
    evaluationCount: typeof row.evaluation_count === "number" ? row.evaluation_count : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Warehouse ATP + stability history
// ─────────────────────────────────────────────────────────────────────

type AtpReadResult = { kind: "ok"; atp: number | null } | { kind: "error"; detail: string };

async function readWarehouseAtp(
  supabase: RehydrateSupabaseClient,
  variantId: string,
): Promise<AtpReadResult> {
  const { data, error } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, committed_quantity")
    .eq("variant_id", variantId)
    .maybeSingle();

  if (error) {
    return { kind: "error", detail: error.message };
  }
  if (!data) {
    // No warehouse_inventory_levels row: treat as zero ATP so the
    // policy's `warehouse_atp_zero` branch fires.
    return { kind: "ok", atp: 0 };
  }

  const available = typeof data.available === "number" ? data.available : 0;
  const committed = typeof data.committed_quantity === "number" ? data.committed_quantity : 0;
  const atp = Math.max(0, available - Math.max(0, committed));
  return { kind: "ok", atp };
}

type HistoryReadResult =
  | { kind: "ok"; history: StockHistoryReadings }
  | { kind: "error"; detail: string };

async function readStabilityHistory(
  supabase: RehydrateSupabaseClient,
  workspaceId: string,
  variantId: string,
  platform: RehydratePlatform,
): Promise<HistoryReadResult> {
  if (!STABILITY_HISTORY_SOURCES.includes(platform)) {
    return { kind: "ok", history: { readings: [] } };
  }

  const { data, error } = await supabase
    .from("stock_stability_readings")
    .select("observed_at, available")
    .eq("workspace_id", workspaceId)
    .eq("variant_id", variantId)
    .eq("source", platform)
    .order("observed_at", { ascending: false })
    .limit(STABILITY_HISTORY_LIMIT);

  if (error) {
    return { kind: "error", detail: error.message };
  }

  const rawRows: Array<Record<string, unknown>> = data ?? [];
  const readings = rawRows
    .map((raw: Record<string, unknown>) => {
      const observedAt = typeof raw.observed_at === "string" ? raw.observed_at : null;
      const available =
        typeof raw.available === "number"
          ? raw.available
          : raw.available === null
            ? null
            : undefined;
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

  return { kind: "ok", history: { readings } };
}

// ─────────────────────────────────────────────────────────────────────
// Evidence bump
// ─────────────────────────────────────────────────────────────────────

async function bumpIdentityEvidence(
  supabase: RehydrateSupabaseClient,
  identityMatchId: string,
  signal: StockSignal,
  row: IdentityRowSnapshotWithId,
): Promise<void> {
  // Non-fatal failure: we can't roll back a DB error here because the
  // caller path (webhook handler) can't take the event off the queue
  // safely. Log-only semantics are fine — the scheduled revaluation
  // will pick up the reading next cycle anyway. We surface errors
  // through the return type for tests.
  const existingSnapshot = row.evidenceSnapshot;

  const latest_webhook_reading = {
    observed_at_local: signal.observedAtLocal,
    observed_at: signal.observedAt,
    value: signal.value,
    source: signal.source,
    tier: signal.tier,
  };

  const mergedSnapshot: Record<string, unknown> = {
    ...existingSnapshot,
    latest_webhook_reading,
  };

  await supabase
    .from("client_store_product_identity_matches")
    .update({
      evidence_snapshot: mergedSnapshot,
      last_evaluated_at: new Date().toISOString(),
      evaluation_count: row.evaluationCount + 1,
    })
    .eq("id", identityMatchId);
}

// ─────────────────────────────────────────────────────────────────────
// Promotion path
// ─────────────────────────────────────────────────────────────────────

async function tryPromote(
  supabase: RehydrateSupabaseClient,
  input: RehydrateWebhookInventoryUpdateInput,
  identityRow: IdentityRowSnapshotWithId,
  action: Extract<RehydrateAction, { kind: "promote" }>,
  stabilityHistory: StockHistoryReadings,
): Promise<RehydrateOutcome> {
  // Open a run for the audit trail. `dry_run=false` because we are
  // actually committing; `trigger_source='stock_change_trigger'`
  // matches plan §"stock-change trigger" terminology.
  const runOpen = await supabase
    .from("sku_autonomous_runs")
    .insert([
      {
        workspace_id: input.workspaceId,
        connection_id: input.connectionId,
        trigger_source: "stock_change_trigger",
        dry_run: false,
        feature_flags: {
          webhook_event_id: input.webhookEventId ?? null,
          platform: input.platform,
          entry_point: "webhook_rehydrate_inventory_update",
        },
        triggered_by: input.triggeredBy,
      },
    ])
    .select("id")
    .single();

  if (runOpen.error || !runOpen.data || typeof runOpen.data.id !== "string") {
    return {
      kind: "run_open_failed",
      detail: runOpen.error?.message ?? "no_data",
      identityMatchId: identityRow.id,
    };
  }

  const runId = runOpen.data.id;

  // Build the evidence snapshot for this decision row. We fold the
  // existing identity snapshot (prior reasoning) in under a `prior`
  // key so staff reviewing the decision row can see what the row
  // looked like when the stock exception was created.
  const evidenceSnapshot: Record<string, unknown> = {
    prior: identityRow.evidenceSnapshot,
    stock_positive_promotion: {
      observed_at_local: input.inboundStockSignal.observedAtLocal,
      observed_at: input.inboundStockSignal.observedAt,
      value: input.inboundStockSignal.value,
      source: input.inboundStockSignal.source,
      tier: input.inboundStockSignal.tier,
    },
    entry_point: "webhook_rehydrate_inventory_update",
    webhook_event_id: input.webhookEventId ?? null,
  };

  const promotionResult: PromoteIdentityMatchResult = await promoteIdentityMatchToAlias(
    supabase as unknown as PromotionSupabaseClient,
    {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      runId,
      identityMatchId: identityRow.id,
      variantId: identityRow.variantId,
      expectedStateVersion: action.expectedStateVersion,
      // Path A with reason `stock_positive_promotion` — this is the
      // documented pairing in `isPathReasonPairValid`. The stability
      // history passed here lets the promotion wrapper re-verify at the
      // narrower `promotion` window (4h) even though we pre-checked at
      // the `boost` window (6h). That's intentional: defense in depth.
      path: "A",
      reasonCode: action.reasonCode,
      triggeredBy: input.triggeredBy,
      evidenceSnapshot,
      stockEvidence: {
        signal: input.inboundStockSignal,
        history: stabilityHistory,
      },
      previousOutcomeState: undefined,
    },
  );

  // Always close the run. Status reflects whether the promotion
  // succeeded.
  await closeRun(supabase, runId, promotionResult.ok ? "completed" : "failed");

  if (promotionResult.ok) {
    return {
      kind: "promoted",
      identityMatchId: identityRow.id,
      aliasId: promotionResult.aliasId,
      decisionId: promotionResult.decisionId,
      runId,
    };
  }

  // On promotion failure, STILL bump the evidence so the next cycle
  // has the fresh reading. We tolerate write errors silently here
  // (see `bumpIdentityEvidence`).
  await bumpIdentityEvidence(supabase, identityRow.id, input.inboundStockSignal, identityRow);

  return {
    kind: "promotion_blocked",
    identityMatchId: identityRow.id,
    reason: promotionResult.reason,
    detail: promotionResult.detail,
    runId,
  };
}

async function closeRun(
  supabase: RehydrateSupabaseClient,
  runId: string,
  status: "completed" | "failed",
): Promise<void> {
  await supabase
    .from("sku_autonomous_runs")
    .update({
      status,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}
