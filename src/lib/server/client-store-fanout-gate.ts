import type { ClientStoreConnection } from "@/lib/shared/types";

/**
 * Client store fanout gate (Phase 0.8 — single dormancy gate, leak-proof).
 *
 * Plan reference: §12.4. ShipStation Inventory Sync is the canonical fanout
 * path to Shopify / WooCommerce / Squarespace; the legacy first-party
 * connectors stay in the codebase but must NOT push by default. Without a
 * single chokepoint, every callsite (Server Actions, cron tasks, webhook
 * handlers) becomes a potential leak — adding a new task that calls
 * `pushInventory()` without first checking `do_not_fanout` would silently
 * resurrect the legacy fanout.
 *
 * This module is the ONE chokepoint. Any code that:
 *   (a) reads from `client_store_connections` for the purpose of pushing
 *       inventory or polling orders, or
 *   (b) processes a webhook from a client store and writes back to it,
 * MUST call `shouldFanoutToConnection()` first and short-circuit on
 * `allow === false`.
 *
 * Wiring contract:
 *   - src/trigger/tasks/multi-store-inventory-push.ts — filter connection list.
 *   - src/trigger/tasks/client-store-order-detect.ts — filter connection list.
 *   - src/trigger/tasks/process-client-store-webhook.ts — drop early on dormant.
 *   - src/lib/clients/store-sync-client.ts — last-line defense at constructor.
 *
 * Discogs: NOT gated here. Discogs connections drive mail-order fulfillment,
 * a separate domain that bypasses the ShipStation Inventory Sync substitution.
 *
 * Lint guard: scripts/check-fanout-gate.sh greps the wiring sites and fails
 * CI if `client_store_connections` writes appear in fanout paths without a
 * neighboring `shouldFanoutToConnection` call.
 */

export type FanoutDenialReason =
  | "do_not_fanout"
  | "auth_failed"
  | "error"
  | "pending"
  | "invalid_cutover_state";

export interface FanoutDecision {
  allow: boolean;
  reason?: FanoutDenialReason;
}

const VALID_CUTOVER_STATES: ReadonlySet<string> = new Set(["legacy", "shadow", "direct"]);

export function shouldFanoutToConnection(connection: ClientStoreConnection): FanoutDecision {
  // Discogs is its own world — never gate it through this function. Callers
  // that pass a Discogs connection by accident are still denied (defensive)
  // because Discogs has zero `do_not_fanout` semantics in our schema today,
  // but the canonical Discogs paths use `discogs-client-order-sync` and
  // similar tasks that don't touch this gate at all.
  if (connection.do_not_fanout) return { allow: false, reason: "do_not_fanout" };
  if (connection.connection_status === "disabled_auth_failure") {
    return { allow: false, reason: "auth_failed" };
  }
  if (connection.connection_status === "error") return { allow: false, reason: "error" };
  if (connection.connection_status === "pending") return { allow: false, reason: "pending" };
  // Phase 3 D1 — defensive cutover_state validation. The DB CHECK constraint
  // (`client_store_connections_cutover_state_check`) and the NOT NULL DEFAULT
  // 'legacy' make this branch unreachable on production data; we keep it as
  // a belt-and-suspenders gate so a bad migration / hand-fired SQL / future
  // enum widening cannot land an unrecognized value into the fanout path.
  // Treating an unknown value as DENY is the safe default — better to surface
  // the bad row in monitoring than to fanout based on undefined semantics.
  //
  // null/undefined is treated as the DB default ('legacy') rather than an
  // invalid value: that matches the column NOT NULL DEFAULT, keeps test
  // fixtures that pre-date Phase 3 working without changes, and is no less
  // safe — the row could not actually exist in the DB without cutover_state
  // being set.
  //
  // Note: the truth-table invalid combos `(shadow|direct, do_not_fanout=true)`
  // are blocked at the DB by `client_store_connections_cutover_dormancy_check`.
  // The do_not_fanout=true check above already short-circuits those rows
  // here too, so this branch only fires on a literal unrecognized state.
  const cutoverState = connection.cutover_state ?? "legacy";
  if (!VALID_CUTOVER_STATES.has(cutoverState)) {
    return { allow: false, reason: "invalid_cutover_state" };
  }
  return { allow: true };
}

/**
 * Convenience predicate for filter() chains.
 */
export function isFanoutAllowed(connection: ClientStoreConnection): boolean {
  return shouldFanoutToConnection(connection).allow;
}
