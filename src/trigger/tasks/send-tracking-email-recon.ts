// Phase 12 — Daily reconciliation: catches the silent-failure case where an
// EP webhook arrived but our send-tracking-email task didn't actually
// produce a 'sent' (or 'shadow') row in notification_sends.
//
// The 3.8% silent webhook failure rate documented for EP at peak load is
// the exact failure class this cron exists for. Once a day we walk every
// shipment that should have triggered an email in the last 7 days, check
// if a notification_sends row exists for that (shipment, trigger_status),
// and re-fire send-tracking-email when missing. The send task's own
// 3-layer dedup makes the re-fire idempotent.
//
// Cron: 04:30 UTC daily.

import { logger, schedules, tasks } from "@trigger.dev/sdk";
import type { NotificationTriggerStatus } from "@/lib/server/notification-sends";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const LOOKBACK_DAYS = 7;
const MAX_REFIRE_PER_RUN = 200;

interface MissingExpectation {
  shipment_id: string;
  trigger_status: NotificationTriggerStatus;
  reason: string;
}

interface RunResult {
  scanned: number;
  refired: number;
  missing: number;
}

export const sendTrackingEmailReconCronTask = schedules.task({
  id: "send-tracking-email-recon",
  cron: "30 4 * * *",
  maxDuration: 300,
  run: async (): Promise<RunResult> => {
    return runReconciliation();
  },
});

/** Exported for unit testing + manual invocation. */
export async function runReconciliation(): Promise<RunResult> {
  const supabase = createServiceRoleClient();
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  // Pull every shipment in the lookback window with a status worth emailing on.
  // We only consider "shipped"-and-later shipments — pre_transit / label_created
  // doesn't trigger a customer email.
  const { data: shipments, error } = await supabase
    .from("warehouse_shipments")
    .select(
      "id, workspace_id, status, suppress_emails, shipstation_marked_shipped_at, delivery_date, updated_at",
    )
    .gte("updated_at", sinceIso)
    .not("public_track_token", "is", null)
    .not("tracking_number", "is", null)
    .eq("suppress_emails", false)
    .limit(5000);

  if (error) {
    logger.warn("[send-tracking-email-recon] select failed", { error: error.message });
    return { scanned: 0, refired: 0, missing: 0 };
  }
  if (!shipments?.length) return { scanned: 0, refired: 0, missing: 0 };

  // Pull the matching notification_sends rows in one query.
  const ids = shipments.map((s) => s.id as string);
  const { data: sends } = await supabase
    .from("notification_sends")
    .select("shipment_id, trigger_status, status")
    .in("shipment_id", ids)
    .in("status", ["sent", "shadow", "skipped", "suppressed", "failed"]);

  // Build set of (shipment_id|trigger) we already have an outcome for.
  const seen = new Set<string>();
  for (const s of sends ?? []) {
    seen.add(`${s.shipment_id}|${s.trigger_status}`);
  }

  // Each shipment "should have" produced certain trigger emails based on its
  // current state. If the matching notification_sends row is missing, queue
  // a re-fire. Order matters: a delivered shipment should have BOTH a
  // 'shipped' row AND a 'delivered' row.
  const missing: MissingExpectation[] = [];
  for (const s of shipments) {
    const id = s.id as string;
    const status = (s.status as string | null) ?? null;
    const expectedTriggers: NotificationTriggerStatus[] = [];
    // 'shipped' triggers as soon as we have ANY post-label state.
    expectedTriggers.push("shipped");
    if (status === "out_for_delivery") expectedTriggers.push("out_for_delivery");
    if (status === "delivered") {
      // Delivered shipments most likely went through OOD too — but EP may have
      // skipped it for that carrier. Don't expect OOD if it's already at
      // delivered without an OOD checkpoint; only expect 'delivered'.
      expectedTriggers.push("delivered");
    }
    if (status === "exception" || status === "delivery_failed") {
      expectedTriggers.push("exception");
    }
    for (const trig of expectedTriggers) {
      if (!seen.has(`${id}|${trig}`)) {
        missing.push({
          shipment_id: id,
          trigger_status: trig,
          reason: `shipment.status=${status ?? "null"}; no notification_sends row`,
        });
      }
    }
  }

  if (missing.length === 0) {
    logger.log("[send-tracking-email-recon] all sends accounted for", {
      scanned: shipments.length,
    });
    return { scanned: shipments.length, refired: 0, missing: 0 };
  }

  // Re-fire up to MAX_REFIRE_PER_RUN per run. send-tracking-email's own dedup
  // catches the case where the original send actually succeeded after our
  // SELECT (race) — it'll skip with decision='skipped_already_sent' rather
  // than double-sending.
  let refired = 0;
  for (const m of missing.slice(0, MAX_REFIRE_PER_RUN)) {
    try {
      await tasks.trigger("send-tracking-email", {
        shipment_id: m.shipment_id,
        trigger_status: m.trigger_status,
      });
      refired++;
    } catch (err) {
      logger.warn("[send-tracking-email-recon] re-fire enqueue failed", {
        shipment_id: m.shipment_id,
        trigger: m.trigger_status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Per-workspace sensor readings ────────────────────────────────────────
  // Pre-Slice-4 this task wrote a single sensor_readings row whose
  // `workspace_id` field was set to a SHIPMENT id (a bug: workspace_id is FK
  // to workspaces.id with NOT NULL). The row insert silently failed in
  // production, leaving the recon sensor invisible on the Health page.
  // We now group by workspace_id and write ONE summary per workspace.
  const perWorkspace = aggregatePerWorkspace(
    shipments.map((s) => ({
      id: s.id as string,
      workspace_id: (s.workspace_id as string | null) ?? null,
    })),
    missing,
    refired,
  );
  for (const [workspaceId, summary] of perWorkspace.entries()) {
    await supabase.from("sensor_readings").insert({
      workspace_id: workspaceId,
      sensor_name: "notification.reconciliation_misses",
      status: summary.missing > 0 ? "warning" : "healthy",
      message: `Scanned ${summary.scanned} shipments in last ${LOOKBACK_DAYS}d; ${summary.missing} missing; ${summary.refired} re-fired.`,
      value: {
        scanned: summary.scanned,
        missing: summary.missing,
        refired: summary.refired,
      },
    });
  }

  logger.log("[send-tracking-email-recon] done", {
    scanned: shipments.length,
    missing: missing.length,
    refired,
  });
  return { scanned: shipments.length, refired, missing: missing.length };
}

/**
 * Per-workspace recon attribution helper. Exported for unit testing — the
 * "shipment.id was being used as workspace_id" bug was invisible until we
 * pinned this aggregation behind a pure function with explicit assertions.
 *
 * Inputs:
 *   - shipments: the rows we scanned in the lookback window
 *   - missing:   the (shipment_id, trigger_status) expectations that had no
 *                matching notification_sends row
 *   - refired:   the count of expectations actually re-fired this run
 *                (can be < missing.length when MAX_REFIRE_PER_RUN clips)
 *
 * Output: Map keyed by workspace_id with { scanned, missing, refired }.
 *   - workspace_id=null shipments are dropped (sensor_readings.workspace_id
 *     is NOT NULL — see migration 20260424000001).
 *   - refired is attributed proportionally by each workspace's share of
 *     `missing`. Workspaces with missing=0 get refired=0.
 */
export function aggregatePerWorkspace(
  shipments: Array<{ id: string; workspace_id: string | null }>,
  missing: MissingExpectation[],
  refired: number,
): Map<string, { scanned: number; missing: number; refired: number }> {
  const out = new Map<string, { scanned: number; missing: number; refired: number }>();
  for (const s of shipments) {
    if (!s.workspace_id) continue;
    const cur = out.get(s.workspace_id) ?? { scanned: 0, missing: 0, refired: 0 };
    cur.scanned += 1;
    out.set(s.workspace_id, cur);
  }
  for (const m of missing) {
    const ship = shipments.find((s) => s.id === m.shipment_id);
    const ws = ship?.workspace_id ?? null;
    if (!ws) continue;
    const cur = out.get(ws) ?? { scanned: 0, missing: 0, refired: 0 };
    cur.missing += 1;
    out.set(ws, cur);
  }
  const totalMissing = missing.length;
  if (totalMissing > 0) {
    for (const [ws, cur] of out.entries()) {
      cur.refired = Math.round((cur.missing / totalMissing) * refired);
      out.set(ws, cur);
    }
  }
  return out;
}
