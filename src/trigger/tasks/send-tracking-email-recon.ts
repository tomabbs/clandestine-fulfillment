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
      "id, status, suppress_emails, shipstation_marked_shipped_at, delivery_date, updated_at",
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

  // Single sensor reading per run summarizing the gap.
  const firstWs = (shipments[0]?.id as string) ?? null;
  if (firstWs) {
    await supabase.from("sensor_readings").insert({
      sensor_name: "notification.reconciliation_misses",
      status: missing.length > 0 ? "warning" : "healthy",
      message: `Scanned ${shipments.length} shipments in last ${LOOKBACK_DAYS}d; ${missing.length} missing notification_sends rows; ${refired} re-fired.`,
      value: { scanned: shipments.length, missing: missing.length, refired },
    });
  }

  logger.log("[send-tracking-email-recon] done", {
    scanned: shipments.length,
    missing: missing.length,
    refired,
  });
  return { scanned: shipments.length, refired, missing: missing.length };
}
