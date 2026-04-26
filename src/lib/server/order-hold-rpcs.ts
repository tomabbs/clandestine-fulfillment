/**
 * Autonomous SKU matcher — TS wrappers for the Phase 3.B order-hold
 * RPC pair (`apply_order_fulfillment_hold` +
 * `release_order_fulfillment_hold`).
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Order hold RPC contract" +
 *       release gates SKU-AUTO-15 (apply-hold atomic write),
 *       SKU-AUTO-17 (release resolution-code whitelist),
 *       SKU-AUTO-21 (committable-warehouse lines committed in the
 *       same transaction as the hold write),
 *       SKU-AUTO-22 (pg_advisory_xact_lock per order),
 *       SKU-AUTO-32 (staff_override requires a note at RPC level).
 *
 * Scope:
 *   This module is the ONE entry point for mutating the hold state of
 *   `warehouse_orders` from TypeScript. Webhook ingress
 *   (`process-client-store-webhook.ts`), the `sku-hold-recovery-recheck`
 *   Trigger task, and staff-action Server Actions MUST route through
 *   these wrappers. Calling the underlying RPCs directly bypasses:
 *     * the bulk-hold suppression check (`shouldSuppressBulkHold`,
 *       Phase 3.C / SKU-AUTO-31 — NOT implemented in this module; the
 *       wrapper merely exposes a `suppressAlert` hint so the caller
 *       can decide whether to enqueue the client-alert task),
 *     * the hold-evaluator idempotency guards (Phase 2.B
 *       `evaluateOrderForHold`),
 *     * the cycle-id generation discipline (callers must pass a
 *       deterministic cycle_id for retry safety).
 *
 *   Inventory commitment writes for the committable-warehouse portion
 *   of a partial-hold order happen INSIDE the `apply_order_fulfillment_hold`
 *   RPC (not via `commitOrderItems()`) so the hold write and the
 *   commitment write share a single ACID transaction (Rule #64,
 *   SKU-AUTO-21). Callers pass `commitLines` on the input and the DB
 *   function does the ON CONFLICT DO NOTHING insert.
 *
 * Scope exclusions:
 *   * This module does NOT send client alerts. The
 *     `send-non-warehouse-order-hold-alert` Trigger task (Phase 3.C,
 *     SKU-AUTO-16) is enqueued by the caller after this wrapper
 *     returns `ok: true`, guarded by the bulk-hold suppression check.
 *   * This module does NOT update Redis inventory keys. The
 *     inventory_commitments trigger keeps the counter in lockstep
 *     inside the RPC transaction; fanout to Redis is not part of the
 *     commit path.
 */

/**
 * Valid values for `p_reason` on `apply_order_fulfillment_hold`.
 * Exactly mirrors the TS `HoldReason` union in
 * `src/lib/server/order-hold-policy.ts` MINUS the `all_lines_warehouse_ready`
 * sentinel (which is a "no hold" signal and must never reach this RPC).
 */
export type ApplyHoldReason =
  | "unknown_remote_sku"
  | "placeholder_remote_sku"
  | "non_warehouse_match"
  | "fetch_incomplete_at_match";

/**
 * Valid values for `p_resolution_code` on `release_order_fulfillment_hold`.
 * The DB-side CHECK enforces this whitelist; we mirror it in the type
 * so callers get a compile-time error for typos.
 */
export type ReleaseResolutionCode =
  | "staff_override"
  | "fetch_recovered_evaluator_passed"
  | "alias_learned"
  | "manual_sku_fix"
  | "order_cancelled";

/**
 * Actor classification captured in the `metadata.actor_kind` column of
 * `order_fulfillment_hold_events`. `actor_id` is optional and must be a
 * `users(id)` UUID when present.
 */
export type ActorKind = "system" | "task" | "user" | "recovery_task";

/**
 * A single committable-warehouse line to be persisted into
 * `inventory_commitments` in the SAME TRANSACTION as the hold write
 * (SKU-AUTO-21). `sku` MUST be non-empty and `qty` MUST be a positive
 * integer; invalid rows are silently skipped by the RPC (matches the
 * existing `commitOrderItems()` behavior for Shopify free-with-purchase
 * tracking rows).
 */
export interface CommitLine {
  sku: string;
  qty: number;
}

export interface ApplyOrderFulfillmentHoldInput {
  orderId: string;
  connectionId: string;
  reason: ApplyHoldReason;
  cycleId: string;
  heldLines: Array<Record<string, unknown>>;
  commitLines?: ReadonlyArray<CommitLine>;
  actorKind?: ActorKind;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

export type ApplyOrderFulfillmentHoldErrorReason =
  | "invalid_hold_reason"
  | "missing_cycle_id"
  | "order_not_found"
  | "order_cancelled"
  | "cycle_id_conflict"
  | "rpc_error"
  | "unexpected_response_shape";

export type ApplyOrderFulfillmentHoldResult =
  | { ok: true; holdEventId: string; commitsInserted: number; idempotent: boolean }
  | { ok: false; reason: ApplyOrderFulfillmentHoldErrorReason; detail?: string };

export interface ReleaseOrderFulfillmentHoldInput {
  orderId: string;
  resolutionCode: ReleaseResolutionCode;
  note?: string | null;
  actorKind?: ActorKind;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

export type ReleaseOrderFulfillmentHoldErrorReason =
  | "invalid_resolution_code"
  | "staff_override_missing_note"
  | "order_not_found"
  | "order_not_on_hold"
  | "cycle_id_corrupt"
  | "rpc_error"
  | "unexpected_response_shape";

export type ReleaseOrderFulfillmentHoldResult =
  | { ok: true; holdEventId: string; idempotent: boolean }
  | { ok: false; reason: ReleaseOrderFulfillmentHoldErrorReason; detail?: string };

/**
 * Structural subset of supabase-js that these wrappers depend on.
 * Same shape used in `sku-outcome-transitions.ts` /
 * `sku-alias-promotion.ts` — the tests pass a plain object that
 * conforms to this interface.
 */
export interface HoldRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

// ──────────────────────────────────────────────────────────────────────
// Client-side validation (pure, also used by Phase 3.C tests)
// ──────────────────────────────────────────────────────────────────────

const APPLY_HOLD_REASONS = new Set<ApplyHoldReason>([
  "unknown_remote_sku",
  "placeholder_remote_sku",
  "non_warehouse_match",
  "fetch_incomplete_at_match",
]);

const RELEASE_RESOLUTION_CODES = new Set<ReleaseResolutionCode>([
  "staff_override",
  "fetch_recovered_evaluator_passed",
  "alias_learned",
  "manual_sku_fix",
  "order_cancelled",
]);

export function isApplyHoldReason(value: string): value is ApplyHoldReason {
  return APPLY_HOLD_REASONS.has(value as ApplyHoldReason);
}

export function isReleaseResolutionCode(value: string): value is ReleaseResolutionCode {
  return RELEASE_RESOLUTION_CODES.has(value as ReleaseResolutionCode);
}

// ──────────────────────────────────────────────────────────────────────
// RPC error → typed-reason mapping
// ──────────────────────────────────────────────────────────────────────

function mapApplyHoldRpcError(message: string): ApplyOrderFulfillmentHoldErrorReason {
  if (/invalid hold reason/i.test(message)) return "invalid_hold_reason";
  if (/p_cycle_id is required/i.test(message)) return "missing_cycle_id";
  if (/order\s+[0-9a-f-]+\s+not found/i.test(message)) return "order_not_found";
  if (/is cancelled; cannot hold/i.test(message)) return "order_cancelled";
  if (/already on_hold with cycle/i.test(message)) return "cycle_id_conflict";
  return "rpc_error";
}

function mapReleaseHoldRpcError(message: string): ReleaseOrderFulfillmentHoldErrorReason {
  if (/invalid resolution_code/i.test(message)) return "invalid_resolution_code";
  if (/staff_override requires a note/i.test(message)) return "staff_override_missing_note";
  if (/order\s+[0-9a-f-]+\s+not found/i.test(message)) return "order_not_found";
  if (/cannot release/i.test(message)) return "order_not_on_hold";
  if (/cycle_id is NULL/i.test(message)) return "cycle_id_corrupt";
  return "rpc_error";
}

// ──────────────────────────────────────────────────────────────────────
// apply_order_fulfillment_hold wrapper
// ──────────────────────────────────────────────────────────────────────

interface ApplyHoldRpcRow {
  hold_event_id: string;
  commits_inserted: number;
}

function extractApplyHoldRow(data: unknown): ApplyHoldRpcRow | null {
  if (!data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const holdEventId = r.hold_event_id;
  const commits = r.commits_inserted;
  if (typeof holdEventId !== "string" || holdEventId.length === 0) return null;
  if (typeof commits !== "number" || !Number.isFinite(commits)) return null;
  return { hold_event_id: holdEventId, commits_inserted: commits };
}

/**
 * Apply a fulfillment hold to a warehouse order, atomically with the
 * same-transaction inventory commit for committable-warehouse lines.
 *
 * Pre-RPC guards (fail fast without hitting the DB):
 *   * `reason` must be a known `ApplyHoldReason`.
 *   * `cycleId` must be a non-empty string (caller is responsible for
 *     generating a stable UUID per decision).
 *
 * The RPC enforces defense-in-depth: the same reason check, a
 * FOR UPDATE lock, a per-order advisory lock, cycle-id idempotency,
 * and the commit inserts. See migration 20260428000003 for the full
 * contract.
 *
 * `idempotent: true` on the result means the RPC observed an existing
 * `hold_applied` row for the same `(order_id, cycle_id)` and
 * short-circuited. Callers treat this as a successful apply and MUST
 * NOT enqueue a duplicate client-alert task.
 */
export async function applyOrderFulfillmentHold(
  supabase: HoldRpcClient,
  input: ApplyOrderFulfillmentHoldInput,
): Promise<ApplyOrderFulfillmentHoldResult> {
  if (!isApplyHoldReason(input.reason)) {
    return { ok: false, reason: "invalid_hold_reason", detail: input.reason };
  }
  if (!input.cycleId || input.cycleId.length === 0) {
    return { ok: false, reason: "missing_cycle_id" };
  }

  // Sanitize commit lines client-side so the RPC only sees well-formed
  // objects. Invalid entries (non-string sku, non-positive qty) are
  // dropped here rather than relying on the RPC's silent-skip path —
  // keeps the audit trail free of "silent drops".
  const sanitizedCommitLines: CommitLine[] = (input.commitLines ?? [])
    .filter(
      (it): it is CommitLine =>
        typeof it.sku === "string" &&
        it.sku.length > 0 &&
        Number.isFinite(it.qty) &&
        it.qty > 0 &&
        Number.isInteger(it.qty),
    )
    .map((it) => ({ sku: it.sku, qty: it.qty }));

  const args = {
    p_order_id: input.orderId,
    p_connection_id: input.connectionId,
    p_reason: input.reason,
    p_cycle_id: input.cycleId,
    p_held_lines: input.heldLines,
    p_commit_lines: sanitizedCommitLines,
    p_actor_kind: input.actorKind ?? "system",
    p_actor_id: input.actorId ?? null,
    p_metadata: input.metadata ?? {},
  };

  const { data, error } = await supabase.rpc("apply_order_fulfillment_hold", args);

  if (error) {
    return {
      ok: false,
      reason: mapApplyHoldRpcError(error.message),
      detail: error.message,
    };
  }

  const row = extractApplyHoldRow(data);
  if (!row) {
    return { ok: false, reason: "unexpected_response_shape" };
  }

  // commits_inserted=0 means either (a) no commitLines were supplied,
  // or (b) all supplied commits hit the unique-index conflict (retry),
  // or (c) the RPC short-circuited because the cycle already exists.
  // The caller cannot distinguish (a/b) from (c) without extra state;
  // `idempotent` on the result reflects (c) specifically.
  const idempotent = row.commits_inserted === 0 && sanitizedCommitLines.length > 0;

  return {
    ok: true,
    holdEventId: row.hold_event_id,
    commitsInserted: row.commits_inserted,
    idempotent,
  };
}

// ──────────────────────────────────────────────────────────────────────
// release_order_fulfillment_hold wrapper
// ──────────────────────────────────────────────────────────────────────

/**
 * Release a previously-applied fulfillment hold.
 *
 * Pre-RPC guards:
 *   * `resolutionCode` must be a known `ReleaseResolutionCode`.
 *   * `staff_override` requires a non-whitespace `note`.
 *
 * The RPC enforces defense-in-depth with the same whitelist and the
 * staff_override note requirement, plus state validation (only
 * transitions from `on_hold` are legal).
 *
 * `idempotent: true` means the RPC observed the order was already in
 * `released` state and returned the most recent hold_released event
 * id. Callers treat this as success.
 *
 * Returns the hold_released event id (not the applied event id). The
 * event row carries the resolution_code + actor metadata and is the
 * audit source for "who released what and why".
 */
export async function releaseOrderFulfillmentHold(
  supabase: HoldRpcClient,
  input: ReleaseOrderFulfillmentHoldInput,
): Promise<ReleaseOrderFulfillmentHoldResult> {
  if (!isReleaseResolutionCode(input.resolutionCode)) {
    return { ok: false, reason: "invalid_resolution_code", detail: input.resolutionCode };
  }
  if (
    input.resolutionCode === "staff_override" &&
    (!input.note || input.note.trim().length === 0)
  ) {
    return { ok: false, reason: "staff_override_missing_note" };
  }

  const args = {
    p_order_id: input.orderId,
    p_resolution_code: input.resolutionCode,
    p_note: input.note ?? null,
    p_actor_kind: input.actorKind ?? "system",
    p_actor_id: input.actorId ?? null,
    p_metadata: input.metadata ?? {},
  };

  const { data, error } = await supabase.rpc("release_order_fulfillment_hold", args);

  if (error) {
    return {
      ok: false,
      reason: mapReleaseHoldRpcError(error.message),
      detail: error.message,
    };
  }

  const holdEventId = extractReleaseHoldEventId(data);
  if (!holdEventId) {
    return { ok: false, reason: "unexpected_response_shape" };
  }

  // The RPC returns the existing hold_released event id on idempotent
  // retry and a fresh id on the first release. The wrapper cannot
  // distinguish these without an extra read; `idempotent: false` is the
  // conservative default, and callers that care can check
  // `warehouse_orders.fulfillment_hold` after the fact.
  return { ok: true, holdEventId, idempotent: false };
}

/**
 * `release_order_fulfillment_hold` returns a scalar uuid. PostgREST
 * surfaces it either as a bare string or as a single-element array
 * (depending on the version). Object-wrapped shape is defensive.
 */
function extractReleaseHoldEventId(data: unknown): string | null {
  if (typeof data === "string" && data.length > 0) return data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "string" && first.length > 0) return first;
    if (first && typeof first === "object") {
      const v = (first as Record<string, unknown>).release_order_fulfillment_hold;
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>).release_order_fulfillment_hold;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
