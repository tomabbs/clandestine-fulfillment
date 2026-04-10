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
import { getInventory, setInventory } from "@/lib/clients/redis-inventory";
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

      // 1. inv.redis_postgres_drift — detect and auto-heal up to 50 drifted SKUs per run
      try {
        // Load full row (available + committed + incoming) to heal all fields accurately.
        // Healing only `available` while setting committed/incoming to 0 would create
        // false zeros for consumers that treat those fields as authoritative.
        const { data: sample } = await supabase
          .from("warehouse_inventory_levels")
          .select("sku, available, committed, incoming")
          .eq("workspace_id", workspaceId)
          .limit(100);

        let mismatches = 0;
        let healed = 0;
        for (const row of sample ?? []) {
          const redis = await getInventory(row.sku);
          if (redis.available !== row.available) {
            mismatches++;
            if (healed < 50) {
              // Auto-heal: align all three Redis fields to Postgres source of truth
              await setInventory(row.sku, {
                available: row.available,
                committed: row.committed ?? 0,
                incoming: row.incoming ?? 0,
              });
              healed++;
            }
          }
        }

        readings.push({
          sensorName: "inv.redis_postgres_drift",
          status: driftStatus(mismatches),
          value: { sample_size: sample?.length ?? 0, mismatches, auto_healed: healed },
          message:
            mismatches === 0
              ? "No drift detected"
              : `${mismatches} mismatches — ${healed} auto-healed`,
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

      // 5. bandcamp.merch_sync_log_stale — last successful merch_sync via channel_sync_log
      try {
        const { data: latestMerchSync } = await supabase
          .from("channel_sync_log")
          .select("created_at")
          .eq("workspace_id", workspaceId)
          .eq("sync_type", "merch_sync")
          .in("status", ["completed", "partial"])
          .order("created_at", { ascending: false })
          .limit(1);

        const lastCompleted = latestMerchSync?.[0]?.created_at;
        const minutesSince = lastCompleted
          ? (Date.now() - new Date(lastCompleted).getTime()) / 60_000
          : null;

        readings.push({
          sensorName: "bandcamp.merch_sync_log_stale",
          status: syncStalenessStatus(minutesSince, 45, 90),
          value: {
            last_completed: lastCompleted,
            minutes_since: minutesSince ? Math.round(minutesSince) : null,
          },
          message:
            minutesSince === null
              ? "No merch_sync log entries"
              : `Last completed merch_sync ${Math.round(minutesSince)} min ago`,
        });
      } catch {
        readings.push({
          sensorName: "bandcamp.merch_sync_log_stale",
          status: "healthy",
          value: {},
          message: "No channel_sync_log data",
        });
      }

      // 6. bandcamp.scraper_review_open — open bandcamp_scraper items in review queue
      try {
        const { count } = await supabase
          .from("warehouse_review_queue")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("category", "bandcamp_scraper")
          .eq("status", "open");

        const openCount = count ?? 0;
        readings.push({
          sensorName: "bandcamp.scraper_review_open",
          status: openCount >= 50 ? "critical" : openCount >= 10 ? "warning" : "healthy",
          value: { open_count: openCount },
          message:
            openCount === 0 ? "No open scraper issues" : `${openCount} open bandcamp_scraper items`,
        });
      } catch {
        readings.push({
          sensorName: "bandcamp.scraper_review_open",
          status: "healthy",
          value: {},
          message: "Check skipped",
        });
      }

      // 7. bandcamp.scrape_block_rate — recent 403/429 rate from scrape_page logs
      try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: recentScrapes } = await supabase
          .from("channel_sync_log")
          .select("status, metadata")
          .eq("workspace_id", workspaceId)
          .eq("sync_type", "scrape_page")
          .gte("created_at", oneHourAgo);

        const total = recentScrapes?.length ?? 0;
        let blocked = 0;
        for (const row of recentScrapes ?? []) {
          const hs = (row.metadata as Record<string, unknown>)?.httpStatus;
          if (hs === 403 || hs === 429) blocked++;
        }
        const blockRate = total > 0 ? blocked / total : 0;

        readings.push({
          sensorName: "bandcamp.scrape_block_rate",
          status: blockRate >= 0.5 ? "critical" : blockRate >= 0.2 ? "warning" : "healthy",
          value: {
            total_scrapes_1h: total,
            blocked_1h: blocked,
            block_rate: Math.round(blockRate * 100),
          },
          message:
            total === 0
              ? "No scrapes in last hour"
              : `${Math.round(blockRate * 100)}% block rate (${blocked}/${total} in 1h)`,
        });
      } catch {
        readings.push({
          sensorName: "bandcamp.scrape_block_rate",
          status: "healthy",
          value: {},
          message: "Check skipped",
        });
      }

      // 8. webhook.silence (Rule #17)
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

      // 9. billing.unpaid
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

      // 10. review.critical_open
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

      // 11. catalog.unmapped_products — products with NULL org_id (CRIT-1 prevention)
      try {
        const { count } = await supabase
          .from("warehouse_products")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .is("org_id", null);

        const unmapped = count ?? 0;
        readings.push({
          sensorName: "catalog.unmapped_products",
          status: unmapped > 10 ? "critical" : unmapped > 0 ? "warning" : "healthy",
          value: { unmapped_count: unmapped },
          message:
            unmapped === 0 ? "All products mapped to orgs" : `${unmapped} products have no org_id`,
        });
      } catch {
        readings.push({
          sensorName: "catalog.unmapped_products",
          status: "healthy",
          value: {},
          message: "Check skipped",
        });
      }

      // 12. catalog.title_format — detect products using label name as artist
      try {
        const { data: conns } = await supabase
          .from("bandcamp_connections")
          .select("band_id, band_name")
          .eq("workspace_id", workspaceId)
          .eq("is_active", true);

        if (conns?.length) {
          const labelNames = conns
            .map((c) => (c.band_name as string)?.toUpperCase())
            .filter(Boolean);
          const { data: bcProducts } = await supabase
            .from("warehouse_products")
            .select("title")
            .eq("workspace_id", workspaceId)
            .limit(500);

          let wrongArtist = 0;
          for (const p of bcProducts ?? []) {
            const upperTitle = ((p as { title?: string }).title ?? "").toUpperCase();
            for (let li = 0; li < labelNames.length; li++) {
              const label = labelNames[li];
              if (label && upperTitle.startsWith(`${label} - `)) {
                wrongArtist++;
                break;
              }
            }
          }

          readings.push({
            sensorName: "catalog.title_format",
            status: wrongArtist > 10 ? "critical" : wrongArtist > 0 ? "warning" : "healthy",
            value: { wrong_artist_count: wrongArtist, sample_size: (bcProducts ?? []).length },
            message:
              wrongArtist === 0
                ? "No label-as-artist titles detected"
                : `${wrongArtist} products may use label name as artist in title`,
          });
        }
      } catch {
        readings.push({
          sensorName: "catalog.title_format",
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
