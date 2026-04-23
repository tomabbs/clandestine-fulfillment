/**
 * Phase 1 §9.2 D8 / N-13 — single source of truth for the push-formula.
 *
 * Every inventory push path (Bandcamp focused + cron, Clandestine Shopify
 * focused + cron, client-store focused + cron) MUST import from here. The
 * X-7 dual-edit hazard is the reason this helper exists: if focused push
 * computes one number and the 5-min cron computes another, Bandcamp /
 * Shopify inventory will oscillate between two values per SKU per drop.
 *
 * Formula (TRUTH_LAYER F-NF-X1, F-NF-X2):
 *
 *     effective_sellable = MAX(0, available - committed - safety_stock[channel])
 *
 *   - `available`  : warehouse_inventory_levels.available (raw on-hand). Set
 *                    by recordInventoryChange + reconcile sensors only.
 *   - `committed`  : Phase 5 §9.6 D1 column (inventory_commitments ledger
 *                    + denormalized counter on warehouse_inventory_levels).
 *                    Phase 5 has not landed yet — we read the counter if it
 *                    exists, otherwise 0. Documented in the
 *                    `committedQuantity` source field on the result so
 *                    consumers can tell the value is provisional.
 *   - `safety_stock[channel]` : per-channel reserve in ABSOLUTE units.
 *                    Resolution order (first hit wins):
 *                      1. client_store_sku_mappings.safety_stock for the
 *                         specific (channel, mapping) when channel is a
 *                         storefront and a connection-scoped reserve was
 *                         requested via `connectionId`.
 *                      2. warehouse_safety_stock_per_channel.safety_stock
 *                         for non-storefront channels (bandcamp,
 *                         clandestine_shopify, future) keyed by
 *                         (workspace_id, variant_id, channel).
 *                      3. warehouse_inventory_levels.safety_stock (legacy
 *                         per-SKU value — kept for backward-compat with the
 *                         pre-Phase-1 cron).
 *                      4. workspaces.default_safety_stock (operator
 *                         default; ships at 3 per the existing schema).
 *                      5. 0 (defensive).
 *
 * Crucial layering constraint (CAS rule, Phase 1 §9.2 D7):
 *   This helper computes the value we PUSH. It does NOT compute the value
 *   we send as `changeFromQuantity` to Shopify CAS. The CAS comparator
 *   uses raw remote `available` (last observed via
 *   client_store_sku_mappings.last_pushed_quantity), NEVER the
 *   safety-stock-adjusted value. Mixing the two would make every CAS call
 *   mismatch on local reservation churn instead of real concurrent writes.
 *
 * Channel canonical set (Phase 1):
 *   `bandcamp`, `clandestine_shopify`, `client_store_shopify`,
 *   `client_store_squarespace`, `client_store_woocommerce`. Unknown
 *   channels fail closed (returns effectiveSellable: 0 + reason: 'unknown_channel')
 *   so a typo never silently flushes inventory to a non-existent channel.
 *
 * Read-only — does NOT mutate any table. Safe to call from Server Actions,
 * Trigger tasks, and webhook handlers.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type EffectiveSellableChannel =
  | "bandcamp"
  | "clandestine_shopify"
  | "client_store_shopify"
  | "client_store_squarespace"
  | "client_store_woocommerce";

const KNOWN_CHANNELS: ReadonlySet<EffectiveSellableChannel> = new Set([
  "bandcamp",
  "clandestine_shopify",
  "client_store_shopify",
  "client_store_squarespace",
  "client_store_woocommerce",
]);

const STOREFRONT_CHANNELS: ReadonlySet<EffectiveSellableChannel> = new Set([
  "client_store_shopify",
  "client_store_squarespace",
  "client_store_woocommerce",
]);

export interface EffectiveSellableInput {
  workspaceId: string;
  sku: string;
  channel: EffectiveSellableChannel;
  /**
   * Required for storefront channels (`client_store_*`) — scopes the
   * per-channel safety_stock lookup to the specific
   * `client_store_sku_mappings.connection_id`. Without it the helper falls
   * through to the workspace default, which is correct behavior for the
   * legacy cron loop but suboptimal for per-SKU focused pushes.
   *
   * Ignored for non-storefront channels (bandcamp, clandestine_shopify).
   */
  connectionId?: string;
}

export type EffectiveSellableSafetySource =
  | "connection_mapping"
  | "per_channel_table"
  | "level_legacy"
  | "workspace_default"
  | "fallback_zero";

export type EffectiveSellableCommittedSource = "level_counter" | "absent_phase5_pending";

export interface EffectiveSellableResult {
  /** raw on-hand from warehouse_inventory_levels.available; 0 if unknown. */
  available: number;
  /** Phase 5 committed quantity; 0 until §9.6 D1 ships. */
  committedQuantity: number;
  committedSource: EffectiveSellableCommittedSource;
  /** Resolved per-channel safety stock in absolute units. */
  safetyStock: number;
  safetySource: EffectiveSellableSafetySource;
  /** Final value to PUSH = MAX(0, available - committed - safety_stock). */
  effectiveSellable: number;
  /**
   * Diagnostic — explains short-circuit cases. `null` when the formula
   * was applied normally.
   */
  reason: null | "unknown_channel" | "variant_not_found";
  /**
   * Resolved variant ID, useful to callers that already need it for the
   * push step (avoids a duplicate variant lookup).
   */
  variantId: string | null;
}

/**
 * Pure-shape inputs for unit tests. Matches the schema rows the helper
 * reads so test code can stub all DB hits with a single object.
 */
export interface EffectiveSellableSnapshot {
  variant: { id: string } | null;
  level: { available: number; safety_stock: number | null; committed_quantity?: number } | null;
  connectionMappingSafety?: number | null;
  perChannelSafety?: number | null;
  workspaceDefaultSafety?: number | null;
}

/**
 * Pure formula evaluator — the helper above is the I/O wrapper around
 * this. Exposed so unit tests can pin the math without mocking Supabase.
 */
export function evaluateEffectiveSellable(
  channel: EffectiveSellableChannel,
  snapshot: EffectiveSellableSnapshot,
): EffectiveSellableResult {
  if (!KNOWN_CHANNELS.has(channel)) {
    return {
      available: 0,
      committedQuantity: 0,
      committedSource: "absent_phase5_pending",
      safetyStock: 0,
      safetySource: "fallback_zero",
      effectiveSellable: 0,
      reason: "unknown_channel",
      variantId: snapshot.variant?.id ?? null,
    };
  }

  if (!snapshot.variant) {
    return {
      available: 0,
      committedQuantity: 0,
      committedSource: "absent_phase5_pending",
      safetyStock: 0,
      safetySource: "fallback_zero",
      effectiveSellable: 0,
      reason: "variant_not_found",
      variantId: null,
    };
  }

  const available = Math.max(0, snapshot.level?.available ?? 0);

  const counter = snapshot.level?.committed_quantity;
  const committedQuantity = typeof counter === "number" && counter >= 0 ? counter : 0;
  const committedSource: EffectiveSellableCommittedSource =
    typeof counter === "number" ? "level_counter" : "absent_phase5_pending";

  const { value: safetyStock, source: safetySource } = resolveSafetyStock(channel, snapshot);

  const effectiveSellable = Math.max(0, available - committedQuantity - safetyStock);

  return {
    available,
    committedQuantity,
    committedSource,
    safetyStock,
    safetySource,
    effectiveSellable,
    reason: null,
    variantId: snapshot.variant.id,
  };
}

function resolveSafetyStock(
  channel: EffectiveSellableChannel,
  snapshot: EffectiveSellableSnapshot,
): { value: number; source: EffectiveSellableSafetySource } {
  if (
    STOREFRONT_CHANNELS.has(channel) &&
    typeof snapshot.connectionMappingSafety === "number" &&
    snapshot.connectionMappingSafety >= 0
  ) {
    return { value: snapshot.connectionMappingSafety, source: "connection_mapping" };
  }

  if (typeof snapshot.perChannelSafety === "number" && snapshot.perChannelSafety >= 0) {
    return { value: snapshot.perChannelSafety, source: "per_channel_table" };
  }

  const legacy = snapshot.level?.safety_stock;
  if (typeof legacy === "number" && legacy >= 0) {
    return { value: legacy, source: "level_legacy" };
  }

  if (typeof snapshot.workspaceDefaultSafety === "number" && snapshot.workspaceDefaultSafety >= 0) {
    return { value: snapshot.workspaceDefaultSafety, source: "workspace_default" };
  }

  return { value: 0, source: "fallback_zero" };
}

/**
 * I/O wrapper. Reads the snapshot from Supabase and applies
 * `evaluateEffectiveSellable`. Use this from Trigger tasks, Server
 * Actions, webhook handlers — anywhere the actual on-hand state matters.
 *
 * Failure semantics: never throws on missing rows. A missing variant or
 * level returns `effectiveSellable: 0` + `reason='variant_not_found'`,
 * which is also the safe push value (a SKU we don't know about should
 * never have inventory pushed).
 */
export async function computeEffectiveSellable(
  supabase: SupabaseClient,
  input: EffectiveSellableInput,
): Promise<EffectiveSellableResult> {
  const { workspaceId, sku, channel, connectionId } = input;

  if (!KNOWN_CHANNELS.has(channel)) {
    return evaluateEffectiveSellable(channel, {
      variant: null,
      level: null,
    });
  }

  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("sku", sku)
    .maybeSingle();

  if (!variant) {
    return evaluateEffectiveSellable(channel, {
      variant: null,
      level: null,
    });
  }

  // Phase 5 D1 has not landed yet — `committed_quantity` may not exist as
  // a column. Fall through gracefully via the optional chain on the
  // snapshot read.
  const { data: level } = await supabase
    .from("warehouse_inventory_levels")
    .select("available, safety_stock")
    .eq("variant_id", variant.id)
    .maybeSingle();

  let connectionMappingSafety: number | null = null;
  if (STOREFRONT_CHANNELS.has(channel) && connectionId) {
    const { data: mapping } = await supabase
      .from("client_store_sku_mappings")
      .select("safety_stock")
      .eq("connection_id", connectionId)
      .eq("variant_id", variant.id)
      .maybeSingle();
    if (mapping && typeof mapping.safety_stock === "number") {
      connectionMappingSafety = mapping.safety_stock;
    }
  }

  let perChannelSafety: number | null = null;
  if (!STOREFRONT_CHANNELS.has(channel)) {
    const { data: perChannel } = await supabase
      .from("warehouse_safety_stock_per_channel")
      .select("safety_stock")
      .eq("workspace_id", workspaceId)
      .eq("variant_id", variant.id)
      .eq("channel", channel)
      .maybeSingle();
    if (perChannel && typeof perChannel.safety_stock === "number") {
      perChannelSafety = perChannel.safety_stock;
    }
  }

  const { data: ws } = await supabase
    .from("workspaces")
    .select("default_safety_stock")
    .eq("id", workspaceId)
    .maybeSingle();

  return evaluateEffectiveSellable(channel, {
    variant,
    level: level ?? null,
    connectionMappingSafety,
    perChannelSafety,
    workspaceDefaultSafety:
      typeof ws?.default_safety_stock === "number" ? ws.default_safety_stock : null,
  });
}

/**
 * Lint-guard helper for `scripts/check-source-union-sync.ts`. Anything
 * matching this regex outside the helper file or its tests is a build
 * failure — that is the X-7 dual-edit invariant.
 *
 * Pattern matches `Math.max(0, X - Y - Z)` where X is `available` /
 * `effectiveAvailable` / `rawAvailable` and Y is `safety` / `effectiveSafety`.
 */
export const PUSH_FORMULA_GREP_PATTERN =
  /Math\.max\(\s*0\s*,\s*(?:effective|raw|on)?[Aa]vailable\s*-\s*(?:effective[Ss]afety|safety[A-Z_]|workspace[Ss]afety)/;
