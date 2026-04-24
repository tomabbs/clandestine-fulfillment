/**
 * Phase 5 §9.6 D1 — inventory commitments helper.
 *
 * Server-side helper used by:
 *   - the orders/create webhook handler (commits stock when an order
 *     lands in `warehouse_orders` from any platform),
 *   - the orders/cancel + orders/fulfill paths (releases stock when an
 *     order is fulfilled or cancelled),
 *   - cycle-count + transfer flows (Wave 5+ — commits a quantity to
 *     the moving location until the transfer is acknowledged).
 *
 * Why this lives in `src/lib/server` and not `src/actions`:
 *   * It is called from Trigger tasks (process-shopify-webhook,
 *     process-client-store-webhook, mark-platform-fulfilled) which
 *     cannot import `"use server"` Server Actions. Server Actions wrap
 *     this helper (e.g., the future manual-hold / staff-release UI)
 *     but the I/O lives here so both call sites share one
 *     implementation.
 *   * Keeps the canonical write path on Rule #58's "one truth per
 *     concern" map: the commit ledger has exactly one writer file.
 *
 * Idempotency guarantee:
 *   The migration (20260424000004) added a UNIQUE partial index on
 *   (workspace_id, source, source_id, sku) WHERE released_at IS NULL.
 *   `commitInventory` uses INSERT ... ON CONFLICT DO NOTHING so
 *   webhook retries (Shopify retries every orders/create up to ~24
 *   times over 48h) cannot double-commit.
 *
 * Trigger lockstep:
 *   The `inventory_commitments_sync` Postgres trigger
 *   (sync_committed_quantity()) updates
 *   warehouse_inventory_levels.committed_quantity inside the SAME
 *   transaction as each ledger mutation. Application code never
 *   touches that column directly. The trigger ALSO blocks unsafe
 *   mutations (un-release, qty change on open row) so the helper does
 *   not need to re-validate them client-side.
 */

import { createServiceRoleClient } from "@/lib/server/supabase-server";

export type CommitmentSource = "order" | "cart" | "transfer" | "manual";

export interface CommitInventoryItem {
  sku: string;
  qty: number;
}

export interface CommitInventoryParams {
  workspaceId: string;
  source: CommitmentSource;
  sourceId: string;
  items: ReadonlyArray<CommitInventoryItem>;
  metadata?: Record<string, unknown>;
}

export interface ReleaseInventoryParams {
  workspaceId: string;
  source: CommitmentSource;
  sourceId: string;
  /**
   * Optional SKU filter — when omitted, releases every open commitment
   * for the (source, source_id) pair (the common case: an order is
   * fulfilled in full, release every line). When provided, only the
   * matching SKUs are released — supports partial fulfillment +
   * partial cancel paths.
   */
  skus?: ReadonlyArray<string>;
  reason: string;
}

export interface CommitInventoryResult {
  /** Number of NEW ledger rows inserted (existing open rows are no-ops). */
  inserted: number;
  /** SKUs that were already open at this (source, source_id). */
  alreadyOpen: string[];
}

export interface ReleaseInventoryResult {
  /** Number of ledger rows whose released_at flipped from NULL to now(). */
  released: number;
}

/**
 * Open one ledger row per (sku, qty) for the supplied source. Uses
 * INSERT ... ON CONFLICT DO NOTHING on the partial unique index so
 * retried webhook deliveries are safe no-ops.
 *
 * Returns the count of NEW rows (vs. retries that hit the unique
 * index) so callers can log a meaningful "X commitments opened, Y
 * already in-flight" diagnostic.
 *
 * Items with non-positive `qty` are silently skipped (matches the
 * CHECK (qty > 0) constraint without raising on legitimate zero-qty
 * line items in webhook payloads — Shopify occasionally emits these
 * for free-with-purchase tracking).
 */
export async function commitInventory(
  params: CommitInventoryParams,
): Promise<CommitInventoryResult> {
  const { workspaceId, source, sourceId, items, metadata } = params;
  const positive = items.filter(
    (it) => it.qty > 0 && typeof it.sku === "string" && it.sku.length > 0,
  );
  if (positive.length === 0) {
    return { inserted: 0, alreadyOpen: [] };
  }

  const supabase = createServiceRoleClient();

  // Aggregate duplicate SKUs in the input (a Shopify order with two
  // line items for the same SKU should produce ONE ledger row at the
  // sum). The unique index would otherwise reject the second insert
  // and silently undercount.
  const aggregated = new Map<string, number>();
  for (const it of positive) {
    aggregated.set(it.sku, (aggregated.get(it.sku) ?? 0) + it.qty);
  }

  const rows = Array.from(aggregated.entries()).map(([sku, qty]) => ({
    workspace_id: workspaceId,
    sku,
    source,
    source_id: sourceId,
    qty,
    metadata: metadata ?? {},
  }));

  const { data, error } = await supabase
    .from("inventory_commitments")
    .upsert(rows, {
      onConflict: "workspace_id,source,source_id,sku",
      ignoreDuplicates: true,
    })
    .select("sku");

  if (error) {
    throw new Error(`commitInventory upsert failed: ${error.message}`);
  }

  const insertedSkus = new Set((data ?? []).map((r) => r.sku as string));
  const alreadyOpen = rows.map((r) => r.sku).filter((sku) => !insertedSkus.has(sku));

  return { inserted: insertedSkus.size, alreadyOpen };
}

/**
 * Flip released_at on every open commitment matching (source,
 * source_id) — optionally narrowed to a SKU subset for partial
 * fulfillment / partial cancel paths.
 *
 * Returns the number of rows actually released (already-released rows
 * are not double-counted because the WHERE clause filters them out).
 *
 * Calling release on a (source, source_id) that has no open rows is
 * NOT an error — it returns { released: 0 }. This matches webhook
 * retry semantics: an orders/cancel that arrives twice releases on
 * the first delivery and is a no-op on the second.
 */
export async function releaseInventory(
  params: ReleaseInventoryParams,
): Promise<ReleaseInventoryResult> {
  const { workspaceId, source, sourceId, skus, reason } = params;
  const supabase = createServiceRoleClient();

  let query = supabase
    .from("inventory_commitments")
    .update({ released_at: new Date().toISOString(), release_reason: reason })
    .eq("workspace_id", workspaceId)
    .eq("source", source)
    .eq("source_id", sourceId)
    .is("released_at", null);

  if (skus && skus.length > 0) {
    query = query.in("sku", skus);
  }

  const { data, error } = await query.select("id");
  if (error) {
    throw new Error(`releaseInventory update failed: ${error.message}`);
  }

  return { released: data?.length ?? 0 };
}

/**
 * ===== Order convenience wrappers =====
 *
 * The orders/create + orders/fulfill + orders/cancel + preorder paths
 * all share the same source identifier shape: `source='order'`,
 * `source_id=warehouse_orders.id`. These thin wrappers exist so each
 * call site doesn't repeat the literal `'order'` string and risk a
 * typo silently bypassing the unique index.
 *
 * They are pure forwarders — no extra DB reads. Callers that already
 * have `warehouse_order_items` in scope (which is the case in every
 * existing handler since the order rows are inserted in the same
 * transaction) pass them in directly.
 */

export interface CommitOrderItemsParams {
  workspaceId: string;
  orderId: string;
  items: ReadonlyArray<CommitInventoryItem>;
  metadata?: Record<string, unknown>;
}

export interface ReleaseOrderItemsParams {
  workspaceId: string;
  orderId: string;
  reason: string;
  skus?: ReadonlyArray<string>;
}

export function commitOrderItems(params: CommitOrderItemsParams): Promise<CommitInventoryResult> {
  return commitInventory({
    workspaceId: params.workspaceId,
    source: "order",
    sourceId: params.orderId,
    items: params.items,
    metadata: { ...(params.metadata ?? {}), kind: "order_items" },
  });
}

export function releaseOrderItems(
  params: ReleaseOrderItemsParams,
): Promise<ReleaseInventoryResult> {
  return releaseInventory({
    workspaceId: params.workspaceId,
    source: "order",
    sourceId: params.orderId,
    reason: params.reason,
    skus: params.skus,
  });
}
