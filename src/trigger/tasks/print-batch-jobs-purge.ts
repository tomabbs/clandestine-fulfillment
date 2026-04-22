// Phase 9.1 — print_batch_jobs purge cron.
//
// Runs nightly at 04:00 UTC. Deletes print_batch_jobs rows past expires_at
// (default created_at + 24h). Logs a single sensor reading per run with
// the deleted count so we can spot runaway batch creation.

import { logger, schedules } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const MAX_DELETE_PER_RUN = 5000;

export const printBatchJobsPurgeTask = schedules.task({
  id: "print-batch-jobs-purge",
  cron: "0 4 * * *",
  maxDuration: 120,
  run: async () => {
    const supabase = createServiceRoleClient();

    const { data: candidates } = await supabase
      .from("print_batch_jobs")
      .select("id, workspace_id, status, expires_at")
      .lte("expires_at", new Date().toISOString())
      .neq("status", "pending")
      .limit(MAX_DELETE_PER_RUN);
    const candidateIds = (candidates ?? []).map((r) => r.id as string);

    if (candidateIds.length === 0) {
      logger.log("[print-batch-jobs-purge] nothing to purge");
      return { deleted: 0 };
    }

    const { error } = await supabase.from("print_batch_jobs").delete().in("id", candidateIds);

    if (error) {
      logger.error("[print-batch-jobs-purge] delete failed", { error: error.message });
      return { deleted: 0, error: error.message };
    }

    // Single sensor reading per run; pick first workspace_id we saw for the
    // tag so multi-tenant aggregation works downstream.
    const firstWs = (candidates ?? [])[0]?.workspace_id ?? null;
    if (firstWs) {
      await supabase.from("sensor_readings").insert({
        workspace_id: firstWs,
        sensor_name: "trigger:print-batch-jobs-purge",
        status: "healthy",
        message: `Purged ${candidateIds.length} expired print batch jobs.`,
        value: { deleted: candidateIds.length },
      });
    }

    logger.log("[print-batch-jobs-purge] done", { deleted: candidateIds.length });
    return { deleted: candidateIds.length };
  },
});
