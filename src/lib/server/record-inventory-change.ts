import { adjustInventory } from "@/lib/clients/redis-inventory";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { InventorySource } from "@/lib/shared/types";

interface RecordInventoryChangeParams {
  workspaceId: string;
  sku: string;
  delta: number;
  source: InventorySource;
  correlationId: string;
  metadata?: Record<string, unknown>;
  /**
   * Explicit per-call fanout control for controlled bulk writes.
   *
   * Baseline imports update warehouse truth row-by-row but must not enqueue a
   * storefront/Bandcamp/ShipStation push for every workbook row. A final
   * reconciliation sweep pushes the post-import state instead.
   */
  fanout?: {
    suppress: boolean;
    reason?: string;
  };
  /**
   * Phase 3 D4 — originating client_store_connections.id when this event
   * came from a storefront webhook. Plumbed through to fanoutInventoryChange
   * so the per-connection echo override (`connection_echo_overrides`) can
   * flip echo-skip OFF for connections that have completed cutover-direct.
   *
   * Convention: webhook handlers SHOULD pass this explicitly. Older call
   * sites that just include `connection_id` inside `metadata` continue to
   * work — the lookup falls back to `metadata.connection_id` for backward
   * compatibility, but the explicit field is the canonical surface.
   */
  originatingConnectionId?: string | null;
}

interface RecordInventoryChangeResult {
  success: boolean;
  newQuantity: number | null;
  alreadyProcessed: boolean;
}

/**
 * Rule #20: Single inventory write path. ALL inventory changes flow through this function.
 * No code path may directly mutate warehouse_inventory_levels or Redis inv:* keys outside this function.
 *
 * Rule #43 execution order:
 * (1) acquire correlationId (passed in)
 * (2) Redis HINCRBY via adjustInventory with SETNX guard (Rule #47)
 * (3) Postgres RPC record_inventory_change_txn in single transaction (Rule #64)
 * (4) enqueue fanout (non-blocking)
 *
 * If step 3 fails after step 2, Redis is rolled back immediately via a compensating
 * adjustInventory call with a :rollback correlation ID. The sensor-check auto-heal
 * (every 5 min) is a secondary safety net, not the primary recovery mechanism.
 */
export async function recordInventoryChange(
  params: RecordInventoryChangeParams,
): Promise<RecordInventoryChangeResult> {
  const {
    workspaceId,
    sku,
    delta,
    source,
    correlationId,
    metadata,
    fanout,
    originatingConnectionId,
  } = params;
  // Phase 3 D4 — back-compat: pull connection_id from metadata if the caller
  // hasn't surfaced it explicitly. Existing webhook handlers already write
  // `metadata: { connection_id }` so this gives the per-connection echo
  // override coverage of every storefront-driven event without touching every
  // call site. Explicit field wins when both are set.
  const resolvedOriginatingConnectionId =
    originatingConnectionId ??
    (typeof metadata?.connection_id === "string" ? (metadata.connection_id as string) : null);

  const redisResult = await adjustInventory(sku, "available", delta, correlationId);

  if (redisResult === null) {
    return { success: true, newQuantity: null, alreadyProcessed: true };
  }

  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.rpc("record_inventory_change_txn", {
      p_workspace_id: workspaceId,
      p_sku: sku,
      p_delta: delta,
      p_source: source,
      p_correlation_id: correlationId,
      p_metadata: metadata ?? {},
    });

    if (error) throw error;
  } catch (err) {
    try {
      await adjustInventory(sku, "available", -delta, `${correlationId}:rollback`);
    } catch (rollbackErr) {
      console.error(
        `[recordInventoryChange] CRITICAL: Redis rollback also failed. ` +
          `SKU=${sku} delta=${delta} correlationId=${correlationId}`,
        rollbackErr,
      );
    }
    console.error(
      `[recordInventoryChange] Postgres failed, Redis rolled back. ` +
        `SKU=${sku} delta=${delta} correlationId=${correlationId}`,
      err,
    );
    return { success: false, newQuantity: null, alreadyProcessed: false };
  }

  if (fanout?.suppress) {
    return { success: true, newQuantity: redisResult, alreadyProcessed: false };
  }

  try {
    const { fanoutInventoryChange } = await import("@/lib/server/inventory-fanout");
    // Audit fix F1 (2026-04-13): forward the `source` so the fanout layer
    // can echo-skip ShipStation v2 for events that already reflect v2
    // state (`shipstation` SHIP_NOTIFY, `reconcile` drift sensor). All
    // other sources legitimately need the v2 fanout push.
    fanoutInventoryChange(
      workspaceId,
      sku,
      redisResult,
      delta,
      correlationId,
      source,
      resolvedOriginatingConnectionId,
    ).catch((err) => {
      console.error(`[recordInventoryChange] Fanout failed for SKU=${sku}:`, err);
    });
  } catch {
    // Fanout is non-critical — cron jobs will pick up changes
  }

  return { success: true, newQuantity: redisResult, alreadyProcessed: false };
}
