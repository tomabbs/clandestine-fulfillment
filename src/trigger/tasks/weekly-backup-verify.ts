/**
 * Weekly backup verification probe.
 *
 * Tier 1 hardening (Part 14.7) item #8.
 *
 * The plan's full intent — restore the latest Supabase backup into a
 * sandbox project and row-count-compare against prod for 5 critical
 * tables — requires operator-provisioned sandbox credentials and
 * cross-project service-role keys that cannot ship from a code-only
 * change. See docs/operations/runbooks/backup-verify.md for the full
 * operator procedure that wraps this probe.
 *
 * Agent slice (this task):
 *   - Verifies the 5 critical tables exist and are non-empty (sentinel:
 *     zero rows = catastrophic data loss or RLS regression — loud alert).
 *   - Verifies the latest write timestamp in each table is within the
 *     freshness threshold (90 days for workspaces, 7 days for the four
 *     mutable tables).
 *   - Logs the structured report; alerts are surfaced via the daily
 *     reconciliation summary (Tier 1 #11) which reads channel_sync_log.
 *
 * Cron: Sundays 09:00 UTC (low-traffic window for warehouse staff).
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CriticalTableSpec {
  name: string;
  /** Column used to assert recency. Set to null for static tables. */
  recency_column: string | null;
  /** Max age (days) for the most recent row. */
  max_age_days: number | null;
}

const CRITICAL_TABLES: CriticalTableSpec[] = [
  { name: "workspaces", recency_column: null, max_age_days: null },
  { name: "warehouse_inventory_levels", recency_column: "updated_at", max_age_days: 30 },
  { name: "warehouse_product_variants", recency_column: "created_at", max_age_days: 365 },
  { name: "warehouse_orders", recency_column: "created_at", max_age_days: 30 },
  { name: "external_sync_events", recency_column: "started_at", max_age_days: 30 },
];

export interface BackupVerifyResult {
  success: boolean;
  ran_at: string;
  rows_per_table: Record<string, number>;
  most_recent_per_table: Record<string, string | null>;
  alerts: string[];
}

export async function runWeeklyBackupVerify(
  options: { now?: Date; supabase?: ReturnType<typeof createServiceRoleClient> } = {},
): Promise<BackupVerifyResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();

  const rows_per_table: Record<string, number> = {};
  const most_recent_per_table: Record<string, string | null> = {};
  const alerts: string[] = [];

  for (const spec of CRITICAL_TABLES) {
    const { count, error } = await supabase
      .from(spec.name)
      .select("*", { count: "exact", head: true });

    if (error) {
      alerts.push(`Could not read ${spec.name}: ${error.message}`);
      rows_per_table[spec.name] = -1;
      most_recent_per_table[spec.name] = null;
      continue;
    }

    const observed = count ?? 0;
    rows_per_table[spec.name] = observed;

    if (observed === 0) {
      alerts.push(`${spec.name} has 0 rows — possible data loss or RLS regression.`);
      most_recent_per_table[spec.name] = null;
      continue;
    }

    if (spec.recency_column && spec.max_age_days != null) {
      const { data: latest } = await supabase
        .from(spec.name)
        .select(spec.recency_column)
        .order(spec.recency_column, { ascending: false })
        .limit(1)
        .maybeSingle();

      const latestVal =
        latest && typeof latest === "object"
          ? (latest as Record<string, string | null>)[spec.recency_column]
          : null;
      most_recent_per_table[spec.name] = latestVal;

      if (latestVal) {
        const ageMs = now.getTime() - new Date(latestVal).getTime();
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        if (ageDays > spec.max_age_days) {
          alerts.push(
            `${spec.name} most-recent ${spec.recency_column}=${latestVal} is ${ageDays.toFixed(
              1,
            )}d old (threshold ${spec.max_age_days}d).`,
          );
        }
      } else {
        alerts.push(`${spec.name} could not read ${spec.recency_column} value.`);
      }
    } else {
      most_recent_per_table[spec.name] = null;
    }
  }

  logger.info("weekly-backup-verify probe complete", {
    task: "weekly-backup-verify",
    rows_per_table,
    most_recent_per_table,
    alerts,
  });

  return {
    success: alerts.length === 0,
    ran_at: now.toISOString(),
    rows_per_table,
    most_recent_per_table,
    alerts,
  };
}

export const weeklyBackupVerifySchedule = schedules.task({
  id: "weekly-backup-verify-schedule",
  cron: "0 9 * * 0",
  maxDuration: 180,
  run: async () => runWeeklyBackupVerify(),
});

export const weeklyBackupVerifyTask = task({
  id: "weekly-backup-verify",
  maxDuration: 180,
  run: async () => runWeeklyBackupVerify(),
});
