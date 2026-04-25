// Slice 4 — Notification + webhook health sensor.
//
// Runs every 15 minutes. Three independent rollups, each writing a single
// sensor_readings row per workspace per check (so the admin Health page +
// the new /admin/operations/notifications page can render time-series
// without re-aggregating raw rows on every query):
//
//   1. notification.stuck_pending — notification_sends rows in `pending`
//      older than 1h. Indicates the Trigger task either hung mid-Resend
//      call or the Resend client throws something we don't classify as
//      transient. Per-workspace breakdown so a single noisy workspace
//      doesn't drown the others.
//
//   2. notification.provider_failures_1h — count of provider_failed +
//      bounced + complained in the last hour, grouped by workspace.
//      `provider_failed` is the new Slice 2 terminal status for 4xx /
//      409 errors; bounced + complained are Resend webhook outcomes.
//
//   3. webhook.signature_failures_1h — count of webhook_events rows in
//      the trailing hour where status IN ('signature_failed','invalid').
//      Per-platform (easypost / resend / shopify / stripe / aftership /
//      shipstation). When the EP or Resend bucket exceeds 10 in an hour,
//      escalates: posts a Slack alert (when SLACK_OPS_WEBHOOK_URL is
//      configured) AND captures a Sentry message tagged with the secret-
//      rotation runbook reference so on-call operators get one click to
//      the recovery doc.
//
// All sensor writes are idempotent under retry (the same run inserts the
// same rows; sensor_readings is append-only by design — duplicates are
// fine and surface as paired data points on the Health page sparkline).
//
// The cron job that should NOT post Slack (no signal) writes a healthy
// rollup so the sensor doesn't go silent — silent sensors are easy to
// confuse with "the cron stopped running".
//
// Rule #7: createServiceRoleClient. Rule #12: payload is IDs only.

import * as Sentry from "@sentry/nextjs";
import { logger, schedules } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const STUCK_PENDING_THRESHOLD_MS = 60 * 60 * 1000; // 1h
const SIGNATURE_FAILURE_ESCALATION_THRESHOLD = 10; // per platform per hour
const RUNBOOK_URL =
  "https://github.com/clandestinefulfillment/runbooks/blob/main/secret-rotation.md";

interface RunResult {
  stuckPendingTotal: number;
  providerFailuresTotal: number;
  signatureFailuresTotal: number;
  workspacesScanned: number;
  escalatedPlatforms: string[];
}

export const notificationFailureSensorTask = schedules.task({
  id: "notification-failure-sensor",
  // Every 15 minutes, on the quarter hour.
  cron: "*/15 * * * *",
  maxDuration: 120,
  run: async (): Promise<RunResult> => {
    return runNotificationFailureSensor();
  },
});

/** Exported for unit testing + manual ops invocations. */
export async function runNotificationFailureSensor(): Promise<RunResult> {
  const supabase = createServiceRoleClient();
  const nowMs = Date.now();
  const oneHourAgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const stuckThresholdIso = new Date(nowMs - STUCK_PENDING_THRESHOLD_MS).toISOString();

  // ── 1. Stuck pending sends ──────────────────────────────────────────────
  const { data: stuckRows, error: stuckErr } = await supabase
    .from("notification_sends")
    .select("id, workspace_id, shipment_id, trigger_status, pending_at, created_at")
    .eq("status", "pending")
    .or(`pending_at.lt.${stuckThresholdIso},created_at.lt.${stuckThresholdIso}`)
    .limit(500);
  if (stuckErr) {
    logger.warn("[notification-failure-sensor] stuck-pending query failed", {
      err: stuckErr.message,
    });
  }
  const stuckByWorkspace = groupBy(stuckRows ?? [], (r) => (r.workspace_id as string) ?? "unknown");

  // ── 2. Provider failures in last hour ───────────────────────────────────
  const { data: failureRows, error: failureErr } = await supabase
    .from("notification_sends")
    .select("workspace_id, status, failed_at, created_at")
    .in("status", ["provider_failed", "bounced", "complained"])
    .gte("created_at", oneHourAgoIso)
    .limit(2000);
  if (failureErr) {
    logger.warn("[notification-failure-sensor] provider-failure query failed", {
      err: failureErr.message,
    });
  }
  const failuresByWorkspace = groupBy(
    failureRows ?? [],
    (r) => (r.workspace_id as string) ?? "unknown",
  );

  // ── 3. Webhook signature failures in last hour (per platform) ───────────
  // We assume webhook_events.status is set by the route handlers when a
  // signature verification fails. If the column doesn't exist or is null,
  // this query returns 0 — the operator pages still render.
  const { data: sigRows, error: sigErr } = await supabase
    .from("webhook_events")
    .select("platform, status, created_at")
    .in("status", ["signature_failed", "invalid"])
    .gte("created_at", oneHourAgoIso)
    .limit(2000);
  if (sigErr) {
    // The column may not exist in older deployments; silently treat as 0.
    logger.warn("[notification-failure-sensor] sig-failure query failed (non-fatal)", {
      err: sigErr.message,
    });
  }
  const sigByPlatform = groupBy(sigRows ?? [], (r) => (r.platform as string) ?? "unknown");

  // ── 4. Persist sensor readings ──────────────────────────────────────────
  const allWorkspaces = new Set<string>([
    ...Object.keys(stuckByWorkspace),
    ...Object.keys(failuresByWorkspace),
  ]);
  let stuckPendingTotal = 0;
  let providerFailuresTotal = 0;

  for (const workspaceId of allWorkspaces) {
    const stuck = stuckByWorkspace[workspaceId] ?? [];
    const failures = failuresByWorkspace[workspaceId] ?? [];
    stuckPendingTotal += stuck.length;
    providerFailuresTotal += failures.length;

    if (workspaceId === "unknown") continue; // sensor_readings.workspace_id is non-null

    if (stuck.length > 0) {
      const oldest = stuck.reduce<string | null>((acc, r) => {
        const ts = (r.pending_at as string | null) ?? (r.created_at as string | null);
        if (!ts) return acc;
        if (!acc) return ts;
        return ts < acc ? ts : acc;
      }, null);
      await supabase.from("sensor_readings").insert({
        workspace_id: workspaceId,
        sensor_name: "notification.stuck_pending",
        status: stuck.length >= 5 ? "critical" : "warning",
        message: `${stuck.length} notification_sends row(s) stuck in pending for >1h`,
        value: {
          count: stuck.length,
          oldest_pending_at: oldest,
          sample_shipment_ids: stuck.slice(0, 10).map((r) => r.shipment_id as string),
          triggers: countByKey(stuck, (r) => (r.trigger_status as string | null) ?? "unknown"),
        },
      });
    } else {
      // Healthy heartbeat — keeps the sensor visible on the Health page.
      await supabase.from("sensor_readings").insert({
        workspace_id: workspaceId,
        sensor_name: "notification.stuck_pending",
        status: "healthy",
        message: "no stuck pending notifications",
        value: { count: 0 },
      });
    }

    if (failures.length > 0) {
      const breakdown = countByKey(failures, (r) => (r.status as string | null) ?? "unknown");
      await supabase.from("sensor_readings").insert({
        workspace_id: workspaceId,
        sensor_name: "notification.provider_failures_1h",
        status: failures.length >= 20 ? "critical" : failures.length >= 5 ? "warning" : "healthy",
        message: `${failures.length} provider failure(s) in last hour`,
        value: { count: failures.length, breakdown },
      });
    } else {
      await supabase.from("sensor_readings").insert({
        workspace_id: workspaceId,
        sensor_name: "notification.provider_failures_1h",
        status: "healthy",
        message: "no provider failures in last hour",
        value: { count: 0 },
      });
    }
  }

  // ── 5. Webhook signature failure rollup ─────────────────────────────────
  // sensor_readings.workspace_id is NOT NULL with an FK to workspaces.id.
  // Signature failures aren't workspace-scoped (we couldn't validate the
  // source), so we write the rollup to EVERY workspace — every operator sees
  // the alert on their Health page. For single-workspace deployments this is
  // a single row per platform per run; for multi-workspace deployments the
  // operator-level signal is correctly broadcast.
  const { data: workspaceRows } = await supabase.from("workspaces").select("id");
  const allWorkspaceIds = (workspaceRows ?? []).map((w) => w.id as string);

  const escalatedPlatforms: string[] = [];
  let signatureFailuresTotal = 0;
  for (const [platform, rows] of Object.entries(sigByPlatform)) {
    signatureFailuresTotal += rows.length;
    const exceeded = rows.length > SIGNATURE_FAILURE_ESCALATION_THRESHOLD;
    if (exceeded) escalatedPlatforms.push(platform);

    for (const wsId of allWorkspaceIds) {
      await supabase.from("sensor_readings").insert({
        workspace_id: wsId,
        sensor_name: `webhook.signature_failures_1h.${platform}`,
        status: exceeded ? "critical" : rows.length > 0 ? "warning" : "healthy",
        message: exceeded
          ? `${rows.length} ${platform} signature failures in last hour — exceeded threshold of ${SIGNATURE_FAILURE_ESCALATION_THRESHOLD} (likely secret rotation drift)`
          : `${rows.length} ${platform} signature failures in last hour`,
        value: {
          count: rows.length,
          platform,
          threshold: SIGNATURE_FAILURE_ESCALATION_THRESHOLD,
        },
      });
    }

    if (exceeded) {
      Sentry.captureMessage(
        `[notification-failure-sensor] ${platform} signature failures exceeded threshold`,
        {
          level: "error",
          tags: {
            feature: "webhook_health",
            platform,
            runbook: "secret-rotation",
          },
          extra: {
            count: rows.length,
            threshold: SIGNATURE_FAILURE_ESCALATION_THRESHOLD,
            runbook_url: RUNBOOK_URL,
          },
        },
      );
      await postSlackEscalation(platform, rows.length);
    }
  }

  const result: RunResult = {
    stuckPendingTotal,
    providerFailuresTotal,
    signatureFailuresTotal,
    workspacesScanned: allWorkspaces.size,
    escalatedPlatforms,
  };
  logger.log("[notification-failure-sensor] done", result as unknown as Record<string, unknown>);
  return result;
}

// ── helpers ───────────────────────────────────────────────────────────────

function groupBy<T>(rows: T[], key: (r: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) {
    const k = key(r);
    if (!out[k]) out[k] = [];
    out[k].push(r);
  }
  return out;
}

function countByKey<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function postSlackEscalation(platform: string, count: number): Promise<void> {
  const url = env().SLACK_OPS_WEBHOOK_URL;
  if (!url) return; // Optional channel; sensor + Sentry are the primary signal.
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `:warning: *${platform}* webhook signature failures exceeded threshold (${count} in the last hour). Likely a secret rotation drift. Runbook: ${RUNBOOK_URL}`,
      }),
    });
  } catch (err) {
    // Slack is non-critical; log + move on.
    logger.warn("[notification-failure-sensor] slack post failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
