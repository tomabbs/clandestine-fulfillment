/**
 * Daily reconciliation report.
 *
 * Tier 1 hardening (Part 14.7) item #11.
 *
 * Once a day, summarises the previous 24h of:
 *   - external_sync_events status counts (in_flight / success / error)
 *   - warehouse_review_queue open items by severity
 *   - channel_sync_log failures (status='failed')
 *   - ledger errors per system
 *
 * Sends to OPS_ALERT_EMAIL via Resend (and always logs the structured
 * report so it shows up in the Trigger.dev run log even when email is
 * disabled). Idempotent — a second run on the same day produces the same
 * report; we do not write any side-effect rows.
 *
 * Cron: 12:00 UTC = 08:00 ET (DST) / 07:00 ET (winter).
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import { Resend } from "resend";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

export interface DailyReconReport {
  window_start: string;
  window_end: string;
  external_sync_events: {
    in_flight: number;
    success: number;
    error: number;
    by_system_errors: Record<string, number>;
  };
  review_queue: {
    open_total: number;
    by_severity: Record<string, number>;
  };
  channel_sync_log: {
    failed: number;
    partial: number;
    by_channel_failed: Record<string, number>;
  };
}

export interface DailyReconResult {
  success: boolean;
  emailed: boolean;
  report: DailyReconReport;
  error?: string;
}

function increment<T extends string>(map: Record<T, number>, key: T) {
  map[key] = (map[key] ?? 0) + 1;
}

export async function runDailyReconSummary(
  options: {
    now?: Date;
    supabase?: ReturnType<typeof createServiceRoleClient>;
    sendEmail?: (subject: string, body: string) => Promise<void>;
  } = {},
): Promise<DailyReconResult> {
  const supabase = options.supabase ?? createServiceRoleClient();
  const now = options.now ?? new Date();
  const window_end = now.toISOString();
  const window_start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const report: DailyReconReport = {
    window_start,
    window_end,
    external_sync_events: { in_flight: 0, success: 0, error: 0, by_system_errors: {} },
    review_queue: { open_total: 0, by_severity: {} },
    channel_sync_log: { failed: 0, partial: 0, by_channel_failed: {} },
  };

  const { data: events } = await supabase
    .from("external_sync_events")
    .select("status, system")
    .gte("started_at", window_start);

  for (const row of (events ?? []) as Array<{ status: string; system: string }>) {
    if (row.status === "in_flight") report.external_sync_events.in_flight += 1;
    else if (row.status === "success") report.external_sync_events.success += 1;
    else if (row.status === "error") {
      report.external_sync_events.error += 1;
      increment(report.external_sync_events.by_system_errors, row.system);
    }
  }

  const { data: queue } = await supabase
    .from("warehouse_review_queue")
    .select("severity")
    .eq("status", "open");

  for (const row of (queue ?? []) as Array<{ severity: string }>) {
    report.review_queue.open_total += 1;
    increment(report.review_queue.by_severity, row.severity);
  }

  const { data: syncLog } = await supabase
    .from("channel_sync_log")
    .select("channel, status")
    .gte("created_at", window_start)
    .in("status", ["failed", "partial"]);

  for (const row of (syncLog ?? []) as Array<{ channel: string; status: string }>) {
    if (row.status === "failed") {
      report.channel_sync_log.failed += 1;
      increment(report.channel_sync_log.by_channel_failed, row.channel);
    } else {
      report.channel_sync_log.partial += 1;
    }
  }

  logger.info("daily-recon-summary report", {
    task: "daily-recon-summary",
    report,
  });

  let emailed = false;
  // Read process.env directly so test overrides land without re-validating
  // the entire env schema (env() caches on first call). The plan-level Zod
  // validation still runs at boot for required vars; this optional knob is
  // safe to read raw.
  const recipient = (process.env.OPS_ALERT_EMAIL ?? "").trim() || undefined;

  if (recipient) {
    const subject = `[Clandestine] Daily reconciliation — ${window_end.slice(0, 10)}`;
    const body = renderReportBody(report);
    try {
      if (options.sendEmail) {
        await options.sendEmail(subject, body);
      } else {
        const resend = new Resend(env().RESEND_API_KEY);
        await resend.emails.send({
          from: "Clandestine Ops <ops@clandestinedistro.com>",
          to: recipient,
          subject,
          text: body,
        });
      }
      emailed = true;
    } catch (err) {
      logger.error("daily-recon-summary email send failed", {
        task: "daily-recon-summary",
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        emailed: false,
        report,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { success: true, emailed, report };
}

export function renderReportBody(report: DailyReconReport): string {
  const lines: string[] = [];
  lines.push(`Window: ${report.window_start} → ${report.window_end}`);
  lines.push("");
  lines.push("external_sync_events (last 24h):");
  lines.push(`  in_flight: ${report.external_sync_events.in_flight}`);
  lines.push(`  success:   ${report.external_sync_events.success}`);
  lines.push(`  error:     ${report.external_sync_events.error}`);
  if (Object.keys(report.external_sync_events.by_system_errors).length > 0) {
    lines.push("  errors by system:");
    for (const [sys, n] of Object.entries(report.external_sync_events.by_system_errors)) {
      lines.push(`    ${sys}: ${n}`);
    }
  }
  lines.push("");
  lines.push(`warehouse_review_queue open: ${report.review_queue.open_total}`);
  if (Object.keys(report.review_queue.by_severity).length > 0) {
    for (const [sev, n] of Object.entries(report.review_queue.by_severity)) {
      lines.push(`  ${sev}: ${n}`);
    }
  }
  lines.push("");
  lines.push(`channel_sync_log failed (last 24h): ${report.channel_sync_log.failed}`);
  lines.push(`channel_sync_log partial (last 24h): ${report.channel_sync_log.partial}`);
  if (Object.keys(report.channel_sync_log.by_channel_failed).length > 0) {
    lines.push("  failures by channel:");
    for (const [ch, n] of Object.entries(report.channel_sync_log.by_channel_failed)) {
      lines.push(`    ${ch}: ${n}`);
    }
  }
  return lines.join("\n");
}

export const dailyReconSummarySchedule = schedules.task({
  id: "daily-recon-summary-schedule",
  cron: "0 12 * * *",
  maxDuration: 120,
  run: async () => runDailyReconSummary(),
});

export const dailyReconSummaryTask = task({
  id: "daily-recon-summary",
  maxDuration: 120,
  run: async () => runDailyReconSummary(),
});
