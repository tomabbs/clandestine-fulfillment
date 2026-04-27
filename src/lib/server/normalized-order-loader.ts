/**
 * DB-backed loader that hydrates a `warehouse_orders.id` into the
 * canonical NormalizedClientStoreOrder shape defined in
 * `normalized-order.ts`.
 *
 * Consumers (Phase 2+):
 *   - `sku-hold-recovery-recheck` Trigger task (plan §1499, §1997)
 *     iterates held orders and re-evaluates via
 *     `evaluateOrderForHold(await loadNormalizedOrder(order.id))`.
 *   - Poll-path hold evaluation (plan §1912) where we read the order we
 *     just inserted and evaluate the hold policy before enqueueing
 *     fulfillment.
 *   - Staff-surface "why is this held?" drawer (plan §1978) — the
 *     frontend reads the normalized shape to render per-line reasons.
 *
 * Non-goals:
 *   - This loader does NOT own side effects. It reads, normalizes,
 *     returns. Hold stamping, review queue inserts, and fanout
 *     suppression happen in the callers.
 *   - This loader does NOT re-fetch remote data from Shopify/Woo — it
 *     trusts `warehouse_orders` / `warehouse_order_items` as the
 *     canonical ingest-time snapshot. If remote payloads later drift,
 *     that's a separate re-ingest concern.
 *
 * Connection resolution:
 *   The `warehouse_orders` table does NOT store `connection_id`. Orders
 *   are keyed by `(workspace_id, source, external_order_id)`. The loader
 *   must therefore resolve the matching `client_store_connections` row
 *   by `(workspace_id, platform=order.source, connection_status IN
 *   {'active', 'degraded'})`. The conventional invariant is ONE active
 *   connection per (workspace, platform); if we find ≥2 we refuse to
 *   guess and return `ambiguous_connection` so operators see a
 *   deterministic error rather than a silently-wrong fanout. This is
 *   the defensive surface SKU-AUTO-3 exists to protect.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type AutonomousMatchingPlatform,
  buildNormalizedOrder,
  isAutonomousMatchingPlatform,
  type NormalizeOrderResult,
  type RawWarehouseOrderItemRow,
  type RawWarehouseOrderRow,
} from "@/lib/server/normalized-order";

// The codebase convention (see external-sync-events.ts, carrier-map.ts,
// etc.) is to accept the un-generic `SupabaseClient` rather than pull in
// a generated `Database` type. Follow that convention here so this
// loader can be reused from both server actions (where the client is
// typed by `createServerSupabaseClient`) and Trigger tasks (service
// role client). The cost is that column-name typos go unchecked at
// compile time — mitigated by the exhaustive loader unit tests in
// `normalized-order-loader.test.ts`.
type DbClient = SupabaseClient;

/**
 * Minimal connection shape the adapter needs. Kept narrower than
 * `ClientStoreConnection` so mocks stay small and so the loader
 * expresses exactly the columns it reads from the DB.
 */
export interface LoaderConnectionRow {
  id: string;
  workspace_id: string;
  org_id: string;
  platform: AutonomousMatchingPlatform;
  connection_status: string;
  last_webhook_at: string | null;
  last_poll_at: string | null;
}

/**
 * Load-path result. Mirrors NormalizeOrderResult but adds the narrower
 * failure reasons the loader itself can produce (beyond what the pure
 * adapter can).
 */
export type LoadNormalizedOrderResult = NormalizeOrderResult;

export interface LoadNormalizedOrderOptions {
  /**
   * Which `source` the caller wants stamped on the normalized order.
   * The loader is used by the webhook-ingress hold flow (after order
   * insert), the poll-ingress hold flow (same), and the
   * sku-hold-recovery-recheck task. All three cases are distinguishable
   * in telemetry so we require the caller to state it explicitly rather
   * than guessing.
   */
  source: "webhook" | "poll" | "recovery";
  /**
   * Override the connection-status filter. Defaults to the two
   * operationally-usable states. Tests set this to `null` to include
   * disabled connections without changing production semantics.
   */
  connectionStatuses?: ReadonlyArray<string> | null;
}

const DEFAULT_CONNECTION_STATUSES = ["active", "degraded"] as const;

/**
 * Hydrate a warehouse_orders row into a NormalizedClientStoreOrder.
 *
 * @param supabase  Server-side Supabase client. MUST be the service_role
 *                  client when called from Trigger tasks (Rule #7) or
 *                  from a Server Action with explicit authz already
 *                  performed by the caller. This function does no
 *                  authorization checks of its own.
 * @param orderId   The `warehouse_orders.id` UUID.
 * @param options   See {@link LoadNormalizedOrderOptions}.
 */
export async function loadNormalizedOrder(
  supabase: DbClient,
  orderId: string,
  options: LoadNormalizedOrderOptions,
): Promise<LoadNormalizedOrderResult> {
  if (!orderId) {
    return { ok: false, reason: "order_not_found", detail: "empty orderId" };
  }

  const orderResponse = await supabase
    .from("warehouse_orders")
    .select("id, workspace_id, org_id, external_order_id, source, created_at")
    .eq("id", orderId)
    .maybeSingle();

  if (orderResponse.error) {
    return {
      ok: false,
      reason: "order_not_found",
      detail: `warehouse_orders lookup failed: ${orderResponse.error.message}`,
    };
  }

  const orderRow = orderResponse.data as RawWarehouseOrderRow | null;
  if (!orderRow) {
    return { ok: false, reason: "order_not_found", detail: orderId };
  }

  if (!isAutonomousMatchingPlatform(orderRow.source)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      detail: `order.source=${orderRow.source ?? "<null>"}`,
    };
  }

  const statuses = options.connectionStatuses ?? DEFAULT_CONNECTION_STATUSES;

  let connectionQuery = supabase
    .from("client_store_connections")
    .select("id, workspace_id, org_id, platform, connection_status, last_webhook_at, last_poll_at")
    .eq("workspace_id", orderRow.workspace_id)
    .eq("platform", orderRow.source);

  if (statuses !== null && statuses.length > 0) {
    connectionQuery = connectionQuery.in("connection_status", statuses as string[]);
  }

  const connectionResponse = await connectionQuery;

  if (connectionResponse.error) {
    return {
      ok: false,
      reason: "missing_connection",
      detail: `client_store_connections lookup failed: ${connectionResponse.error.message}`,
    };
  }

  const candidates = (connectionResponse.data ?? []) as LoaderConnectionRow[];
  const connection = pickBestConnection(candidates);
  if (connection === null) {
    return {
      ok: false,
      reason: "missing_connection",
      detail: `no connection in {${(statuses ?? []).join(",") || "any"}} for workspace=${orderRow.workspace_id} platform=${orderRow.source}`,
    };
  }
  if (connection === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous_connection",
      detail: `found ${candidates.length} active connections for workspace=${orderRow.workspace_id} platform=${orderRow.source}; refusing to guess`,
    };
  }

  const itemsResponse = await supabase
    .from("warehouse_order_items")
    .select("id, sku, quantity, title, shopify_line_item_id")
    .eq("order_id", orderId);

  if (itemsResponse.error) {
    return {
      ok: false,
      reason: "no_lines",
      detail: `warehouse_order_items lookup failed: ${itemsResponse.error.message}`,
    };
  }

  const itemRows = (itemsResponse.data ?? []) as RawWarehouseOrderItemRow[];

  return buildNormalizedOrder({
    orderRow,
    orderItemRows: itemRows,
    connection: {
      id: connection.id,
      workspace_id: connection.workspace_id,
      org_id: connection.org_id,
      platform: connection.platform,
    },
    source: options.source,
  });
}

/**
 * Choose the single winning connection from the candidate set, or
 * return a sentinel indicating "none" / "ambiguous".
 *
 * Rules (keep these simple and auditable — operators read them from
 * the plan):
 *   1. Zero candidates → null (caller maps to `missing_connection`).
 *   2. Exactly one → that one.
 *   3. Multiple → if exactly one has status='active', pick it.
 *   4. Multiple with the same status → "ambiguous" sentinel.
 *
 * This intentionally does NOT pick the "most recent last_webhook_at"
 * because the plan's ambiguity rule is deliberately conservative:
 * silently guessing a connection is worse than surfacing the bug.
 */
function pickBestConnection(
  candidates: ReadonlyArray<LoaderConnectionRow>,
): LoaderConnectionRow | "ambiguous" | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const active = candidates.filter((c) => c.connection_status === "active");
  if (active.length === 1) return active[0];
  return "ambiguous";
}

export type { NormalizedClientStoreOrder } from "@/lib/server/normalized-order";
