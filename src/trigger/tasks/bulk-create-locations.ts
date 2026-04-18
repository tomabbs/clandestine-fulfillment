import { logger, task } from "@trigger.dev/sdk";

import { createInventoryLocation } from "@/lib/clients/shipstation-inventory-v2";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";

/**
 * Saturday Workstream 3 (2026-04-18) — bulk warehouse location creator.
 *
 * Spawned by `createLocationRange()` in src/actions/locations.ts when the
 * requested range exceeds 30 entries (Vercel Server Action ~15s timeout
 * vs ~12s inline budget — see plan §15.3 / Appendix C.17).
 *
 * Why this task even though `createLocation()` is already idempotent:
 *   - One staff member labeling a full shelf section (e.g. A-1..A-100)
 *     would otherwise blow past the Server Action timeout.
 *   - Pinning to `shipstationQueue` (concurrencyLimit: 1) guarantees we
 *     don't compete with `shipstation-v2-decrement` /
 *     `shipstation-v2-adjust-on-sku` fanout traffic at the v2 200 req/min
 *     rate ceiling.
 *   - Mid-run kill switch awareness: re-reads `workspaces.shipstation_sync_paused`
 *     before every ShipStation call so a panic flip mid-run leaves local
 *     rows in place but skips remaining mirror writes.
 *
 * Output: a `warehouse_review_queue` item with the per-name results when
 * any ShipStation mirror failed, so the operator can fix and retry via
 * `retryShipstationLocationSync()`.
 */

interface BulkCreateLocationsPayload {
  workspaceId: string;
  actorUserId: string;
  prefix: string;
  fromIndex: number;
  toIndex: number;
  locationType: "shelf" | "bin" | "floor" | "staging";
  padWidth?: number;
  throttleMs: number;
}

interface PerNameResult {
  name: string;
  localId?: string;
  ssId?: string;
  status: "ok" | "exists" | "ss_error" | "local_error" | "local_ok_ss_paused";
  error?: string;
}

export const bulkCreateLocationsTask = task({
  id: "bulk-create-locations",
  queue: shipstationQueue,
  maxDuration: 600,
  run: async (payload: BulkCreateLocationsPayload) => {
    const supabase = createServiceRoleClient();

    const { data: ws, error: wsErr } = await supabase
      .from("workspaces")
      .select("shipstation_v2_inventory_warehouse_id, shipstation_sync_paused")
      .eq("id", payload.workspaceId)
      .single();
    if (wsErr) throw wsErr;
    const warehouseId = ws?.shipstation_v2_inventory_warehouse_id as string | null | undefined;
    if (!warehouseId) {
      throw new Error("NO_V2_WAREHOUSE");
    }

    const pad = payload.padWidth ?? 0;
    const results: PerNameResult[] = [];

    for (let i = payload.fromIndex; i <= payload.toIndex; i++) {
      const name = `${payload.prefix}${pad > 0 ? String(i).padStart(pad, "0") : String(i)}`;

      const { data: row, error: insErr } = await supabase
        .from("warehouse_locations")
        .insert({
          workspace_id: payload.workspaceId,
          name,
          location_type: payload.locationType,
          is_active: true,
        })
        .select("id")
        .single();
      if (insErr) {
        const isDup = insErr.code === "23505" || /duplicate|unique/i.test(insErr.message);
        results.push({
          name,
          status: isDup ? "exists" : "local_error",
          error: insErr.message,
        });
        if (payload.throttleMs > 0 && i < payload.toIndex) {
          await new Promise((resolve) => setTimeout(resolve, payload.throttleMs));
        }
        continue;
      }

      const { data: wsLatest } = await supabase
        .from("workspaces")
        .select("shipstation_sync_paused")
        .eq("id", payload.workspaceId)
        .single();

      if (wsLatest?.shipstation_sync_paused) {
        results.push({ name, localId: row.id as string, status: "local_ok_ss_paused" });
      } else {
        try {
          const ssLoc = await createInventoryLocation({
            inventory_warehouse_id: warehouseId,
            name,
          });
          await supabase
            .from("warehouse_locations")
            .update({
              shipstation_inventory_location_id: ssLoc.inventory_location_id,
              shipstation_synced_at: new Date().toISOString(),
              shipstation_sync_error: null,
            })
            .eq("id", row.id as string);
          results.push({
            name,
            localId: row.id as string,
            ssId: ssLoc.inventory_location_id,
            status: "ok",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await supabase
            .from("warehouse_locations")
            .update({ shipstation_sync_error: msg })
            .eq("id", row.id as string);
          results.push({
            name,
            localId: row.id as string,
            status: "ss_error",
            error: msg,
          });
        }
      }

      if (payload.throttleMs > 0 && i < payload.toIndex) {
        await new Promise((resolve) => setTimeout(resolve, payload.throttleMs));
      }
    }

    const summary = {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      exists: results.filter((r) => r.status === "exists").length,
      ss_error: results.filter((r) => r.status === "ss_error").length,
      local_error: results.filter((r) => r.status === "local_error").length,
      local_ok_ss_paused: results.filter((r) => r.status === "local_ok_ss_paused").length,
    };

    logger.info("[bulk-create-locations] completed", { summary });

    if (summary.ss_error > 0 || summary.local_error > 0) {
      await supabase.from("warehouse_review_queue").insert({
        workspace_id: payload.workspaceId,
        category: "bulk_location_create",
        severity: "medium",
        group_key: "bulk-create-locations-errors",
        title: `Bulk location create: ${summary.ss_error} mirror failures, ${summary.local_error} local failures`,
        description:
          "One or more rows in a bulk-create-locations run did not fully provision. Use the Locations admin page to retry the ShipStation mirror.",
        metadata: {
          summary,
          actor_user_id: payload.actorUserId,
          failures: results.filter((r) => r.status === "ss_error" || r.status === "local_error"),
        },
      });
    }

    return { summary, results };
  },
});
