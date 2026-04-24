/**
 * Bandcamp sale poll — cron every 5 minutes (cross-tenant safety net).
 *
 * Phase 2 §9.3 D3 NOTE: real-time, recipient-driven dispatch happens via
 * `bandcamp-sale-poll-per-connection` (fired by the resend-inbound router
 * when an order email matches a `bandcamp_connections.inbound_forwarding_address`).
 * This cron remains as the global drift safety net for:
 *   * Connections without a configured `inbound_forwarding_address`.
 *   * Order emails whose recipient lookup is ambiguous (multiple matches)
 *     or matches no connection (forwarder misconfigured, new band not
 *     registered yet, etc.).
 *   * Quiet periods where no email arrived but Bandcamp itself reports a
 *     new sale (e.g. operator manually marked an order, fan refunded).
 *
 * Per-connection body lives in `src/trigger/lib/bandcamp-sale-poll-runner.ts`
 * so both the cron and event-driven paths share an identical contract:
 *   - Same `bandcamp-sale:{band_id}:{package_id}:{newSold}` correlation id.
 *   - Same post-sale fanout (bandcamp-inventory-push, multi-store-inventory-push,
 *     triggerBundleFanout).
 *   - Same Rule #65 echo-skip rationale for ShipStation v2.
 *
 * Rule #9: Uses bandcampQueue (serialized with all other Bandcamp API tasks).
 * Rule #20: Inventory changes go through recordInventoryChange() (inside the runner).
 * Rule #7: Uses createServiceRoleClient().
 */

import { schedules } from "@trigger.dev/sdk";
import { refreshBandcampToken } from "@/lib/clients/bandcamp";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { pollOneBandcampConnection } from "@/trigger/lib/bandcamp-sale-poll-runner";

export const bandcampSalePollTask = schedules.task({
  id: "bandcamp-sale-poll",
  cron: "*/5 * * * *",
  queue: bandcampQueue,
  maxDuration: 120,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const startedAt = new Date().toISOString();
    let salesDetected = 0;
    let errors = 0;

    for (const workspaceId of workspaceIds) {
      const { data: connections } = await supabase
        .from("bandcamp_connections")
        .select("id, org_id, band_id")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true);

      if (!connections || connections.length === 0) continue;

      const accessToken = await refreshBandcampToken(workspaceId);

      for (const connection of connections) {
        const result = await pollOneBandcampConnection({
          supabase,
          workspaceId,
          connectionId: connection.id,
          bandId: connection.band_id,
          accessToken,
          runId: ctx.run.id,
        });
        salesDetected += result.salesDetected;
        errors += result.errors;
      }

      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "bandcamp",
        sync_type: "sale_poll",
        status: errors > 0 ? "partial" : "completed",
        items_processed: salesDetected,
        items_failed: errors,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
    }

    return { salesDetected, errors };
  },
});
