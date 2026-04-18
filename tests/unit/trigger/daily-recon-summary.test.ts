import { describe, expect, it, vi } from "vitest";
import { renderReportBody, runDailyReconSummary } from "@/trigger/tasks/daily-recon-summary";

interface QueryReturn {
  data: unknown[] | null;
  error?: unknown;
}

function fakeSupabase(opts: {
  events?: Array<{ status: string; system: string }>;
  queue?: Array<{ severity: string }>;
  syncLog?: Array<{ channel: string; status: string }>;
}) {
  return {
    from: (table: string) => {
      const dataFor = (): QueryReturn => {
        if (table === "external_sync_events") return { data: opts.events ?? [] };
        if (table === "warehouse_review_queue") return { data: opts.queue ?? [] };
        if (table === "channel_sync_log") return { data: opts.syncLog ?? [] };
        return { data: [] };
      };

      type Builder = {
        select: () => Builder;
        gte: (col: string, val: string) => Builder | Promise<QueryReturn>;
        eq: (col: string, val: string) => Builder | Promise<QueryReturn>;
        in: (col: string, vals: string[]) => Promise<QueryReturn>;
      };

      const builder: Builder = {
        select: () => builder,
        gte: (_col: string, _val: string) => {
          // external_sync_events terminates on .gte() (no further chain).
          if (table === "external_sync_events") return Promise.resolve(dataFor());
          // channel_sync_log chains .gte().in(); return builder so .in() can resolve.
          return builder;
        },
        eq: (_col: string, _val: string) => {
          // warehouse_review_queue terminates on .eq("status", "open").
          if (table === "warehouse_review_queue") return Promise.resolve(dataFor());
          return builder;
        },
        in: (_col: string, _vals: string[]) => Promise.resolve(dataFor()),
      };

      return builder;
    },
  };
}

describe("runDailyReconSummary", () => {
  it("aggregates counts across all three tables", async () => {
    const supabase = fakeSupabase({
      events: [
        { status: "success", system: "shipstation_v2" },
        { status: "success", system: "bandcamp" },
        { status: "error", system: "bandcamp" },
        { status: "error", system: "bandcamp" },
        { status: "in_flight", system: "shipstation_v2" },
      ],
      queue: [
        { severity: "critical" },
        { severity: "high" },
        { severity: "high" },
        { severity: "low" },
      ],
      syncLog: [
        { channel: "bandcamp", status: "failed" },
        { channel: "shipstation", status: "failed" },
        { channel: "bandcamp", status: "partial" },
      ],
    });

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const result = await runDailyReconSummary({
      now: new Date("2026-04-13T12:00:00Z"),
      supabase: supabase as never,
      sendEmail,
    });

    expect(result.success).toBe(true);
    expect(result.report.external_sync_events.success).toBe(2);
    expect(result.report.external_sync_events.error).toBe(2);
    expect(result.report.external_sync_events.in_flight).toBe(1);
    expect(result.report.external_sync_events.by_system_errors).toEqual({ bandcamp: 2 });
    expect(result.report.review_queue.open_total).toBe(4);
    expect(result.report.review_queue.by_severity).toEqual({ critical: 1, high: 2, low: 1 });
    expect(result.report.channel_sync_log.failed).toBe(2);
    expect(result.report.channel_sync_log.partial).toBe(1);
    expect(result.report.channel_sync_log.by_channel_failed).toEqual({
      bandcamp: 1,
      shipstation: 1,
    });
  });

  it("does not call sendEmail when OPS_ALERT_EMAIL is unset", async () => {
    const original = process.env.OPS_ALERT_EMAIL;
    process.env.OPS_ALERT_EMAIL = "";
    const sendEmail = vi.fn();
    const result = await runDailyReconSummary({
      now: new Date("2026-04-13T12:00:00Z"),
      supabase: fakeSupabase({}) as never,
      sendEmail,
    });
    process.env.OPS_ALERT_EMAIL = original;
    expect(result.emailed).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("returns error result when sendEmail throws (when recipient set)", async () => {
    const original = process.env.OPS_ALERT_EMAIL;
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    const sendEmail = vi.fn().mockRejectedValue(new Error("smtp down"));
    const result = await runDailyReconSummary({
      now: new Date("2026-04-13T12:00:00Z"),
      supabase: fakeSupabase({}) as never,
      sendEmail,
    });
    process.env.OPS_ALERT_EMAIL = original;
    expect(result.success).toBe(false);
    expect(result.error).toContain("smtp");
    expect(result.emailed).toBe(false);
  });
});

describe("renderReportBody", () => {
  it("renders all sections", () => {
    const body = renderReportBody({
      window_start: "2026-04-12T12:00:00.000Z",
      window_end: "2026-04-13T12:00:00.000Z",
      external_sync_events: {
        in_flight: 1,
        success: 100,
        error: 3,
        by_system_errors: { bandcamp: 3 },
      },
      review_queue: { open_total: 5, by_severity: { critical: 1, high: 4 } },
      channel_sync_log: { failed: 2, partial: 1, by_channel_failed: { bandcamp: 2 } },
    });
    expect(body).toContain("in_flight: 1");
    expect(body).toContain("success:   100");
    expect(body).toContain("error:     3");
    expect(body).toContain("warehouse_review_queue open: 5");
    expect(body).toContain("channel_sync_log failed (last 24h): 2");
    expect(body).toContain("bandcamp: 2");
  });
});
