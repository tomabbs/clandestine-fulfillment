/**
 * Webhook events recovery sweeper.
 *
 * HRD-17.1 belt-and-braces: even with the route-handler try/catch, certain
 * failure modes (route handler crashes BETWEEN insert and trigger; tasks.trigger
 * succeeds but the status update fails; Trigger.dev acks then loses the run)
 * leave webhook_events rows orphaned in 'received' or 'enqueue_failed' status.
 * This task sweeps them up every 5 minutes.
 *
 * Why a 2-minute floor: gives the route handler enough time to flip a row to
 * 'enqueued' before the sweeper tries to re-fire it. (Cold starts can take
 * 10–30s; we use 2 min to be safe.) Combined with the HRD-29 GLOBAL-scope
 * idempotency key on `process-client-store-webhook`, even if the sweeper races
 * the route handler we are guaranteed at-most-one downstream run per
 * webhook_events row.
 *
 * Cap at 100 rows per sweep to bound runtime; if the queue is ever deeper than
 * that we'll drain over multiple cron ticks rather than blowing maxDuration.
 *
 * R-3: STRICTLY scoped to client-store platforms (shopify / woocommerce /
 * squarespace). Earlier versions ran without a platform filter and would
 * pick up Resend / EasyPost / AfterShip rows stuck at 'received', fire them
 * at `process-client-store-webhook` (which doesn't understand their payload
 * shape), and flip status='enqueued' anyway — making genuinely-broken rows
 * look processed. Each non-client-store platform owns its own ingress and
 * does not need this sweeper.
 */
const SWEEP_PLATFORMS = ["shopify", "woocommerce", "squarespace"] as const;

import { idempotencyKeys, logger, schedules, task, tasks } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface SweepResult {
  scanned: number;
  recovered: number;
  failed: number;
  details: Array<{
    id: string;
    platform: string | null;
    status: string;
    outcome: "recovered" | "failed";
    error?: string;
  }>;
}

async function runSweep(): Promise<SweepResult> {
  const supabase = createServiceRoleClient();

  const cutoffIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("webhook_events")
    .select("id, platform, status, created_at")
    .in("status", ["received", "enqueue_failed"])
    .in("platform", [...SWEEP_PLATFORMS])
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    logger.error("webhook-events-recovery-sweep: select failed", {
      error: error.message,
    });
    return { scanned: 0, recovered: 0, failed: 0, details: [] };
  }

  const result: SweepResult = {
    scanned: rows?.length ?? 0,
    recovered: 0,
    failed: 0,
    details: [],
  };

  if (!rows || rows.length === 0) return result;

  for (const row of rows) {
    try {
      // HRD-29: same global idempotency key the route handler uses. If the
      // route already enqueued and only the status update failed, this key
      // collides and Trigger.dev returns the original run id without spawning
      // a duplicate.
      const key = await idempotencyKeys.create(`process-client-store-webhook:${row.id}`, {
        scope: "global",
      });
      await tasks.trigger(
        "process-client-store-webhook",
        { webhookEventId: row.id },
        { idempotencyKey: key },
      );

      await supabase.from("webhook_events").update({ status: "enqueued" }).eq("id", row.id);

      result.recovered += 1;
      result.details.push({
        id: row.id,
        platform: row.platform,
        status: row.status,
        outcome: "recovered",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      // Leave status alone so we retry on the next sweep tick. We only flip
      // back to 'enqueue_failed' if the row was already 'received' (the route
      // handler never updated it, so no enqueue attempt has been recorded).
      if (row.status === "received") {
        await supabase.from("webhook_events").update({ status: "enqueue_failed" }).eq("id", row.id);
      }
      result.failed += 1;
      result.details.push({
        id: row.id,
        platform: row.platform,
        status: row.status,
        outcome: "failed",
        error: reason,
      });
      logger.error("webhook-events-recovery-sweep: trigger failed", {
        id: row.id,
        platform: row.platform,
        error: reason,
      });
    }
  }

  if (result.recovered > 0 || result.failed > 0) {
    logger.info("webhook-events-recovery-sweep: pass complete", {
      scanned: result.scanned,
      recovered: result.recovered,
      failed: result.failed,
    });
  }

  return result;
}

export const webhookEventsRecoverySweepSchedule = schedules.task({
  id: "webhook-events-recovery-sweep-schedule",
  cron: "*/5 * * * *",
  maxDuration: 120,
  run: async () => runSweep(),
});

export const webhookEventsRecoverySweepTask = task({
  id: "webhook-events-recovery-sweep",
  maxDuration: 120,
  run: async () => runSweep(),
});
