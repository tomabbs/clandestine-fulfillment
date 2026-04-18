/**
 * ShipStation manual store refresh — Phase 3 (plan §7.1.7).
 *
 * Intent: when a Clandestine Shopify draft is saved (new product / SKU
 * change), trigger ShipStation to re-import that store's catalog
 * immediately rather than waiting for the 24h auto-import window.
 *
 * STATUS: ENDPOINT TBD (Open Question #2 in plan, blocks Phase 3 exit
 * criteria). Candidate endpoints to verify:
 *   - `POST /stores/refreshstore` (v1, undocumented) — observed in
 *     reverse-engineered traffic but never confirmed by ShipStation docs.
 *   - "Refresh Store" button in the ShipStation web UI may be UI-only
 *     with no public API.
 *
 * Fallback per plan Part 13.1 (day-one race fallback): if no public
 * endpoint exists, this task records the refresh REQUEST in
 * `channel_sync_log` and the operator UI surfaces "Pending — ShipStation
 * will auto-import within 24h". The reconcile sensor (Phase 5) catches
 * any seeding done before catalog refresh by detecting SKUs we tried to
 * seed that don't yet exist in v2.
 *
 * Until the endpoint is confirmed, this task is INTENTIONALLY a stub
 * that logs the request, writes the channel_sync_log row, and returns
 * `status: "deferred"`. Wiring sites (Server Action that triggers it
 * after a Clandestine Shopify draft save) can call it without code
 * change — the stub semantics are stable; only the internal
 * implementation flips when the endpoint is confirmed.
 *
 * Rule #7: createServiceRoleClient.
 * Rule #12: payload IDs only.
 */

import { logger, task } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

export interface ShipstationStoreRefreshPayload {
  /** Workspace owning the store being refreshed (logging only). */
  workspaceId: string;
  /**
   * ShipStation v1 store_id. Captured for the future call but unused
   * while the endpoint is TBD.
   */
  storeId: number;
  /** Optional human-readable note for the audit row. */
  reason?: string;
}

export type ShipstationStoreRefreshStatus = "deferred" | "requested" | "skipped";

export interface ShipstationStoreRefreshResult {
  status: ShipstationStoreRefreshStatus;
  reason: string;
  store_id: number;
  workspace_id: string;
}

/**
 * Inner run function — exported for unit testing without touching
 * Trigger.dev's `task()` wrapper internals.
 */
export async function runShipstationStoreRefresh(
  payload: ShipstationStoreRefreshPayload,
  ctx: { run: { id: string } },
): Promise<ShipstationStoreRefreshResult> {
  const { workspaceId, storeId, reason } = payload;
  const supabase = createServiceRoleClient();

  const startedAt = new Date().toISOString();
  await supabase.from("channel_sync_log").insert({
    workspace_id: workspaceId,
    channel: "shipstation_v1",
    sync_type: "store_refresh",
    status: "started",
    started_at: startedAt,
    metadata: {
      run_id: ctx.run.id,
      store_id: storeId,
      reason: reason ?? "manual",
      endpoint_status: "tbd",
    },
  });

  // ──────────────────────────────────────────────────────────────────────
  // STUB: until Open Question #2 resolves, we record the request and
  // honor the day-one race fallback. The 24h auto-import will catch
  // up; the Phase 5 reconcile sensor will detect any SKU drift in the
  // meantime.
  // ──────────────────────────────────────────────────────────────────────
  const result: ShipstationStoreRefreshResult = {
    status: "deferred",
    reason: "endpoint_tbd_using_24h_auto_import_fallback",
    store_id: storeId,
    workspace_id: workspaceId,
  };

  logger.warn("[shipstation-store-refresh] endpoint TBD — recording request only", {
    workspace_id: workspaceId,
    store_id: storeId,
  });

  await supabase
    .from("channel_sync_log")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      items_processed: 0,
      metadata: { run_id: ctx.run.id, ...result },
    })
    .eq("workspace_id", workspaceId)
    .eq("channel", "shipstation_v1")
    .eq("started_at", startedAt);

  return result;
}

export const shipstationStoreRefreshTask = task({
  id: "shipstation-store-refresh",
  queue: shipstationQueue,
  maxDuration: 60,
  run: async (
    payload: ShipstationStoreRefreshPayload,
    { ctx },
  ): Promise<ShipstationStoreRefreshResult> => runShipstationStoreRefresh(payload, ctx),
});
