/**
 * Async orchestrator around the pure `order-hold-policy` classifier.
 *
 * `evaluateOrderForHold(supabase, order)` pre-fetches every piece of
 * per-line state the classifier needs, runs `classifyOrderLine` per
 * line (pure), and rolls up via `decideOrderHold` (pure).
 *
 * Plan references:
 *   - §1494 lists `evaluateOrderForHold(normalizedOrder)` as the
 *     helper this file provides.
 *   - §1906–1907: both webhook ingest and poll ingest call this
 *     evaluator. Release gate SKU-AUTO-3 fails if they diverge.
 *   - §1915: "The evaluator is pure — it reads DB state but writes
 *     nothing." The writes (fulfillment_hold stamp,
 *     order_fulfillment_hold_events insert, inventory_commitments,
 *     alert-task enqueue) happen in `applyFulfillmentHold()` — a
 *     future Slice 2.C/2.D module that CALLs this evaluator first.
 *
 * Data fetched per evaluator call (batched across ALL lines of the
 * order, not per-line, so an N-line order costs ~4 queries not 4N):
 *   - ACTIVE rows from `client_store_sku_mappings` where
 *     `(connection_id, remote_sku) IN (order.connectionId, line.remoteSku)`
 *     for every non-null, non-placeholder line SKU.
 *   - ACTIVE rows from `client_store_product_identity_matches` where
 *     `(connection_id, remote_sku) IN (...)` — same filter.
 *   - `warehouse_inventory_levels.available` for every variant_id
 *     referenced by a matched alias row.
 *   - Latest `sku_autonomous_decisions.fetch_status` per variant_id
 *     referenced by a matched identity row (for the
 *     `fetch_incomplete_at_match` escalation rule).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { NormalizedClientStoreOrder } from "@/lib/server/normalized-order";
import {
  buildHoldDecision,
  classifyOrderLine,
  type HoldDecision,
  type HoldLineClassification,
  type OrderLineState,
} from "@/lib/server/order-hold-policy";
import { isPlaceholderSku } from "@/lib/shared/utils";

type DbClient = SupabaseClient;

export interface EvaluateOrderForHoldOptions {
  /**
   * If true, trust warehouse_inventory_levels.available even when null
   * (treat null as 0). Default: true — the classifier already maps
   * null-or-non-positive to `non_warehouse_sku` for lines with a live
   * alias, which is the correct production default. Tests flip this
   * only to exercise the pure classifier's branch.
   */
  readonly treatMissingStockAsZero?: boolean;
}

/**
 * Minimal shape the orchestrator fetches from `client_store_sku_mappings`.
 */
interface AliasRow {
  id: string;
  connection_id: string;
  remote_sku: string | null;
  variant_id: string;
  is_active: boolean;
}

interface IdentityRow {
  id: string;
  connection_id: string;
  remote_sku: string | null;
  variant_id: string | null;
  is_active: boolean;
  outcome_state: string;
}

interface InventoryLevelRow {
  variant_id: string;
  available: number | null;
}

interface FetchStatusRow {
  variant_id: string | null;
  fetch_status: string | null;
  fetch_completed_at: string | null;
}

/**
 * Return type:
 *   - `ok: true` when the evaluator produced a complete decision.
 *     Callers ALWAYS check `decision.shouldHold` to branch.
 *   - `ok: false` with `reason` when an unrecoverable DB error
 *     occurred. The caller should NOT proceed to apply a hold or
 *     commit inventory on a partial view of the state — better to
 *     surface the error and retry via the calling task.
 */
export type EvaluateOrderForHoldResult =
  | {
      ok: true;
      decision: HoldDecision & { orderId: string | null; connectionId: string; source: string };
      classifications: ReadonlyArray<HoldLineClassification>;
    }
  | { ok: false; reason: "db_error"; detail: string };

export async function evaluateOrderForHold(
  supabase: DbClient,
  order: NormalizedClientStoreOrder,
  _options: EvaluateOrderForHoldOptions = {},
): Promise<EvaluateOrderForHoldResult> {
  const connectionId = order.connectionId;
  const workspaceId = order.workspaceId;

  const evaluatableSkus = new Set<string>();
  for (const line of order.lines) {
    if (line.remoteSku !== null && !isPlaceholderSku(line.remoteSku)) {
      evaluatableSkus.add(line.remoteSku);
    }
  }

  let aliasRows: AliasRow[] = [];
  let identityRows: IdentityRow[] = [];
  if (evaluatableSkus.size > 0) {
    const skuList = Array.from(evaluatableSkus);

    const aliasResponse = await supabase
      .from("client_store_sku_mappings")
      .select("id, connection_id, remote_sku, variant_id, is_active")
      .eq("connection_id", connectionId)
      .eq("is_active", true)
      .in("remote_sku", skuList);

    if (aliasResponse.error) {
      return {
        ok: false,
        reason: "db_error",
        detail: `client_store_sku_mappings lookup failed: ${aliasResponse.error.message}`,
      };
    }
    aliasRows = (aliasResponse.data ?? []) as AliasRow[];

    const identityResponse = await supabase
      .from("client_store_product_identity_matches")
      .select("id, connection_id, remote_sku, variant_id, is_active, outcome_state")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", connectionId)
      .eq("is_active", true)
      .in("remote_sku", skuList);

    if (identityResponse.error) {
      return {
        ok: false,
        reason: "db_error",
        detail: `client_store_product_identity_matches lookup failed: ${identityResponse.error.message}`,
      };
    }
    identityRows = (identityResponse.data ?? []) as IdentityRow[];
  }

  const aliasBySku = new Map<string, AliasRow>();
  for (const row of aliasRows) {
    if (row.remote_sku !== null) aliasBySku.set(row.remote_sku, row);
  }

  const identityBySku = new Map<string, IdentityRow>();
  for (const row of identityRows) {
    if (row.remote_sku !== null) identityBySku.set(row.remote_sku, row);
  }

  const variantIdsForStock = new Set<string>();
  for (const row of aliasRows) variantIdsForStock.add(row.variant_id);

  const variantIdsForFetchStatus = new Set<string>();
  for (const row of identityRows) {
    if (row.variant_id !== null) variantIdsForFetchStatus.add(row.variant_id);
  }

  const availableByVariant = new Map<string, number | null>();
  if (variantIdsForStock.size > 0) {
    const invResponse = await supabase
      .from("warehouse_inventory_levels")
      .select("variant_id, available")
      .eq("workspace_id", workspaceId)
      .in("variant_id", Array.from(variantIdsForStock));
    if (invResponse.error) {
      return {
        ok: false,
        reason: "db_error",
        detail: `warehouse_inventory_levels lookup failed: ${invResponse.error.message}`,
      };
    }
    for (const row of (invResponse.data ?? []) as InventoryLevelRow[]) {
      const existing = availableByVariant.get(row.variant_id);
      const incoming = typeof row.available === "number" ? row.available : null;
      if (existing === undefined) {
        availableByVariant.set(row.variant_id, incoming);
      } else if (existing !== null && incoming !== null) {
        availableByVariant.set(row.variant_id, existing + incoming);
      } else if (incoming !== null) {
        availableByVariant.set(row.variant_id, incoming);
      }
    }
  }

  const latestFetchStatusByVariant = new Map<string, FetchStatusRow["fetch_status"]>();
  if (variantIdsForFetchStatus.size > 0) {
    const fetchResponse = await supabase
      .from("sku_autonomous_decisions")
      .select("variant_id, fetch_status, fetch_completed_at")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", connectionId)
      .in("variant_id", Array.from(variantIdsForFetchStatus))
      .order("fetch_completed_at", { ascending: false, nullsFirst: false });
    if (fetchResponse.error) {
      return {
        ok: false,
        reason: "db_error",
        detail: `sku_autonomous_decisions lookup failed: ${fetchResponse.error.message}`,
      };
    }
    for (const row of (fetchResponse.data ?? []) as FetchStatusRow[]) {
      if (row.variant_id === null) continue;
      if (latestFetchStatusByVariant.has(row.variant_id)) continue;
      latestFetchStatusByVariant.set(row.variant_id, row.fetch_status);
    }
  }

  const classifications: HoldLineClassification[] = [];
  for (const line of order.lines) {
    const remoteSku = line.remoteSku;
    const alias = remoteSku !== null ? (aliasBySku.get(remoteSku) ?? null) : null;
    const identity = remoteSku !== null ? (identityBySku.get(remoteSku) ?? null) : null;
    const variantIdForStock = alias?.variant_id ?? null;
    const variantIdForFetch = identity?.variant_id ?? null;

    const state: OrderLineState = {
      alias: alias ? { id: alias.id, variantId: alias.variant_id } : null,
      identityMatch: identity ? { id: identity.id, variantId: identity.variant_id } : null,
      warehouseAvailable:
        variantIdForStock !== null ? (availableByVariant.get(variantIdForStock) ?? null) : null,
      latestFetchStatus: narrowFetchStatus(
        variantIdForFetch !== null
          ? (latestFetchStatusByVariant.get(variantIdForFetch) ?? null)
          : null,
      ),
    };

    classifications.push(classifyOrderLine(line, state));
  }

  const decision = buildHoldDecision({ order, classifications });
  return { ok: true, decision, classifications };
}

const FETCH_STATUS_VALUES = [
  "ok",
  "timeout",
  "auth_error",
  "unavailable",
  "unsupported",
  "partial",
] as const;

type FetchStatusValue = (typeof FETCH_STATUS_VALUES)[number];

function narrowFetchStatus(raw: string | null): FetchStatusValue | null {
  if (raw === null) return null;
  return (FETCH_STATUS_VALUES as readonly string[]).includes(raw)
    ? (raw as FetchStatusValue)
    : null;
}
