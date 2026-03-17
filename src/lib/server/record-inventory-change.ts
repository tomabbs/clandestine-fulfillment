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
 * (4) return result
 *
 * If Redis write succeeds but Postgres fails, log error — periodic reconciliation sensor catches drift.
 */
export async function recordInventoryChange(
  params: RecordInventoryChangeParams,
): Promise<RecordInventoryChangeResult> {
  const { workspaceId, sku, delta, source, correlationId, metadata } = params;

  // Step 1: correlationId is already acquired (passed as parameter)

  // Step 2: Redis HINCRBY with SETNX idempotency guard (Rule #47)
  const redisResult = await adjustInventory(sku, "available", delta, correlationId);

  if (redisResult === null) {
    // Already processed — idempotency key existed
    return { success: true, newQuantity: null, alreadyProcessed: true };
  }

  // Step 3: Postgres RPC in a single ACID transaction (Rule #64)
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

    if (error) {
      // Redis write succeeded but Postgres failed.
      // Log error — periodic reconciliation sensor catches drift (Rule #27).
      console.error(
        `[recordInventoryChange] Postgres RPC failed after Redis write. ` +
          `SKU=${sku} delta=${delta} correlationId=${correlationId} error=${error.message}`,
      );
      return { success: false, newQuantity: redisResult, alreadyProcessed: false };
    }
  } catch (err) {
    console.error(
      `[recordInventoryChange] Postgres RPC exception after Redis write. ` +
        `SKU=${sku} delta=${delta} correlationId=${correlationId}`,
      err,
    );
    return { success: false, newQuantity: redisResult, alreadyProcessed: false };
  }

  // Step 4: enqueue fanout (Rule #43) — non-blocking, best-effort
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
