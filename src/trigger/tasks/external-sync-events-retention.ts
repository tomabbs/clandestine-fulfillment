/**
 * external_sync_events retention cron.
 *
 * Tier 1 hardening (Part 14.7) item #14, originally Patch D3.
 *
 * The ledger sits on the synchronous hot path of every external write
 * (`beginExternalSync()` is the first thing every Phase 4 fanout call does).
 * Index bloat from millions of `status='success'` rows would degrade
 * `acquireSyncEvent()` latency and slow every fanout call.
 *
 * Retention policy:
 *   - status = 'success' AND completed_at < now() - 7 days  → delete
 *   - status = 'error'   AND completed_at < now() - 30 days → delete (forensics window)
 *   - status = 'in_flight'                                  → never delete
 *
 * Cron: daily 03:30 ET (07:30 UTC during winter, 06:30 UTC during DST).
 * Runs in the off-peak window. Idempotent — repeated runs are no-ops on
 * the second pass. Uses count:'exact' so we can publish row counts to logs
 * + the `daily-recon-summary` (Tier 1 #11).
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const SUCCESS_RETENTION_DAYS = 7;
const ERROR_RETENTION_DAYS = 30;

export interface RetentionResult {
  success: boolean;
  deleted_success: number;
  deleted_error: number;
  ran_at: string;
  error?: string;
}

export async function runExternalSyncRetention(
  options: { now?: Date; supabase?: ReturnType<typeof createServiceRoleClient> } = {},
): Promise<RetentionResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const ran_at = now.toISOString();

  const successCutoff = new Date(now.getTime() - SUCCESS_RETENTION_DAYS * 86_400_000).toISOString();
  const errorCutoff = new Date(now.getTime() - ERROR_RETENTION_DAYS * 86_400_000).toISOString();

  const { count: successCount, error: successErr } = await supabase
    .from("external_sync_events")
    .delete({ count: "exact" })
    .eq("status", "success")
    .lt("completed_at", successCutoff);

  if (successErr) {
    logger.error("external-sync-events retention: success-sweep failed", {
      task: "external-sync-events-retention",
      error: successErr.message,
    });
    return {
      success: false,
      deleted_success: 0,
      deleted_error: 0,
      ran_at,
      error: successErr.message,
    };
  }

  const { count: errorCount, error: errorErr } = await supabase
    .from("external_sync_events")
    .delete({ count: "exact" })
    .eq("status", "error")
    .lt("completed_at", errorCutoff);

  if (errorErr) {
    logger.error("external-sync-events retention: error-sweep failed", {
      task: "external-sync-events-retention",
      error: errorErr.message,
    });
    return {
      success: false,
      deleted_success: successCount ?? 0,
      deleted_error: 0,
      ran_at,
      error: errorErr.message,
    };
  }

  logger.info("external-sync-events retention complete", {
    task: "external-sync-events-retention",
    deleted_success: successCount ?? 0,
    deleted_error: errorCount ?? 0,
  });

  return {
    success: true,
    deleted_success: successCount ?? 0,
    deleted_error: errorCount ?? 0,
    ran_at,
  };
}

export const externalSyncEventsRetentionSchedule = schedules.task({
  id: "external-sync-events-retention-schedule",
  cron: "30 7 * * *",
  maxDuration: 120,
  run: async () => runExternalSyncRetention(),
});

export const externalSyncEventsRetentionTask = task({
  id: "external-sync-events-retention",
  maxDuration: 120,
  run: async () => runExternalSyncRetention(),
});
