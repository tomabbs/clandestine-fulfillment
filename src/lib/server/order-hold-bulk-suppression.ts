/**
 * Autonomous SKU matcher — Phase 3.C bulk-hold suppression primitive.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Bulk hold suppression and fetch-recovery auto-release"
 *       Release gate SKU-AUTO-31.
 *
 * Why this exists:
 *   A client catalog going down for 30 minutes produces dozens of
 *   simultaneous `fetch_incomplete_at_match` holds with no underlying
 *   data problem. Each hold is individually correct; the aggregate is
 *   an operational nightmare (spam of client emails + review-queue
 *   rows) for what is really one platform-outage event. This helper
 *   is the single gate the alert task and evaluator share to degrade
 *   gracefully during those windows.
 *
 * Contract:
 *   * Scope: `(workspace_id, connection_id, reason)`. A spike on one
 *     connection NEVER suppresses holds on a different connection in
 *     the same workspace.
 *   * Reasons in scope: ONLY `fetch_incomplete_at_match`. The plan is
 *     explicit that `non_warehouse_sku` (unknown_remote_sku /
 *     placeholder_remote_sku / non_warehouse_match) holds are legitimate
 *     per-order events and MUST NEVER be suppressed — suppressing them
 *     breaks the client contract.
 *   * Threshold: `>= 10` hold_applied events for the same
 *     (workspace, connection, reason) in the trailing 15-minute window
 *     flips suppression on. The window query is backed by
 *     `idx_order_fulfillment_hold_events_bulk_window`.
 *   * Suppression does NOT roll back the hold — the order still sits
 *     at `fulfillment_hold='on_hold'`. Suppression ONLY prevents the
 *     `send-non-warehouse-order-hold-alert` enqueue and surfaces a
 *     single ops alert per window.
 *
 * Output is structured (not a boolean) so callers can audit WHY they
 * suppressed and how close a non-suppressed reason was to threshold.
 * The task records the returned payload in the
 * `order_fulfillment_hold_events.metadata` JSON for the hold_applied
 * row on the suppressing run.
 *
 * Pure-ish:
 *   The function takes a `BulkSuppressionSupabaseClient` subset of
 *   supabase-js so tests can inject a mock without constructing a
 *   full SupabaseClient. All DB state flows through the injected
 *   client; there is no global supabase dependency.
 */

const BULK_HOLD_THRESHOLD = {
  count_per_window: 10,
  window_minutes: 15,
} as const;

const SUPPRESSIBLE_REASONS = new Set<string>(["fetch_incomplete_at_match"]);

/**
 * Valid values for the `reason` argument. Must stay aligned with the
 * TS `HoldReason` union in `src/lib/server/order-hold-policy.ts`
 * minus the `all_lines_warehouse_ready` sentinel.
 */
export type BulkSuppressionHoldReason =
  | "unknown_remote_sku"
  | "placeholder_remote_sku"
  | "non_warehouse_match"
  | "fetch_incomplete_at_match";

export interface BulkSuppressionDecision {
  /**
   * True ↔ suppression is active for this `(workspace, connection, reason)`.
   * Callers MUST NOT enqueue `send-non-warehouse-order-hold-alert`
   * when this is true.
   */
  suppress: boolean;
  /**
   * Count of `hold_applied` events in the rolling window that matched
   * `(workspace_id, connection_id, event_type='hold_applied', reason)`.
   * Zero for non-suppressible reasons (short-circuit).
   */
  recent_count: number;
  /**
   * True ↔ the caller should invoke `emitOpsAlert(...)` on the
   * first suppression of this window (not once per order). The
   * alert task debounces this via per-call dedup at `emitOpsAlert`;
   * this flag is the hint, not the debouncer.
   */
  ops_alert_required: boolean;
  /** Threshold (rows) used. Exported for audit/metadata logging. */
  threshold: number;
  /** Window length in minutes used. Exported for audit/metadata logging. */
  window_minutes: number;
}

export interface BulkSuppressionCountQuery {
  count: number | null;
  error: { message: string } | null;
}

export interface BulkSuppressionSupabaseBuilder {
  select(
    columns: string,
    options?: { count?: "exact"; head?: boolean },
  ): BulkSuppressionSupabaseBuilder;
  eq(column: string, value: string): BulkSuppressionSupabaseBuilder;
  gte(column: string, value: string): PromiseLike<BulkSuppressionCountQuery>;
}

export interface BulkSuppressionSupabaseClient {
  from(table: "order_fulfillment_hold_events"): BulkSuppressionSupabaseBuilder;
}

/**
 * Query the rolling window count and decide whether bulk hold
 * suppression is active for this `(workspace, connection, reason)`.
 *
 * `nowMs` is injectable purely so tests can pin the window boundary;
 * production callers pass no arg and get `Date.now()`.
 */
export async function shouldSuppressBulkHold(
  supabase: BulkSuppressionSupabaseClient,
  input: {
    workspaceId: string;
    connectionId: string;
    reason: BulkSuppressionHoldReason;
  },
  nowMs: number = Date.now(),
): Promise<BulkSuppressionDecision> {
  if (!SUPPRESSIBLE_REASONS.has(input.reason)) {
    return {
      suppress: false,
      recent_count: 0,
      ops_alert_required: false,
      threshold: BULK_HOLD_THRESHOLD.count_per_window,
      window_minutes: BULK_HOLD_THRESHOLD.window_minutes,
    };
  }

  const windowStart = new Date(nowMs - BULK_HOLD_THRESHOLD.window_minutes * 60_000).toISOString();

  const { count, error } = await supabase
    .from("order_fulfillment_hold_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("connection_id", input.connectionId)
    .eq("event_type", "hold_applied")
    .eq("hold_reason", input.reason)
    .gte("created_at", windowStart);

  if (error) {
    // Fail-open. A bulk-suppression query failure should NOT cause
    // client alerts to spam or orders to hang; the safer default is
    // to let the alert enqueue and let the per-alert idempotency
    // guards (partial unique index + Resend key) do their job.
    return {
      suppress: false,
      recent_count: 0,
      ops_alert_required: false,
      threshold: BULK_HOLD_THRESHOLD.count_per_window,
      window_minutes: BULK_HOLD_THRESHOLD.window_minutes,
    };
  }

  const recent = count ?? 0;
  const suppress = recent >= BULK_HOLD_THRESHOLD.count_per_window;
  return {
    suppress,
    recent_count: recent,
    ops_alert_required: suppress,
    threshold: BULK_HOLD_THRESHOLD.count_per_window,
    window_minutes: BULK_HOLD_THRESHOLD.window_minutes,
  };
}

/** Exported for tests and for cross-module consistency checks. */
export const BULK_HOLD_SUPPRESSION_CONTRACT = {
  threshold: BULK_HOLD_THRESHOLD.count_per_window,
  window_minutes: BULK_HOLD_THRESHOLD.window_minutes,
  suppressible_reasons: Array.from(SUPPRESSIBLE_REASONS),
} as const;
