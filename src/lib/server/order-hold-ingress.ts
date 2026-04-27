/**
 * Autonomous SKU matcher — Phase 8 shared hold-ingress glue.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Webhook and poll order-ingest consistency" +
 *       §"Normalized order adapter" +
 *       §"Hold evaluator contract".
 *       Release gates SKU-AUTO-3 (webhook-ingest + poll-ingest both
 *       construct `NormalizedClientStoreOrder` via the shared adapter
 *       and call `evaluateOrderForHold`) and SKU-AUTO-21
 *       (committable-warehouse lines committed in the same transaction
 *       as the hold write).
 *
 * Why this module exists
 * ──────────────────────
 * Before Phase 8, the hold substrate (Phase 2–4 primitives:
 * `loadNormalizedOrder`, `evaluateOrderForHold`, `applyOrderFulfillmentHold`)
 * was fully built but dormant: NO ingress path called them. The webhook
 * handler and the poll task both created `warehouse_orders` rows and
 * decremented inventory unconditionally, ignoring the evaluator.
 *
 * This helper is THE entry point both ingress paths now call immediately
 * after inserting `warehouse_orders` + `warehouse_order_items`. It:
 *
 *   1. Short-circuits when `non_warehouse_order_hold_enabled=false`
 *      (rollout gate) or when the workspace is emergency-paused (kill
 *      switch).
 *   2. Calls `loadNormalizedOrder(supabase, orderId)` — both paths read
 *      the JUST-INSERTED DB row so the evaluator sees the same shape
 *      regardless of whether Shopify delivered via webhook or poll.
 *      This is SKU-AUTO-3's "identical shape" guarantee, enforced by
 *      construction: both paths call the exact same helper with the
 *      exact same loader.
 *   3. Calls `evaluateOrderForHold(supabase, order)`.
 *   4. On `shouldHold=true`, calls `applyOrderFulfillmentHold` which
 *      writes `warehouse_orders.fulfillment_hold`, the audit event, AND
 *      the `inventory_commitments` rows for committable-warehouse lines
 *      in ONE ACID transaction (Rule #64).
 *   5. Returns a structured verdict so callers know:
 *        - which remote SKUs are committable (decrement inventory),
 *        - which remote SKUs are held (DO NOT decrement),
 *        - whether the helper already ran the RPC (so the caller must
 *          NOT call a separate `commitOrderItems()` — the RPC did it).
 *   6. Does NOT enqueue the client-alert task itself. The caller
 *      decides whether to enqueue, gated by `shouldSuppressBulkHold`.
 *      This keeps the helper testable without Trigger.dev globals.
 *
 * Dormant behavior by design
 * ──────────────────────────
 * When `holdEnabled=false` (the default for every workspace until an
 * operator opts in via the rollout page), the helper returns
 * `{ kind: "hold_disabled" }` without reading anything. Callers short-
 * circuit and fall back to their existing unconditional-decrement path.
 * That preserves the pre-Phase-8 behavior byte-for-byte until the flag
 * is flipped.
 *
 * Emergency pause
 * ───────────────
 * The workspace-level `sku_autonomous_emergency_paused` kill switch is
 * honored here: when true, the helper returns
 * `{ kind: "emergency_paused" }` and the caller falls back to the
 * pre-Phase-8 unconditional-decrement path. This matches the behavior
 * documented on the rollout page (SKU-AUTO-30) — emergency pause MUST
 * NOT cause orders to hang.
 *
 * Failure policy
 * ──────────────
 * loader / evaluator / RPC errors return structured failure kinds so
 * callers can decide whether to fail open or bubble up. Both current
 * callers fail open (continue with the legacy unconditional-decrement
 * path + a sensor row), because a hold-evaluation bug MUST NOT block
 * order ingestion — we would rather ship something than hang the order.
 *
 * Non-goals
 * ─────────
 *   * Does NOT enqueue `send-non-warehouse-order-hold-alert` — the
 *     caller does that after checking `shouldSuppressBulkHold`.
 *   * Does NOT emit ops alerts or sensor rows. The caller owns that.
 *   * Does NOT decrement `warehouse_inventory_levels` for committable
 *     lines — the caller's inventory loop does that via
 *     `recordInventoryChange()` (single-write-path invariant, Rule #20).
 *   * Does NOT send Slack / email.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadNormalizedOrder } from "@/lib/server/normalized-order-loader";
import { evaluateOrderForHold } from "@/lib/server/order-hold-evaluator";
import type {
  HoldDecision,
  HoldLineClassification,
  HoldReason,
} from "@/lib/server/order-hold-policy";
import {
  type ApplyHoldReason,
  type ApplyOrderFulfillmentHoldResult,
  applyOrderFulfillmentHold,
  type CommitLine,
  type HoldRpcClient,
} from "@/lib/server/order-hold-rpcs";
import type { WorkspaceFlags } from "@/lib/server/workspace-flags";

type DbClient = SupabaseClient;

/**
 * Pure mapping from the evaluator's `HoldReason` taxonomy to the RPC's
 * narrower `ApplyHoldReason` taxonomy. Kept pure + exported so tests
 * can assert every evaluator-reason has an RPC-reason (exhaustive
 * mapping; missing rows = TypeScript error).
 *
 * Semantic mapping rationale:
 *   - `non_warehouse_sku` → `non_warehouse_match`: alias exists but
 *     stock is non-positive. Same conceptual root cause as
 *     `identity_only_match` (we recognize the product but can't
 *     allocate stock from the warehouse), so they share the RPC reason.
 *   - `identity_only_match` → `non_warehouse_match`: see above.
 *   - `unmapped_sku` → `unknown_remote_sku`: raw remote SKU that does
 *     not appear in alias OR identity tables.
 *   - `placeholder_sku_detected` → `placeholder_remote_sku`: the
 *     remote store sent `""`, `"1"`, `"n/a"`, etc.
 *   - `fetch_incomplete_at_match` → `fetch_incomplete_at_match`:
 *     direct mirror; the only transient reason.
 */
export const HOLD_REASON_TO_APPLY_REASON: Record<HoldReason, ApplyHoldReason> = {
  non_warehouse_sku: "non_warehouse_match",
  identity_only_match: "non_warehouse_match",
  unmapped_sku: "unknown_remote_sku",
  placeholder_sku_detected: "placeholder_remote_sku",
  fetch_incomplete_at_match: "fetch_incomplete_at_match",
};

/**
 * Source discriminator for telemetry. The helper reads it, the
 * normalized-order loader stamps it on the `NormalizedClientStoreOrder`,
 * and downstream observability queries can answer "did this hold arrive
 * via webhook or poll, and are the rates consistent?" — SKU-AUTO-3's
 * forensics question.
 */
export type OrderHoldIngressSource = "webhook" | "poll";

export interface OrderHoldIngressInput {
  /** `warehouse_orders.id` UUID (just inserted). */
  readonly orderId: string;
  /** Workspace scope — redundant with the loader lookup but kept for logs. */
  readonly workspaceId: string;
  /** Telemetry discriminator — stamped onto the normalized order. */
  readonly source: OrderHoldIngressSource;
  /**
   * Caller-supplied `workspaces.flags.non_warehouse_order_hold_enabled`
   * value. Injected rather than re-read here so the helper stays
   * transport-agnostic and so callers can batch the workspace lookup
   * with their other workspace reads.
   */
  readonly holdEnabled: boolean;
  /**
   * Caller-supplied `workspaces.sku_autonomous_emergency_paused` value.
   * Injected for the same reason as `holdEnabled`.
   */
  readonly emergencyPaused: boolean;
}

export interface OrderHoldIngressDeps {
  /** Override for unit tests. Defaults to `loadNormalizedOrder`. */
  readonly loadOrder?: typeof loadNormalizedOrder;
  /** Override for unit tests. Defaults to `evaluateOrderForHold`. */
  readonly evaluate?: typeof evaluateOrderForHold;
  /** Override for unit tests. Defaults to `applyOrderFulfillmentHold`. */
  readonly applyHold?: (
    supabase: HoldRpcClient,
    input: Parameters<typeof applyOrderFulfillmentHold>[1],
  ) => Promise<ApplyOrderFulfillmentHoldResult>;
}

/**
 * A committable line surfaced to the caller. `remoteSku` is the
 * raw-remote-string form (suitable for a `!held.has(remoteSku)` check
 * in the caller's decrement loop). `variantId` is the already-resolved
 * warehouse variant, handy for bundle-fanout without re-querying.
 */
export interface CommittableLineSummary {
  readonly remoteSku: string | null;
  readonly variantId: string;
  readonly quantity: number;
}

export type OrderHoldIngressResult =
  /**
   * The hold rollout flag is OFF for this workspace. Caller falls back
   * to the pre-Phase-8 unconditional-decrement path. This is the
   * default state for every workspace until the operator opts in.
   */
  | { kind: "hold_disabled" }
  /**
   * Workspace is emergency-paused. Caller falls back to the pre-Phase-8
   * unconditional-decrement path. SKU-AUTO-30 guarantees emergency
   * pause NEVER makes orders hang.
   */
  | { kind: "emergency_paused" }
  /**
   * Order is on a non-autonomous-matching platform (Bandcamp / Discogs
   * / manual). Caller falls back to the legacy path. The hold substrate
   * explicitly does not cover these platforms.
   */
  | { kind: "unsupported_platform"; platform: string; detail: string }
  /**
   * The shared adapter could not build a normalized order. Most often
   * `missing_connection` / `ambiguous_connection` / `order_not_found` /
   * `no_lines`. Caller logs + falls back to the legacy path.
   */
  | { kind: "loader_error"; reason: string; detail: string }
  /**
   * The evaluator returned a DB error on one of its four batched
   * lookups. Caller logs + falls back.
   */
  | { kind: "evaluator_error"; detail: string }
  /**
   * The evaluator succeeded but `applyOrderFulfillmentHold` failed.
   * Caller logs + falls back. The RPC wrapper returns a narrow reason
   * code (`invalid_hold_reason` / `order_not_found` / `order_cancelled`
   * / `cycle_id_conflict` / `rpc_error` / `unexpected_response_shape`)
   * that we forward untouched.
   */
  | { kind: "apply_error"; reason: string; detail: string; decision: HoldDecision }
  /**
   * Evaluator ran; every line was committable. Caller decrements every
   * line as in the pre-Phase-8 path. No hold event was written.
   *
   * NOTE: when `kind="no_hold"`, the caller is still responsible for
   * the pre-Phase-8 `commitOrderItems()` call — the RPC was never
   * invoked, so the commitment ledger was not updated.
   */
  | {
      kind: "no_hold";
      classifications: ReadonlyArray<HoldLineClassification>;
    }
  /**
   * The hold RPC succeeded. The caller:
   *   1. MUST NOT call a separate `commitOrderItems()` — the RPC wrote
   *      `inventory_commitments` for every committable-warehouse line in
   *      the same transaction.
   *   2. Decrements `warehouse_inventory_levels` ONLY for remote SKUs
   *      in `committableRemoteSkus` (held lines stay untouched).
   *   3. Decides whether to enqueue `send-non-warehouse-order-hold-alert`
   *      based on `clientAlertRequired` AND `shouldSuppressBulkHold()`.
   */
  | {
      kind: "hold_applied";
      cycleId: string;
      holdReason: HoldReason;
      applyHoldReason: ApplyHoldReason;
      holdEventId: string;
      commitsInserted: number;
      clientAlertRequired: boolean;
      staffReviewRequired: boolean;
      /** Remote-SKU set for the caller's decrement-filter. */
      committableRemoteSkus: ReadonlySet<string>;
      /** Full committable summary for richer caller logs / fanout. */
      committableLines: ReadonlyArray<CommittableLineSummary>;
      /** Full hold decision for audit logs. */
      decision: HoldDecision;
    };

/**
 * Deterministic cycle-id for a given `(workspace, order)` pair. Using a
 * stable string (not a random UUID) is safe because the RPC enforces
 * `cycle_id_conflict` on a second apply attempt for the same cycle —
 * Shopify webhook retries therefore re-apply the SAME cycle and get
 * `idempotent: true`, NOT a duplicate `hold_applied` row.
 *
 * Exported so unit tests can assert parity: webhook + poll on the same
 * order MUST generate the same cycle id.
 */
export function buildIngressCycleId(workspaceId: string, orderId: string): string {
  return `ingress:${workspaceId}:${orderId}`;
}

/**
 * Project a `HoldLineClassification` with `committable: true` onto the
 * `CommitLine` shape the RPC accepts. Uses the raw remote SKU because
 * that matches the existing `commitOrderItems()` convention (the
 * pre-Phase-8 webhook path stores `inventory_commitments.sku` as the
 * remote-store SKU, and we must not silently change what the commit
 * ledger stores mid-rollout).
 *
 * Exported for tests.
 */
export function buildCommitLinesFromClassifications(
  classifications: ReadonlyArray<HoldLineClassification>,
): CommitLine[] {
  const out: CommitLine[] = [];
  for (const c of classifications) {
    if (!c.committable) continue;
    if (c.line.remoteSku === null || c.line.remoteSku.length === 0) continue;
    if (!Number.isFinite(c.line.quantity) || c.line.quantity <= 0) continue;
    out.push({ sku: c.line.remoteSku, qty: Math.floor(c.line.quantity) });
  }
  return out;
}

/**
 * Project the `decision.affectedLines` array onto the RPC's
 * `p_held_lines` shape (array of objects). Shape matches what the
 * existing Phase 3/4 audit queries expect on
 * `order_fulfillment_hold_events.affected_lines`.
 *
 * Exported for tests.
 */
export function buildHeldLinesPayload(decision: HoldDecision): Array<Record<string, unknown>> {
  return decision.affectedLines.map((c) => ({
    sku: c.line.remoteSku,
    title: c.line.title,
    quantity: c.line.quantity,
    held: true,
    reason: c.reason,
    remote_product_id: c.line.remoteProductId,
    remote_variant_id: c.line.remoteVariantId,
    warehouse_order_item_id: c.line.warehouseOrderItemId,
    identity_match_id: c.identityMatchId,
    available_stock_at_eval: c.availableStockAtEval,
  }));
}

/**
 * Build the set of committable remote SKUs. Used by callers to filter
 * their inventory-decrement loop — decrement only lines IN this set.
 *
 * Exported for tests.
 */
export function buildCommittableRemoteSkuSet(decision: HoldDecision): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of decision.committableLines) {
    if (c.line.remoteSku !== null && c.line.remoteSku.length > 0) {
      out.add(c.line.remoteSku);
    }
  }
  return out;
}

/**
 * Project `decision.committableLines` onto the public summary shape.
 *
 * Exported for tests.
 */
export function summarizeCommittableLines(
  decision: HoldDecision,
): ReadonlyArray<CommittableLineSummary> {
  return decision.committableLines.map((c) => ({
    remoteSku: c.line.remoteSku,
    variantId: c.variantId,
    quantity: c.line.quantity,
  }));
}

/**
 * The single ingress entry point for the Phase 8 hold substrate.
 * Both `process-client-store-webhook.handleOrderCreated` and
 * `client-store-order-detect` call this after inserting the order row.
 */
export async function evaluateAndApplyOrderHold(
  supabase: DbClient,
  input: OrderHoldIngressInput,
  deps: OrderHoldIngressDeps = {},
): Promise<OrderHoldIngressResult> {
  if (!input.holdEnabled) {
    return { kind: "hold_disabled" };
  }
  if (input.emergencyPaused) {
    return { kind: "emergency_paused" };
  }

  const loader = deps.loadOrder ?? loadNormalizedOrder;
  const loadResult = await loader(supabase, input.orderId, { source: input.source });

  if (!loadResult.ok) {
    if (loadResult.reason === "unsupported_platform") {
      return {
        kind: "unsupported_platform",
        platform: loadResult.detail ?? "",
        detail: loadResult.detail ?? "",
      };
    }
    return {
      kind: "loader_error",
      reason: loadResult.reason,
      detail: loadResult.detail ?? "",
    };
  }

  const normalized = loadResult.order;

  const evaluator = deps.evaluate ?? evaluateOrderForHold;
  const evalResult = await evaluator(supabase, normalized);

  if (!evalResult.ok) {
    return { kind: "evaluator_error", detail: evalResult.detail };
  }

  const decision = evalResult.decision;
  if (!decision.shouldHold || decision.holdReason === null) {
    return { kind: "no_hold", classifications: evalResult.classifications };
  }

  const applyHoldReason = HOLD_REASON_TO_APPLY_REASON[decision.holdReason];
  const cycleId = buildIngressCycleId(input.workspaceId, input.orderId);
  const heldLines = buildHeldLinesPayload(decision);
  const commitLines = buildCommitLinesFromClassifications(evalResult.classifications);

  const apply = deps.applyHold ?? applyOrderFulfillmentHold;
  const applyResult = await apply(supabase as unknown as HoldRpcClient, {
    orderId: input.orderId,
    connectionId: normalized.connectionId,
    reason: applyHoldReason,
    cycleId,
    heldLines,
    commitLines,
    actorKind: "task",
    actorId: null,
    metadata: {
      ingress_source: input.source,
      hold_reason_evaluated: decision.holdReason,
      committable_line_count: commitLines.length,
      held_line_count: heldLines.length,
      affected_line_count: decision.affectedLines.length,
    },
  });

  if (!applyResult.ok) {
    return {
      kind: "apply_error",
      reason: applyResult.reason,
      detail: applyResult.detail ?? "",
      decision,
    };
  }

  return {
    kind: "hold_applied",
    cycleId,
    holdReason: decision.holdReason,
    applyHoldReason,
    holdEventId: applyResult.holdEventId,
    commitsInserted: applyResult.commitsInserted,
    clientAlertRequired: decision.clientAlertRequired,
    staffReviewRequired: decision.staffReviewRequired,
    committableRemoteSkus: buildCommittableRemoteSkuSet(decision),
    committableLines: summarizeCommittableLines(decision),
    decision,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Phase 8.C / 8.D — `runHoldIngressSafely` shared wrapper.
//
// Both the webhook handler and the poll-ingest detector need to:
//   1. Read `workspaces.flags.non_warehouse_order_hold_enabled`
//      + `workspaces.sku_autonomous_emergency_paused` (ONE DB hop),
//   2. Call `evaluateAndApplyOrderHold` with those guards,
//   3. Swallow any thrown exception or terminal error kind
//      (loader_error / evaluator_error / apply_error /
//       unsupported_platform / workspace_read_failed) and convert it
//      into a `"legacy"` verdict so the caller falls back to the
//      pre-Phase-8 unconditional-decrement path,
//   4. Return BOTH the verdict and a list of structured sensor
//      warnings the caller should persist as `sensor_readings` rows.
//
// This wrapper is what makes the SKU-AUTO-3 parity guarantee hold by
// CONSTRUCTION: both webhook + poll call the exact same function with
// the exact same (workspaceId, orderId) tuple and the same supabase
// client, so the workspace read + evaluator invocation + hold
// application ARE IDENTICAL.
// ───────────────────────────────────────────────────────────────────────

/**
 * Structured warning row a caller should persist as a `sensor_readings`
 * write. Kept as data (not a side-effect) so the wrapper stays
 * transport-agnostic and so unit tests can assert exactly which
 * warnings would be emitted on each failure branch.
 */
export interface IngressSensorWarning {
  readonly sensor_name: string;
  readonly status: "warning" | "error";
  readonly message: string;
  readonly value: Record<string, unknown>;
}

/**
 * Simplified verdict for the caller's dispatch logic. Collapses the
 * many terminal error kinds of `OrderHoldIngressResult` down to a
 * single `"legacy"` branch that means "fall back to the pre-Phase-8
 * unconditional-decrement path".
 *
 * `holdDecision` is only present on `kind="no_hold"` so callers that
 * want to persist the full classification list can do so. (Phase 9's
 * per-line observability surface will consume this.)
 */
export type SafeIngressVerdict =
  | { kind: "legacy"; reason: string }
  | {
      kind: "no_hold";
      classifications: ReadonlyArray<HoldLineClassification>;
    }
  | {
      kind: "hold_applied";
      cycleId: string;
      holdReason: HoldReason;
      applyHoldReason: ApplyHoldReason;
      holdEventId: string;
      commitsInserted: number;
      clientAlertRequired: boolean;
      staffReviewRequired: boolean;
      committableRemoteSkus: ReadonlySet<string>;
      committableLines: ReadonlyArray<CommittableLineSummary>;
      decision: HoldDecision;
    };

export interface SafeIngressResult {
  readonly verdict: SafeIngressVerdict;
  readonly warnings: ReadonlyArray<IngressSensorWarning>;
}

export interface RunHoldIngressSafelyInput {
  readonly workspaceId: string;
  readonly orderId: string;
  readonly source: OrderHoldIngressSource;
  /**
   * Optional: caller-supplied platform string for richer sensor
   * messages when fail-open fires. Not required by the evaluator.
   */
  readonly platform?: string | null;
}

/**
 * Outcome of a single workspace-row read. Returns both guard values so
 * callers (and tests) can dispatch without further reads.
 *
 * Exported so unit tests can inject a specific guard-read outcome via
 * `deps.readGuards` without constructing a full `workspaces` mock
 * builder.
 */
export type IngressGuardsReadResult =
  | { kind: "ok"; holdEnabled: boolean; emergencyPaused: boolean }
  | { kind: "workspace_read_failed"; detail: string };

export type IngressGuardsReader = (
  supabase: DbClient,
  workspaceId: string,
) => Promise<IngressGuardsReadResult>;

/**
 * Production workspace read. Exported so the test suite can assert
 * parity with the inline implementation if desired; callers normally
 * rely on the default `deps.readGuards` behavior.
 */
export async function readIngressGuardsInline(
  supabase: DbClient,
  workspaceId: string,
): Promise<IngressGuardsReadResult> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("flags, sku_autonomous_emergency_paused")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error) {
    return { kind: "workspace_read_failed", detail: error.message };
  }
  if (!data) {
    return { kind: "workspace_read_failed", detail: "workspace_not_found" };
  }

  const row = data as {
    flags?: unknown;
    sku_autonomous_emergency_paused?: boolean | null;
  };
  const flags = (row.flags ?? {}) as WorkspaceFlags;
  return {
    kind: "ok",
    holdEnabled: flags.non_warehouse_order_hold_enabled === true,
    emergencyPaused: row.sku_autonomous_emergency_paused === true,
  };
}

/**
 * Shared entry point for Phase 8 webhook + poll ingress.
 *
 * Dormant behavior (fail-open everywhere):
 *   - `non_warehouse_order_hold_enabled=false`   → verdict:"legacy" (pre-Phase-8 path)
 *   - `sku_autonomous_emergency_paused=true`     → verdict:"legacy"
 *   - workspace_read_failed                      → verdict:"legacy" + warning
 *   - loader_error / evaluator_error / apply_error → verdict:"legacy" + warning
 *   - unsupported_platform                        → verdict:"legacy"
 *   - thrown exception                            → verdict:"legacy" + warning
 *
 * ONLY `no_hold` and `hold_applied` drive non-legacy behavior.
 *
 * `deps.readGuards` is exposed for unit tests that want to inject a
 * specific guard-read outcome without mocking the `workspaces` table
 * shape. Production callers never pass it.
 */
export async function runHoldIngressSafely(
  supabase: DbClient,
  input: RunHoldIngressSafelyInput,
  deps: OrderHoldIngressDeps & {
    readGuards?: IngressGuardsReader;
  } = {},
): Promise<SafeIngressResult> {
  const warnings: IngressSensorWarning[] = [];
  const baseValue = {
    order_id: input.orderId,
    workspace_id: input.workspaceId,
    source: input.source,
    platform: input.platform ?? null,
  } satisfies Record<string, unknown>;

  const readGuards = deps.readGuards ?? readIngressGuardsInline;

  let guards: IngressGuardsReadResult;
  try {
    guards = await readGuards(supabase, input.workspaceId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push({
      sensor_name: "hold_ingress.workspace_read_threw",
      status: "warning",
      message: `workspace guard read threw for ${input.source} order ${input.orderId}: ${detail.slice(0, 200)}`,
      value: { ...baseValue, detail },
    });
    return { verdict: { kind: "legacy", reason: "workspace_read_threw" }, warnings };
  }

  if (guards.kind === "workspace_read_failed") {
    warnings.push({
      sensor_name: "hold_ingress.workspace_read_failed",
      status: "warning",
      message: `workspace guard read failed for ${input.source} order ${input.orderId}: ${guards.detail.slice(0, 200)}`,
      value: { ...baseValue, detail: guards.detail },
    });
    return { verdict: { kind: "legacy", reason: "workspace_read_failed" }, warnings };
  }

  if (!guards.holdEnabled) {
    return { verdict: { kind: "legacy", reason: "hold_disabled" }, warnings };
  }
  if (guards.emergencyPaused) {
    return { verdict: { kind: "legacy", reason: "emergency_paused" }, warnings };
  }

  let result: OrderHoldIngressResult;
  try {
    result = await evaluateAndApplyOrderHold(
      supabase,
      {
        orderId: input.orderId,
        workspaceId: input.workspaceId,
        source: input.source,
        holdEnabled: true,
        emergencyPaused: false,
      },
      deps,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push({
      sensor_name: "hold_ingress.evaluator_threw",
      status: "warning",
      message: `evaluateAndApplyOrderHold threw for ${input.source} order ${input.orderId}: ${detail.slice(0, 200)}`,
      value: { ...baseValue, detail },
    });
    return { verdict: { kind: "legacy", reason: "evaluator_threw" }, warnings };
  }

  switch (result.kind) {
    case "hold_disabled":
      return { verdict: { kind: "legacy", reason: "hold_disabled" }, warnings };
    case "emergency_paused":
      return { verdict: { kind: "legacy", reason: "emergency_paused" }, warnings };
    case "unsupported_platform":
      return { verdict: { kind: "legacy", reason: "unsupported_platform" }, warnings };
    case "loader_error":
      warnings.push({
        sensor_name: "hold_ingress.loader_error",
        status: "warning",
        message: `normalized-order loader failed for ${input.source} order ${input.orderId}: ${result.reason}`,
        value: { ...baseValue, reason: result.reason, detail: result.detail },
      });
      return { verdict: { kind: "legacy", reason: `loader_error:${result.reason}` }, warnings };
    case "evaluator_error":
      warnings.push({
        sensor_name: "hold_ingress.evaluator_error",
        status: "warning",
        message: `hold evaluator failed for ${input.source} order ${input.orderId}: ${result.detail.slice(0, 200)}`,
        value: { ...baseValue, detail: result.detail },
      });
      return { verdict: { kind: "legacy", reason: "evaluator_error" }, warnings };
    case "apply_error":
      warnings.push({
        sensor_name: "hold_ingress.apply_error",
        status: "error",
        message: `applyOrderFulfillmentHold failed for ${input.source} order ${input.orderId}: ${result.reason}`,
        value: {
          ...baseValue,
          reason: result.reason,
          detail: result.detail,
          hold_reason: result.decision.holdReason,
        },
      });
      return { verdict: { kind: "legacy", reason: `apply_error:${result.reason}` }, warnings };
    case "no_hold":
      return {
        verdict: { kind: "no_hold", classifications: result.classifications },
        warnings,
      };
    case "hold_applied":
      return {
        verdict: {
          kind: "hold_applied",
          cycleId: result.cycleId,
          holdReason: result.holdReason,
          applyHoldReason: result.applyHoldReason,
          holdEventId: result.holdEventId,
          commitsInserted: result.commitsInserted,
          clientAlertRequired: result.clientAlertRequired,
          staffReviewRequired: result.staffReviewRequired,
          committableRemoteSkus: result.committableRemoteSkus,
          committableLines: result.committableLines,
          decision: result.decision,
        },
        warnings,
      };
  }
}
