// Phase 7.1 — Unified shipping system health sensors.
//
// Hourly cron that polls + aggregates the unified-shipping pipeline state
// into sensor_readings rows. Separate from the inventory-focused
// sensor-check.ts because the workloads + cadences differ (this is hourly,
// inventory check is every 5 min).
//
// Sensors emitted (each writes ONE sensor_readings row per workspace per run):
//   shipstation.writeback_failed_count       — open writeback errors in last 24h
//   shipstation.label_printed_not_marked     — labels >30 min without SS mark-shipped
//   shipstation.orders_unmatched_count       — SS orders with org_id NULL in last 24h
//   notification.send_failure_rate_24h       — % failed notification_sends in last 24h
//   notification.recon_misses_recent         — confirms recon cron is running
//   resend.bounce_rate_24h                   — % bounced in last 24h
//   resend.complaint_rate_24h                — % complained in last 24h
//   tracking.parity_recent                   — confirms tracker-parity cron is running
//
// Status thresholds derive simple healthy / warning / critical values.
// Sentry alerts will be configured downstream from these readings (once
// production traffic data is available — flagged in Phase 7 known limitations).

import { logger, schedules } from "@trigger.dev/sdk";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const LOOKBACK_24H_MS = 24 * 60 * 60 * 1000;

interface SensorReading {
  workspace_id: string;
  sensor_name: string;
  status: "healthy" | "warning" | "critical";
  message: string;
  value: Record<string, unknown>;
}

export const unifiedShippingSensorsTask = schedules.task({
  id: "unified-shipping-sensors",
  cron: "5 * * * *", // every hour at :05
  maxDuration: 120,
  run: async () => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const totals = { workspaces: 0, readings: 0, warnings: 0, criticals: 0 };

    for (const workspaceId of workspaceIds) {
      const readings: SensorReading[] = [];
      const since24hIso = new Date(Date.now() - LOOKBACK_24H_MS).toISOString();

      // ── 1. shipstation.writeback_failed_count ──────────────────────────
      try {
        const { count: writebackFailed } = await supabase
          .from("warehouse_shipments")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .not("shipstation_writeback_error", "is", null)
          .is("shipstation_marked_shipped_at", null)
          .gte("updated_at", since24hIso);
        const n = writebackFailed ?? 0;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "shipstation.writeback_failed_count",
          status: n === 0 ? "healthy" : n > 5 ? "critical" : "warning",
          message: `${n} shipments with open SS writeback errors in last 24h`,
          value: { count: n },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] writeback_failed query failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 2. shipstation.label_printed_not_marked ────────────────────────
      // Labels created >30min ago that should have been marked shipped on SS
      // by now. Indicates the writeback task is stuck for some shipments.
      try {
        const cutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const { count } = await supabase
          .from("warehouse_shipments")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .not("shipstation_order_id", "is", null)
          .not("tracking_number", "is", null)
          .is("shipstation_marked_shipped_at", null)
          .lte("created_at", cutoffIso)
          .gte("created_at", since24hIso);
        const n = count ?? 0;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "shipstation.label_printed_not_marked",
          status: n === 0 ? "healthy" : n > 10 ? "critical" : "warning",
          message: `${n} SS shipments printed >30min ago but not yet marked shipped`,
          value: { count: n },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] label_printed_not_marked failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 3. shipstation.orders_unmatched_count ──────────────────────────
      try {
        const { count } = await supabase
          .from("shipstation_orders")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .is("org_id", null)
          .gte("created_at", since24hIso);
        const n = count ?? 0;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "shipstation.orders_unmatched_count",
          status: n === 0 ? "healthy" : n > 25 ? "warning" : "healthy",
          message: `${n} SS orders ingested in last 24h without an org match`,
          value: { count: n },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] orders_unmatched_count failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 4. notification.send_failure_rate_24h ──────────────────────────
      // % failed / total send attempts (sent + failed) in last 24h.
      try {
        const { data: counts } = await supabase
          .from("notification_sends")
          .select("status")
          .eq("workspace_id", workspaceId)
          .gte("sent_at", since24hIso)
          .in("status", ["sent", "failed", "shadow"]);
        const sent =
          counts?.filter((r) => r.status === "sent" || r.status === "shadow").length ?? 0;
        const failed = counts?.filter((r) => r.status === "failed").length ?? 0;
        const total = sent + failed;
        const rate = total === 0 ? 0 : failed / total;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "notification.send_failure_rate_24h",
          status:
            total === 0
              ? "healthy"
              : rate > 0.05
                ? "critical"
                : rate > 0.01
                  ? "warning"
                  : "healthy",
          message: `${failed}/${total} sends failed in last 24h (${(rate * 100).toFixed(2)}%)`,
          value: { sent, failed, total, rate },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] notification.send_failure_rate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 5. notification.recon_misses_recent ────────────────────────────
      // Confirms the daily recon cron is running. WARN if no reading in
      // last 25h; the cron fires once daily at 04:30 UTC.
      try {
        const { data: lastRecon } = await supabase
          .from("sensor_readings")
          .select("created_at, message, status")
          .eq("sensor_name", "notification.reconciliation_misses")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const stale =
          !lastRecon ||
          Date.now() - new Date(lastRecon.created_at as string).getTime() > 25 * 60 * 60 * 1000;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "notification.recon_cron_alive",
          status: stale ? "warning" : "healthy",
          message: stale
            ? `last reconciliation_misses reading older than 25h (cron may be dead)`
            : `last reading at ${lastRecon!.created_at}: ${lastRecon!.message}`,
          value: { stale, last_seen: lastRecon?.created_at ?? null },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] recon_cron_alive failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 6. resend.bounce_rate_24h ──────────────────────────────────────
      try {
        const { data: counts } = await supabase
          .from("notification_sends")
          .select("status")
          .eq("workspace_id", workspaceId)
          .gte("sent_at", since24hIso)
          .in("status", ["sent", "bounced"]);
        const sent = counts?.filter((r) => r.status === "sent").length ?? 0;
        const bounced = counts?.filter((r) => r.status === "bounced").length ?? 0;
        const total = sent + bounced;
        const rate = total === 0 ? 0 : bounced / total;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "resend.bounce_rate_24h",
          status: total === 0 ? "healthy" : rate > 0.05 ? "warning" : "healthy",
          message: `${bounced}/${total} bounced in last 24h (${(rate * 100).toFixed(2)}%)`,
          value: { sent, bounced, total, rate },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] bounce_rate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 7. resend.complaint_rate_24h ───────────────────────────────────
      try {
        const { data: counts } = await supabase
          .from("notification_sends")
          .select("status")
          .eq("workspace_id", workspaceId)
          .gte("sent_at", since24hIso)
          .in("status", ["sent", "complained"]);
        const sent = counts?.filter((r) => r.status === "sent").length ?? 0;
        const complained = counts?.filter((r) => r.status === "complained").length ?? 0;
        const total = sent + complained;
        const rate = total === 0 ? 0 : complained / total;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "resend.complaint_rate_24h",
          // Spam complaint thresholds are STRICT — anything above 0.1% is
          // a deliverability emergency.
          status: total === 0 ? "healthy" : rate > 0.001 ? "critical" : "healthy",
          message: `${complained}/${total} complained in last 24h (${(rate * 100).toFixed(3)}%)`,
          value: { sent, complained, total, rate },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] complaint_rate failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 8. tracking.parity_recent ──────────────────────────────────────
      // Confirms the daily AS-vs-EP parity cron is running.
      try {
        const { data: lastParity } = await supabase
          .from("sensor_readings")
          .select("created_at, status, message")
          .eq("workspace_id", workspaceId)
          .eq("sensor_name", "tracker.parity_aftership_vs_easypost")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const stale =
          !lastParity ||
          Date.now() - new Date(lastParity.created_at as string).getTime() > 25 * 60 * 60 * 1000;
        readings.push({
          workspace_id: workspaceId,
          sensor_name: "tracker.parity_cron_alive",
          status: stale ? "warning" : "healthy",
          message: stale
            ? `last parity reading older than 25h (cron may be dead)`
            : `last reading at ${lastParity!.created_at}`,
          value: { stale, last_seen: lastParity?.created_at ?? null },
        });
      } catch (err) {
        logger.warn("[shipping-sensors] parity_cron_alive failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Persist all readings for this workspace in one batch.
      if (readings.length > 0) {
        const { error: insErr } = await supabase.from("sensor_readings").insert(readings);
        if (insErr) {
          logger.warn("[shipping-sensors] insert failed", {
            workspaceId,
            error: insErr.message,
          });
        }
        const w = readings.filter((r) => r.status === "warning").length;
        const c = readings.filter((r) => r.status === "critical").length;
        totals.readings += readings.length;
        totals.warnings += w;
        totals.criticals += c;
      }
      totals.workspaces++;
    }

    logger.log("[unified-shipping-sensors] done", totals);
    return totals;
  },
});
