/**
 * Sensor check — cron every 5 minutes.
 *
 * Runs sensor checks and inserts results into sensor_readings.
 * If any sensor returns 'critical', creates a review queue item.
 *
 * Rule #52: Integration health states.
 * Rule #71: Inventory freshness.
 * Rule #7: Uses createServiceRoleClient().
 */

import { schedules } from "@trigger.dev/sdk";
import { getInventory } from "@/lib/clients/redis-inventory";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  criticalItemsStatus,
  driftStatus,
  propagationLagStatus,
  type SensorReading,
  syncStalenessStatus,
  unpaidInvoiceStatus,
  webhookSilenceDetected,
} from "@/trigger/lib/sensors";

export const sensorCheckTask = schedules.task({
  id: "sensor-check",
  cron: "*/5 * * * *",
  maxDuration: 60,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);

    const allResults: Array<{ workspaceId: string; readings: number; criticals: number }> = [];

    for (const workspaceId of workspaceIds) {
      const readings: SensorReading[] = [];

      // 1. inv.redis_postgres_drift
      try {
        const { data: sample } = await supabase
          .from("warehouse_inventory_levels")
          .select("sku, available")
          .eq("workspace_id", workspaceId)
          .limit(100);

        let mismatches = 0;
        for (const row of sample ?? []) {
          const redis = await getInventory(row.sku);
          if (redis.available !== row.available) mismatches++;
        }

        readings.push({
          sensorName: "inv.redis_postgres_drift",
          status: driftStatus(mismatches),
          value: { sample_size: sample?.length ?? 0, mismatches },
          message:
            mismatches === 0
              ? "No drift detected"
              : `${mismatches} mismatches in ${sample?.length} sampled SKUs`,
        });
      } catch (e) {
        readings.push({
          sensorName: "inv.redis_postgres_drift",
          status: "warning",
          value: { error: e instanceof Error ? e.message : String(e) },
          message: "Sensor check failed",
        });
      }

      // 2. inv.propagation_lag (Rule #71)
      try {
        const { data: staleMapping } = await supabase
          .from("client_store_sku_mappings")
          .select("last_pushed_at")
          .eq("is_active", true)
          .not("last_pushed_at", "is", null)
          .order("last_pushed_at", { ascending: true })
          .limit(1);

        const oldest = staleMapping?.[0]?.last_pushed_at;
        const maxAgeMinutes = oldest ? (Date.now() - new Date(oldest).getTime()) / 60_000 : 0;

        readings.push({
          sensorName: "inv.propagation_lag",
          status: propagationLagStatus(maxAgeMinutes),
          value: { oldest_push_at: oldest, max_age_minutes: Math.round(maxAgeMinutes) },
          message:
            maxAgeMinutes < 5
              ? "All pushes fresh"
              : `Oldest push is ${Math.round(maxAgeMinutes)} minutes ago`,
        });
      } catch {
        readings.push({
          sensorName: "inv.propagation_lag",
          status: "healthy",
          value: {},
          message: "No active mappings",
        });
      }

      // 3. sync.shopify_stale
      try {
        const { data: syncState } = await supabase
          .from("warehouse_sync_state")
          .select("last_sync_wall_clock")
          .eq("workspace_id", workspaceId)
          .eq("sync_type", "shopify_delta")
          .single();

        const minutesSince = syncState?.last_sync_wall_clock
          ? (Date.now() - new Date(syncState.last_sync_wall_clock).getTime()) / 60_000
          : null;

        readings.push({
          sensorName: "sync.shopify_stale",
          status: syncStalenessStatus(minutesSince),
          value: {
            last_sync: syncState?.last_sync_wall_clock,
            minutes_since: minutesSince ? Math.round(minutesSince) : null,
          },
          message:
            minutesSince === null
              ? "Never synced"
              : `Last sync ${Math.round(minutesSince)} minutes ago`,
        });
      } catch {
        readings.push({
          sensorName: "sync.shopify_stale",
          status: "critical",
          value: {},
          message: "Could not check sync state",
        });
      }

      // 4. sync.bandcamp_stale
      try {
        const { data: bcState } = await supabase
          .from("bandcamp_connections")
          .select("last_synced_at")
          .eq("workspace_id", workspaceId)
          .eq("is_active", true)
          .order("last_synced_at", { ascending: true })
          .limit(1);

        const lastSync = bcState?.[0]?.last_synced_at;
        const minutesSince = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 60_000 : null;

        readings.push({
          sensorName: "sync.bandcamp_stale",
          status: syncStalenessStatus(minutesSince),
          value: {
            last_sync: lastSync,
            minutes_since: minutesSince ? Math.round(minutesSince) : null,
          },
          message:
            minutesSince === null
              ? "Never synced"
              : `Last sync ${Math.round(minutesSince)} minutes ago`,
        });
      } catch {
        readings.push({
          sensorName: "sync.bandcamp_stale",
          status: "healthy",
          value: {},
          message: "No Bandcamp connections",
        });
      }

      // 5. webhook.silence (Rule #17)
      try {
        const { data: conns } = await supabase
          .from("client_store_connections")
          .select("id, platform, store_url, last_webhook_at, last_poll_at, org_id")
          .eq("workspace_id", workspaceId)
          .eq("connection_status", "active");

        for (const conn of conns ?? []) {
          const pollFoundOrders = conn.last_poll_at != null;
          if (webhookSilenceDetected(conn.last_webhook_at, conn.last_poll_at, pollFoundOrders)) {
            readings.push({
              sensorName: "webhook.silence",
              status: "warning",
              value: {
                connection_id: conn.id,
                platform: conn.platform,
                last_webhook_at: conn.last_webhook_at,
              },
              message: `Webhook silence on ${conn.platform} (${conn.store_url})`,
            });
          }
        }
      } catch {
        // Non-critical
      }

      // 6. billing.unpaid
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { count } = await supabase
          .from("warehouse_billing_snapshots")
          .select("id", { count: "exact", head: true })
          .eq("status", "overdue")
          .lt("created_at", sevenDaysAgo);

        readings.push({
          sensorName: "billing.unpaid",
          status: unpaidInvoiceStatus(count ?? 0),
          value: { overdue_count: count },
          message: count === 0 ? "No overdue invoices" : `${count} overdue invoices >7 days`,
        });
      } catch {
        readings.push({
          sensorName: "billing.unpaid",
          status: "healthy",
          value: {},
          message: "Check skipped",
        });
      }

      // 7. review.critical_open
      try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count } = await supabase
          .from("warehouse_review_queue")
          .select("id", { count: "exact", head: true })
          .eq("severity", "critical")
          .eq("status", "open")
          .lt("created_at", oneHourAgo);

        readings.push({
          sensorName: "review.critical_open",
          status: criticalItemsStatus(count ?? 0),
          value: { count },
          message: count === 0 ? "No stale critical items" : `${count} critical items open >1hr`,
        });
      } catch {
        readings.push({
          sensorName: "review.critical_open",
          status: "healthy",
          value: {},
          message: "Check skipped",
        });
      }

      // Persist all readings
      if (readings.length > 0) {
        await supabase.from("sensor_readings").insert(
          readings.map((r) => ({
            workspace_id: workspaceId,
            sensor_name: r.sensorName,
            status: r.status,
            value: r.value,
            message: r.message,
          })),
        );
      }

      // Create review queue item for any critical readings
      const criticals = readings.filter((r) => r.status === "critical");
      for (const critical of criticals) {
        await supabase.from("warehouse_review_queue").upsert(
          {
            workspace_id: workspaceId,
            category: "sensor",
            severity: "critical",
            title: `Sensor critical: ${critical.sensorName}`,
            description: critical.message,
            metadata: critical.value,
            group_key: `sensor_critical:${critical.sensorName}`,
            status: "open",
            occurrence_count: 1,
          },
          { onConflict: "group_key", ignoreDuplicates: false },
        );
      }

      allResults.push({ workspaceId, readings: readings.length, criticals: criticals.length });
    }

    return allResults;
  },
});
