/**
 * Autonomous SKU matcher — Phase 5.C: sku-hold-recovery-recheck Trigger task.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"sku-hold-recovery-recheck" (new, round 4) +
 *       §"Webhook and poll order-ingest consistency" +
 *       SKU-AUTO-17 (release resolution-code whitelist) +
 *       Rule #48 (Server Actions enqueue Trigger; tasks do the work).
 *
 * Scope
 * ─────
 * A 30-minute-cadence sweep that finds `warehouse_orders` rows held
 * with `fulfillment_hold_reason='fetch_incomplete_at_match'` in the
 * last 24 hours and auto-releases them with resolution_code
 * `fetch_recovered_evaluator_passed` when two things are BOTH true:
 *
 *   1. A fresh `fetchRemoteCatalogWithTimeout()` call against the
 *      order's connection succeeds (platform health recovered).
 *   2. `evaluateOrderForHold(normalizedOrder)` returns
 *      `shouldHold === false` (no lines are still non-committable).
 *
 * Either condition failing means the hold stays. We do NOT retry
 * aggressively — the next 30-minute tick is the retry cadence.
 *
 * Release path (SKU-AUTO-17):
 *   `releaseOrderFulfillmentHold()` is the single legal release
 *   channel. The DB-level CHECK on `p_resolution_code` enforces the
 *   whitelist (`fetch_recovered_evaluator_passed` is one of five
 *   allowed values) — defense in depth against a typo or a rogue
 *   caller passing a free-form string.
 *
 * Per-workspace emergency pause
 * ─────────────────────────────
 * The pause DOES block this task per plan §1175:
 *   > Every autonomous task MUST call `checkEmergencyPause()` before
 *   > its first write.
 * The plan note at §1176 ("the order-hold evaluator reads identity
 * rows but never writes identity rows; the pause does NOT block
 * order-hold evaluation") applies to the webhook-ingress demotion
 * rehydrate path, NOT to this batch task which DOES write a release
 * event. Fail-closed on pause-read errors, consistent with the
 * sampler + shadow-promotion tasks.
 *
 * Queue policy
 * ────────────
 * NOT pinned to `bandcamp-api` (Rule #9 / #60). The task makes
 * outbound HTTP calls to Shopify / WooCommerce / Squarespace APIs
 * via `fetchRemoteCatalogWithTimeout()`, which manages its own
 * per-platform timeouts. Runs on the default Trigger queue.
 *
 * Idempotency
 * ───────────
 * `releaseOrderFulfillmentHold()` is idempotent by contract — if the
 * order is already `released`, the RPC returns the existing event id.
 * A double delivery re-processes the same order and both workers
 * observe idempotent successes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger, schedules, task } from "@trigger.dev/sdk";
import { loadNormalizedOrder } from "@/lib/server/normalized-order-loader";
import { evaluateOrderForHold } from "@/lib/server/order-hold-evaluator";
import {
  type HoldRpcClient,
  type ReleaseOrderFulfillmentHoldResult,
  releaseOrderFulfillmentHold,
} from "@/lib/server/order-hold-rpcs";
import { fetchRemoteCatalogWithTimeout } from "@/lib/server/sku-matching";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  type EmergencyPauseSupabaseClient,
  readWorkspaceEmergencyPause,
} from "@/lib/server/workspace-flags";
import type { ClientStoreConnection } from "@/lib/shared/types";

const HOLD_RECOVERY_LOOKBACK_HOURS = 24;
const ORDERS_PER_WORKSPACE_LIMIT = 200;

type RecoverySupabaseClient = SupabaseClient;

export interface RunSkuHoldRecoveryRecheckOptions {
  supabase?: RecoverySupabaseClient;
  now?: Date;
  /**
   * Test hook: override the catalog fetcher so we never make real
   * Shopify/Woo/Squarespace HTTP calls in unit tests.
   */
  fetchCatalog?: typeof fetchRemoteCatalogWithTimeout;
  /**
   * Test hook: override the release wrapper.
   */
  releaser?: typeof releaseOrderFulfillmentHold;
  /**
   * Test hook: override the normalized order loader.
   */
  loadOrder?: typeof loadNormalizedOrder;
  /**
   * Test hook: override the hold evaluator.
   */
  evaluate?: typeof evaluateOrderForHold;
}

export type OrderRecoveryStatus =
  | "released"
  | "release_failed"
  | "still_holds"
  | "fetch_failed"
  | "load_failed"
  | "connection_missing"
  | "evaluate_failed";

export interface OrderRecoveryResult {
  order_id: string;
  status: OrderRecoveryStatus;
  detail?: string;
}

export interface WorkspaceRecoveryResult {
  workspace_id: string;
  status: "ok" | "emergency_paused" | "pause_read_failed" | "orders_read_failed";
  orders_scanned: number;
  orders_released: number;
  orders_still_held: number;
  orders_errored: number;
  per_order: OrderRecoveryResult[];
  detail?: string;
}

export interface HoldRecoveryRunResult {
  started_at: string;
  cutoff_iso: string;
  workspaces_scanned: number;
  workspaces_processed: number;
  total_orders_scanned: number;
  total_released: number;
  total_still_held: number;
  total_errors: number;
  per_workspace: WorkspaceRecoveryResult[];
}

export async function runSkuHoldRecoveryRecheck(
  options: RunSkuHoldRecoveryRecheckOptions = {},
): Promise<HoldRecoveryRunResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const fetchCatalog = options.fetchCatalog ?? fetchRemoteCatalogWithTimeout;
  const releaser = options.releaser ?? releaseOrderFulfillmentHold;
  const loadOrder = options.loadOrder ?? loadNormalizedOrder;
  const evaluate = options.evaluate ?? evaluateOrderForHold;

  const cutoff = new Date(now.getTime() - HOLD_RECOVERY_LOOKBACK_HOURS * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const result: HoldRecoveryRunResult = {
    started_at: now.toISOString(),
    cutoff_iso: cutoffIso,
    workspaces_scanned: 0,
    workspaces_processed: 0,
    total_orders_scanned: 0,
    total_released: 0,
    total_still_held: 0,
    total_errors: 0,
    per_workspace: [],
  };

  const { data: workspaces, error: wsError } = await supabase.from("workspaces").select("id");
  if (wsError) {
    logger.error("sku-hold-recovery-recheck: workspaces read failed", {
      error: wsError.message,
    });
    return result;
  }
  const workspaceIds = (workspaces ?? []).map((w) => w.id as string).filter(Boolean);
  result.workspaces_scanned = workspaceIds.length;

  for (const workspaceId of workspaceIds) {
    const wr = await processWorkspace(supabase, workspaceId, cutoffIso, {
      fetchCatalog,
      releaser,
      loadOrder,
      evaluate,
    });
    result.per_workspace.push(wr);
    if (wr.status === "ok") {
      result.workspaces_processed += 1;
      result.total_orders_scanned += wr.orders_scanned;
      result.total_released += wr.orders_released;
      result.total_still_held += wr.orders_still_held;
      result.total_errors += wr.orders_errored;
    }
  }

  logger.info("sku-hold-recovery-recheck: pass complete", {
    workspaces_scanned: result.workspaces_scanned,
    workspaces_processed: result.workspaces_processed,
    orders_scanned: result.total_orders_scanned,
    released: result.total_released,
    still_held: result.total_still_held,
    errors: result.total_errors,
  });

  return result;
}

interface ProcessWorkspaceDeps {
  fetchCatalog: typeof fetchRemoteCatalogWithTimeout;
  releaser: typeof releaseOrderFulfillmentHold;
  loadOrder: typeof loadNormalizedOrder;
  evaluate: typeof evaluateOrderForHold;
}

async function processWorkspace(
  supabase: RecoverySupabaseClient,
  workspaceId: string,
  cutoffIso: string,
  deps: ProcessWorkspaceDeps,
): Promise<WorkspaceRecoveryResult> {
  const base: WorkspaceRecoveryResult = {
    workspace_id: workspaceId,
    status: "ok",
    orders_scanned: 0,
    orders_released: 0,
    orders_still_held: 0,
    orders_errored: 0,
    per_order: [],
  };

  const pauseCheck = await readWorkspaceEmergencyPause(
    supabase as unknown as EmergencyPauseSupabaseClient,
    workspaceId,
  );
  if (pauseCheck.kind === "error") {
    return { ...base, status: "pause_read_failed", detail: pauseCheck.detail };
  }
  if (pauseCheck.paused) {
    return { ...base, status: "emergency_paused" };
  }

  const { data: orders, error } = await supabase
    .from("warehouse_orders")
    .select("id, source, fulfillment_hold_at")
    .eq("workspace_id", workspaceId)
    .eq("fulfillment_hold", "on_hold")
    .eq("fulfillment_hold_reason", "fetch_incomplete_at_match")
    .gte("fulfillment_hold_at", cutoffIso)
    .order("fulfillment_hold_at", { ascending: true })
    .limit(ORDERS_PER_WORKSPACE_LIMIT);

  if (error) {
    logger.error("sku-hold-recovery-recheck: orders read failed", {
      workspace_id: workspaceId,
      detail: error.message,
    });
    return { ...base, status: "orders_read_failed", detail: error.message };
  }

  const rows = (orders ?? []) as Array<{ id: string; source: string | null }>;
  base.orders_scanned = rows.length;

  for (const row of rows) {
    const outcome = await recoverOrder(supabase, workspaceId, row.id, deps);
    base.per_order.push(outcome);
    if (outcome.status === "released") base.orders_released += 1;
    else if (outcome.status === "still_holds") base.orders_still_held += 1;
    else if (outcome.status === "fetch_failed") {
      // fetch_failed is expected when a platform is still unhealthy;
      // not an error from our perspective.
      base.orders_still_held += 1;
    } else base.orders_errored += 1;
  }

  return base;
}

async function recoverOrder(
  supabase: RecoverySupabaseClient,
  workspaceId: string,
  orderId: string,
  deps: ProcessWorkspaceDeps,
): Promise<OrderRecoveryResult> {
  // Load the order in its normalized form. Reuses the loader's
  // deterministic connection resolution (active connection on the
  // same platform) — ambiguity short-circuits and surfaces as an
  // error on this order.
  const loaded = await deps.loadOrder(supabase, orderId, { source: "recovery" });
  if (!loaded.ok) {
    return {
      order_id: orderId,
      status: "load_failed",
      detail: `${loaded.reason}${loaded.detail ? `: ${loaded.detail}` : ""}`,
    };
  }

  // Fetch the full connection row so fetchRemoteCatalogWithTimeout
  // can reach the correct credentials. The normalized order carries
  // only the narrow connection subset.
  const { data: connRow, error: connErr } = await supabase
    .from("client_store_connections")
    .select("*")
    .eq("id", loaded.order.connectionId)
    .maybeSingle();

  if (connErr || !connRow) {
    return {
      order_id: orderId,
      status: "connection_missing",
      detail: connErr?.message ?? "connection row missing",
    };
  }

  // Health probe: does the platform respond with a fresh catalog?
  // We don't use the items directly here — the evaluator reads DB
  // state, not the live catalog — but a successful fetch is the
  // plan's explicit recovery signal. Anything else and we defer.
  const fetchResult = await deps.fetchCatalog(connRow as unknown as ClientStoreConnection);
  if (fetchResult.state !== "ok") {
    return {
      order_id: orderId,
      status: "fetch_failed",
      detail: `${fetchResult.state}${fetchResult.error ? `: ${fetchResult.error}` : ""}`,
    };
  }

  // Re-evaluate the hold policy against fresh DB state.
  const evaluation = await deps.evaluate(supabase, loaded.order);
  if (!evaluation.ok) {
    return {
      order_id: orderId,
      status: "evaluate_failed",
      detail: evaluation.detail,
    };
  }

  if (evaluation.decision.shouldHold === true) {
    return { order_id: orderId, status: "still_holds" };
  }

  // All clear — release the hold.
  const released: ReleaseOrderFulfillmentHoldResult = await deps.releaser(
    supabase as unknown as HoldRpcClient,
    {
      orderId,
      resolutionCode: "fetch_recovered_evaluator_passed",
      note: null,
      actorKind: "recovery_task",
      actorId: null,
      metadata: {
        workspace_id: workspaceId,
        entry_point: "sku-hold-recovery-recheck",
      },
    },
  );

  if (!released.ok) {
    logger.warn("sku-hold-recovery-recheck: release failed", {
      workspace_id: workspaceId,
      order_id: orderId,
      reason: released.reason,
      detail: released.detail,
    });
    return {
      order_id: orderId,
      status: "release_failed",
      detail: `${released.reason}${released.detail ? `: ${released.detail}` : ""}`,
    };
  }

  return { order_id: orderId, status: "released" };
}

export const skuHoldRecoveryRecheckScheduledTask = schedules.task({
  id: "sku-hold-recovery-recheck",
  cron: "*/30 * * * *",
  maxDuration: 600,
  run: async () => runSkuHoldRecoveryRecheck(),
});

export const skuHoldRecoveryRecheckManualTask = task({
  id: "sku-hold-recovery-recheck-manual",
  maxDuration: 600,
  run: async () => runSkuHoldRecoveryRecheck(),
});
