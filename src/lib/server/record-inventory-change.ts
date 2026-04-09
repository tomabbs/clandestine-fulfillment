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
  const { workspaceId, sku, delta, source, correlationId, metadata } = params;

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

  try {
    const { fanoutInventoryChange } = await import("@/lib/server/inventory-fanout");
    fanoutInventoryChange(workspaceId, sku, redisResult).catch((err) => {
      console.error(`[recordInventoryChange] Fanout failed for SKU=${sku}:`, err);
    });
  } catch {
    // Fanout is non-critical — cron jobs will pick up changes
  }

  return { success: true, newQuantity: redisResult, alreadyProcessed: false };
}
