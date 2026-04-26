/**
 * Normalized client-store order shape — the single adapter contract that
 * both the live webhook ingest (`process-client-store-webhook.handleOrderCreated`)
 * and the poll ingest (`client-store-order-detect`) must produce before
 * calling the shared order-hold evaluator.
 *
 * Plan reference:
 *   - Autonomous SKU matching plan §"Normalized order adapter" (lines
 *     1884–1908): defines the shape, identifies release gate SKU-AUTO-3
 *     (both paths must construct this same type and feed the same
 *     evaluator), and says the adapter lives alongside the webhook body
 *     helper so it can be unit-tested without platform SDKs.
 *   - Plan §1497 lists `loadNormalizedOrder(orderId)` as the DB hydration
 *     helper built ON TOP of this module.
 *
 * Design rules for this file:
 *   - PURE types + PURE adapter. No DB I/O, no Date.now(), no random.
 *     The DB-backed loader lives in `normalized-order-loader.ts` and
 *     delegates all actual shape construction to functions here so every
 *     caller — webhook, poll, Trigger recovery task, loader tests —
 *     produces byte-identical `NormalizedClientStoreOrder` values for the
 *     same inputs.
 *   - Platform enum is `"shopify" | "woocommerce" | "squarespace"`. Those
 *     are the autonomous-matching-eligible platforms per plan
 *     §"Platform Scope". Bandcamp orders arrive through a different
 *     pipeline (`bandcamp-sale-poll`), and Discogs orders do not trigger
 *     the hold flow at all (see `client-store-order-detect.ts` Discogs
 *     skip comment). Construction helpers REJECT `"bandcamp"`,
 *     `"manual"`, or `"discogs"` sources and force callers to treat
 *     those as "do not evaluate".
 *   - `NormalizedOrderLine.remoteSku` is `string | null`. A null remoteSku
 *     is a real, expected shape for `evaluateOrderForHold` to treat as
 *     `unmapped_sku` (plan §1910 step 2). Callers must NOT coerce null
 *     to empty string — `isPlaceholderSku("")` would fire, but
 *     `isPlaceholderSku(null)` would not, and the hold-reason taxonomy
 *     distinguishes them.
 *
 * Non-goals:
 *   - This module does NOT do HMAC verification, deduplication, or
 *     side-effect writes (no inserts, no fanout, no alerts). Those are
 *     owned by the existing webhook/poll paths and are explicitly outside
 *     the Phase 2 adapter contract.
 *   - This module does NOT resolve the `warehouse_orders.id` internal
 *     UUID from a remote payload; that's the DB loader's job in the
 *     recovery path. Adapters here take the already-resolved
 *     `(workspaceId, orgId, connectionId)` tuple as input.
 */

import type { ClientStoreConnection } from "@/lib/shared/types";

/**
 * The three autonomous-matching-eligible platforms. Any other
 * `client_store_connections.platform` value (notably `"bandcamp"` and
 * `"discogs"`) is intentionally NOT supported by this adapter — per the
 * plan's Platform Scope section, autonomous matching only runs against
 * Shopify, WooCommerce, and Squarespace.
 */
export const AUTONOMOUS_MATCHING_PLATFORMS = ["shopify", "woocommerce", "squarespace"] as const;
export type AutonomousMatchingPlatform = (typeof AUTONOMOUS_MATCHING_PLATFORMS)[number];

export function isAutonomousMatchingPlatform(
  platform: string | null | undefined,
): platform is AutonomousMatchingPlatform {
  if (!platform) return false;
  return (AUTONOMOUS_MATCHING_PLATFORMS as readonly string[]).includes(platform);
}

/**
 * A single line in a normalized client-store order. Matches the plan
 * shape in §1896–1902.
 *
 * Invariants (enforced by the adapter, NOT by consumers):
 *   - `quantity` is a strictly positive integer. Lines with
 *     `quantity <= 0` (the occasional "zero-qty refund line" that
 *     Shopify/Woo emit) are DROPPED by the adapter so `evaluateOrderForHold`
 *     never has to special-case them.
 *   - `remoteSku` is null OR the raw remote string value, passed through
 *     WITHOUT normalization. The hold evaluator needs the raw string to
 *     distinguish placeholder variants — normalization is a Phase 2.B /
 *     ranker concern.
 *   - `title` is the raw remote line title (Shopify: `line_item.title`;
 *     Woo: `line_items.name`; Squarespace: `lineItems.productName +
 *     variantOptions`). Used for the "lines held for client action"
 *     staff surface (plan §1978) and the client email template.
 *   - `remoteProductId` / `remoteVariantId` are platform-stable
 *     identifiers. Used by `evaluateOrderForHold` to join against
 *     `client_store_product_identity_matches.remote_product_id` /
 *     `remote_variant_id` when `remoteSku` is null or placeholder (plan
 *     §1919 step 3).
 *   - `warehouseOrderItemId` is the internal `warehouse_order_items.id`
 *     UUID, stamped by the loader so downstream hold events can
 *     reference per-line rows. Only the DB loader sets this; pure
 *     webhook/poll adapters that run BEFORE the order row is inserted
 *     leave it `null`, which is legal.
 */
export interface NormalizedOrderLine {
  readonly remoteSku: string | null;
  readonly remoteProductId: string | null;
  readonly remoteVariantId: string | null;
  readonly quantity: number;
  readonly title: string | null;
  /** warehouse_order_items.id once the row has been inserted; null at ingest time. */
  readonly warehouseOrderItemId: string | null;
}

/**
 * The normalized shape that both the webhook path and the poll path
 * must produce before calling the shared hold evaluator. Matches plan
 * §1889–1903.
 *
 * The `source: "webhook" | "poll"` discriminator is carried through to
 * the evaluator so telemetry can answer "did this hold arrive via
 * webhook or poll, and are the rates consistent?" (release gate
 * SKU-AUTO-3 forensics).
 */
export interface NormalizedClientStoreOrder {
  readonly workspaceId: string;
  readonly orgId: string;
  readonly connectionId: string;
  readonly platform: AutonomousMatchingPlatform;
  readonly remoteOrderId: string;
  readonly source: "webhook" | "poll" | "recovery";
  readonly lines: ReadonlyArray<NormalizedOrderLine>;
  /**
   * Internal warehouse_orders.id once the row exists. Null at webhook
   * ingest BEFORE the insert, non-null for the poll path and for the
   * `sku-hold-recovery-recheck` loader (which reads an existing row).
   */
  readonly warehouseOrderId: string | null;
  /**
   * ISO-8601 string of `warehouse_orders.created_at` (poll/recovery) or
   * the webhook delivery time (webhook path). Downstream telemetry uses
   * it to bucket holds by order age; the hold evaluator itself does not
   * read it.
   */
  readonly orderCreatedAt: string | null;
}

/**
 * Why a caller can't produce a NormalizedClientStoreOrder from a raw
 * DB row. These are DIAGNOSTIC codes — they flow to logs and the
 * sku-hold-recovery-recheck task's "still cannot evaluate, stay held"
 * fallback, NOT to end users.
 *
 * Each code maps to a specific consumer behavior:
 *   - `unsupported_platform`: the workspace has a Bandcamp / Discogs /
 *     manual order, which the autonomous pipeline must not touch. The
 *     caller SHOULD pass the order through the legacy flow without a
 *     hold evaluator call.
 *   - `missing_connection`: we have an order row but can't find any
 *     `client_store_connections` row matching its source in this
 *     workspace. This is a data bug — surface to operators via the
 *     existing review queue, not silently skipped.
 *   - `ambiguous_connection`: >=2 active connections match the order's
 *     `(workspace_id, platform)`. Single-connection-per-platform is the
 *     documented convention; ambiguity means a migration left orphaned
 *     rows. The caller SHOULD create a review queue item and NOT
 *     attempt to evaluate the hold against a guessed connection.
 *   - `no_lines`: the `warehouse_order_items` join returned zero rows.
 *     That is real — Shopify and Woo can emit an order with zero line
 *     items during certain refund sequences — but the hold evaluator
 *     has no lines to classify. Callers should treat this as "nothing
 *     to hold" and short-circuit.
 *   - `order_not_found`: the `warehouse_orders.id` passed to the loader
 *     doesn't exist. Typically means the order was deleted between
 *     enqueue and run; the caller should drop the task silently.
 */
export type NormalizeOrderFailureReason =
  | "unsupported_platform"
  | "missing_connection"
  | "ambiguous_connection"
  | "no_lines"
  | "order_not_found";

export type NormalizeOrderResult =
  | { ok: true; order: NormalizedClientStoreOrder }
  | { ok: false; reason: NormalizeOrderFailureReason; detail?: string };

/**
 * Raw warehouse_orders row fields the pure adapter cares about. Kept
 * structurally-typed (not tied to the Supabase types generator) so the
 * loader can hand-assemble a subset in tests without mocking the full
 * Supabase row.
 */
export interface RawWarehouseOrderRow {
  id: string;
  workspace_id: string;
  org_id: string;
  external_order_id: string | null;
  source: string | null;
  created_at: string | null;
}

/**
 * Raw warehouse_order_items row fields the pure adapter cares about.
 */
export interface RawWarehouseOrderItemRow {
  id: string;
  sku: string | null;
  quantity: number | null;
  title: string | null;
  shopify_line_item_id: string | null;
}

/**
 * Construct a NormalizedClientStoreOrder from already-fetched DB rows
 * plus a resolved connection.
 *
 * This is the PURE core the loader wraps. It does ZERO I/O; tests can
 * exercise every branch without any Supabase mock.
 *
 * Contract:
 *   - Returns `{ ok: false, reason: 'unsupported_platform' }` if the
 *     order's `source` is not a recognized autonomous-matching platform.
 *     Recognized `source` values for THIS adapter are only the three
 *     autonomous-matching platforms — Bandcamp/manual/Discogs return
 *     `unsupported_platform` by design.
 *   - Returns `{ ok: false, reason: 'no_lines' }` when the items array
 *     is empty OR every row has `quantity <= 0` (zero-qty rows are
 *     filtered per the `NormalizedOrderLine.quantity` invariant).
 *   - Otherwise returns `{ ok: true, order: ... }` with lines sorted by
 *     `warehouse_order_items.id` so the output is deterministic across
 *     runs (required for the SKU-AUTO-3 reference-fixture test that
 *     asserts webhook and poll paths produce byte-identical orders).
 *   - `source: 'webhook' | 'poll' | 'recovery'` is passed in by the
 *     caller; this function does NOT infer it. That keeps the pure
 *     function time-independent.
 */
export function buildNormalizedOrder(args: {
  orderRow: RawWarehouseOrderRow;
  orderItemRows: ReadonlyArray<RawWarehouseOrderItemRow>;
  connection: Pick<ClientStoreConnection, "id" | "workspace_id" | "org_id" | "platform"> | null;
  source: "webhook" | "poll" | "recovery";
}): NormalizeOrderResult {
  const { orderRow, orderItemRows, connection, source } = args;

  if (!isAutonomousMatchingPlatform(orderRow.source)) {
    return {
      ok: false,
      reason: "unsupported_platform",
      detail: `order.source=${orderRow.source ?? "<null>"} is not in {shopify, woocommerce, squarespace}`,
    };
  }

  if (!connection) {
    return {
      ok: false,
      reason: "missing_connection",
      detail: `no active client_store_connections row found for order ${orderRow.id}`,
    };
  }

  if (connection.platform !== orderRow.source) {
    return {
      ok: false,
      reason: "missing_connection",
      detail: `connection.platform=${connection.platform} but order.source=${orderRow.source}`,
    };
  }

  if (!orderRow.external_order_id) {
    return {
      ok: false,
      reason: "order_not_found",
      detail: `warehouse_orders.external_order_id is null on row ${orderRow.id}`,
    };
  }

  const lines: NormalizedOrderLine[] = [];
  const sortedItems = [...orderItemRows].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of sortedItems) {
    const qty = typeof item.quantity === "number" ? item.quantity : 0;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    lines.push({
      remoteSku: item.sku ?? null,
      remoteProductId: null,
      remoteVariantId: item.shopify_line_item_id ?? null,
      quantity: Math.floor(qty),
      title: item.title ?? null,
      warehouseOrderItemId: item.id,
    });
  }

  if (lines.length === 0) {
    return {
      ok: false,
      reason: "no_lines",
      detail: `order ${orderRow.id} has no line items with quantity > 0`,
    };
  }

  return {
    ok: true,
    order: {
      workspaceId: orderRow.workspace_id,
      orgId: orderRow.org_id,
      connectionId: connection.id,
      platform: orderRow.source as AutonomousMatchingPlatform,
      remoteOrderId: orderRow.external_order_id,
      source,
      lines,
      warehouseOrderId: orderRow.id,
      orderCreatedAt: orderRow.created_at ?? null,
    },
  };
}

/**
 * The webhook path constructs a NormalizedClientStoreOrder BEFORE
 * inserting the warehouse_orders row — it already has the connectionId
 * (from the webhook header) and the raw payload, but no internal UUID
 * yet. This helper handles that shape.
 *
 * Use case: `process-client-store-webhook.handleOrderCreated()` calls
 * this with the parsed Shopify/Woo/Squarespace payload and the
 * connection row, producing a normalized order that the SHARED
 * `evaluateOrderForHold()` consumes BEFORE the DB insert. If the
 * evaluator decides "hold", the insert path then stamps
 * `fulfillment_hold='on_hold'` atomically rather than racing a
 * separate update.
 *
 * The raw-payload input is intentionally untyped (`unknown`) because
 * each platform has a distinct line-item shape; this helper delegates
 * shape-specific parsing to small per-platform pure mappers kept
 * alongside it (added in Slice 2.B once the evaluator is wired).
 */
export function normalizeWebhookOrderFromLines(args: {
  workspaceId: string;
  orgId: string;
  connectionId: string;
  platform: AutonomousMatchingPlatform;
  remoteOrderId: string;
  lines: ReadonlyArray<{
    remoteSku: string | null;
    remoteProductId?: string | null;
    remoteVariantId?: string | null;
    quantity: number;
    title?: string | null;
  }>;
}): NormalizeOrderResult {
  const filtered: NormalizedOrderLine[] = [];
  for (const raw of args.lines) {
    const qty = typeof raw.quantity === "number" ? raw.quantity : 0;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    filtered.push({
      remoteSku: raw.remoteSku,
      remoteProductId: raw.remoteProductId ?? null,
      remoteVariantId: raw.remoteVariantId ?? null,
      quantity: Math.floor(qty),
      title: raw.title ?? null,
      warehouseOrderItemId: null,
    });
  }

  if (filtered.length === 0) {
    return {
      ok: false,
      reason: "no_lines",
      detail: `webhook order ${args.remoteOrderId} has no line items with quantity > 0`,
    };
  }

  return {
    ok: true,
    order: {
      workspaceId: args.workspaceId,
      orgId: args.orgId,
      connectionId: args.connectionId,
      platform: args.platform,
      remoteOrderId: args.remoteOrderId,
      source: "webhook",
      lines: filtered,
      warehouseOrderId: null,
      orderCreatedAt: null,
    },
  };
}
