import type * as Sentry from "@sentry/nextjs";
import { describe, expect, it, vi } from "vitest";
import { emitOpsAlert } from "@/lib/server/ops-alert";

/**
 * Unit tests for `emitOpsAlert` — the ops-alert dispatcher.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"New helpers this plan introduces" — `emitOpsAlert`
 *
 * Contract properties under test:
 *   1. ALWAYS calls Sentry capture with tags + extras (primary surface).
 *   2. Posts to Slack ONLY when slackWebhookUrl is non-empty.
 *   3. Returns the correct {sentry, slack} status structure.
 *   4. Never throws — Slack/Sentry failures are absorbed.
 *   5. Severity maps to Sentry level + Slack icon correctly.
 *   6. Extras and scope IDs (workspace, connection) are forwarded.
 */

type FetchFn = typeof fetch;
type SentryCaptureFn = (message: string, options: Sentry.CaptureContext) => string;

function makeFetchOk() {
  return vi.fn<FetchFn>(
    async () => ({ ok: true, status: 200 }) as unknown as Awaited<ReturnType<typeof fetch>>,
  );
}

function makeFetchFail() {
  return vi.fn<FetchFn>(
    async () => ({ ok: false, status: 500 }) as unknown as Awaited<ReturnType<typeof fetch>>,
  );
}

function makeSentryCapture(impl?: SentryCaptureFn) {
  return vi.fn<SentryCaptureFn>(impl ?? (() => "event-id"));
}

describe("emitOpsAlert — Sentry path", () => {
  it("always captures a Sentry message with [ops-alert] prefix + tags", async () => {
    const sentryCapture = makeSentryCapture(() => "event-123");

    const result = await emitOpsAlert(
      {
        type: "bulk_hold_suppression_active",
        severity: "high",
        message: "fetch_incomplete_at_match surge: 12 holds in 15 min",
        workspaceId: "ws-1",
        connectionId: "conn-1",
        extras: { recent_count: 12, threshold: 10 },
      },
      { sentryCapture, slackWebhookUrl: null },
    );

    expect(result.sentry).toBe(true);
    expect(sentryCapture).toHaveBeenCalledTimes(1);
    const [message, options] = sentryCapture.mock.calls[0] ?? [];
    expect(message).toBe("[ops-alert] fetch_incomplete_at_match surge: 12 holds in 15 min");
    const ctx = options as Sentry.CaptureContext & {
      level?: string;
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    };
    expect(ctx.level).toBe("error");
    expect(ctx.tags).toMatchObject({
      ops_alert: "true",
      ops_alert_type: "bulk_hold_suppression_active",
      ops_alert_severity: "high",
    });
    expect(ctx.extra).toMatchObject({
      workspace_id: "ws-1",
      connection_id: "conn-1",
      recent_count: 12,
      threshold: 10,
    });
  });

  it("maps severity → Sentry level correctly (info/low/medium/high/critical)", async () => {
    const cases: Array<{
      severity: "info" | "low" | "medium" | "high" | "critical";
      sentryLevel: string;
    }> = [
      { severity: "info", sentryLevel: "info" },
      { severity: "low", sentryLevel: "warning" },
      { severity: "medium", sentryLevel: "warning" },
      { severity: "high", sentryLevel: "error" },
      { severity: "critical", sentryLevel: "fatal" },
    ];

    for (const { severity, sentryLevel } of cases) {
      const sentryCapture = makeSentryCapture(() => "event-id");
      await emitOpsAlert(
        {
          type: "phase_advancement_blocked",
          severity,
          message: "ping",
        },
        { sentryCapture, slackWebhookUrl: null },
      );
      const [, options] = sentryCapture.mock.calls[0] ?? [];
      const ctx = options as Sentry.CaptureContext & { level?: string };
      expect(ctx.level).toBe(sentryLevel);
    }
  });

  it("returns {sentry:false} when Sentry capture throws but does not raise", async () => {
    const sentryCapture = makeSentryCapture(() => {
      throw new Error("sentry broken");
    });

    const result = await emitOpsAlert(
      {
        type: "hold_alert_dispatch_failed",
        severity: "high",
        message: "test",
      },
      { sentryCapture, slackWebhookUrl: null },
    );

    expect(result.sentry).toBe(false);
    expect(result.slack).toBe("unconfigured");
  });

  it("preserves caller-supplied extras alongside workspace/connection scope", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    await emitOpsAlert(
      {
        type: "sku_autonomous_emergency_paused",
        severity: "critical",
        message: "emergency pause flipped",
        workspaceId: "ws-7",
        extras: { actor: "cli", run_id: "run-abc" },
      },
      { sentryCapture, slackWebhookUrl: null },
    );
    const [, options] = sentryCapture.mock.calls[0] ?? [];
    const ctx = options as Sentry.CaptureContext & {
      extra?: Record<string, unknown>;
    };
    expect(ctx.extra).toEqual({
      workspace_id: "ws-7",
      connection_id: null,
      actor: "cli",
      run_id: "run-abc",
    });
  });
});

describe("emitOpsAlert — Slack path", () => {
  it("returns 'unconfigured' when slackWebhookUrl is null", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    const fetchImpl = makeFetchOk();

    const result = await emitOpsAlert(
      {
        type: "bulk_hold_suppression_active",
        severity: "high",
        message: "test",
      },
      { sentryCapture, fetchImpl, slackWebhookUrl: null },
    );

    expect(result.slack).toBe("unconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to Slack when slackWebhookUrl is provided; returns 'sent' on 2xx", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    const fetchImpl = makeFetchOk();

    const result = await emitOpsAlert(
      {
        type: "bulk_hold_suppression_active",
        severity: "high",
        message: "fetch_incomplete_at_match surge",
        workspaceId: "ws-1",
        connectionId: "conn-1",
        extras: { recent_count: 12 },
      },
      {
        sentryCapture,
        fetchImpl,
        slackWebhookUrl: "https://hooks.slack.com/services/fake",
      },
    );

    expect(result.slack).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://hooks.slack.com/services/fake");
    const fetchInit = init as RequestInit;
    expect(fetchInit.method).toBe("POST");
    const body = JSON.parse(fetchInit.body as string) as { text: string };
    expect(body.text).toContain("bulk_hold_suppression_active");
    expect(body.text).toContain("fetch_incomplete_at_match surge");
    expect(body.text).toContain("workspace: `ws-1`");
    expect(body.text).toContain("connection: `conn-1`");
    expect(body.text).toContain('"recent_count":12');
    expect(body.text).toContain("runbook:");
  });

  it("returns 'failed' on non-2xx Slack response without throwing", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    const fetchImpl = makeFetchFail();

    const result = await emitOpsAlert(
      {
        type: "bulk_hold_suppression_active",
        severity: "high",
        message: "test",
      },
      {
        sentryCapture,
        fetchImpl,
        slackWebhookUrl: "https://hooks.slack.com/services/fake",
      },
    );

    expect(result.sentry).toBe(true);
    expect(result.slack).toBe("failed");
  });

  it("returns 'failed' when fetch throws (network down) without raising", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    const fetchImpl = vi.fn<FetchFn>(async () => {
      throw new Error("network error");
    });

    const result = await emitOpsAlert(
      {
        type: "bulk_hold_suppression_active",
        severity: "high",
        message: "test",
      },
      {
        sentryCapture,
        fetchImpl,
        slackWebhookUrl: "https://hooks.slack.com/services/fake",
      },
    );

    expect(result.slack).toBe("failed");
  });

  it("includes severity icon in Slack body", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    const fetchImpl = makeFetchOk();

    await emitOpsAlert(
      {
        type: "sku_autonomous_emergency_paused",
        severity: "critical",
        message: "kill switch hit",
      },
      {
        sentryCapture,
        fetchImpl,
        slackWebhookUrl: "https://hooks.slack.com/services/fake",
      },
    );

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse((init as RequestInit).body as string) as {
      text: string;
    };
    expect(body.text).toContain(":fire:");
  });

  it("omits context line when extras is empty/undefined", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    const fetchImpl = makeFetchOk();

    await emitOpsAlert(
      {
        type: "phase_advancement_blocked",
        severity: "medium",
        message: "test",
      },
      {
        sentryCapture,
        fetchImpl,
        slackWebhookUrl: "https://hooks.slack.com/services/fake",
      },
    );

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse((init as RequestInit).body as string) as {
      text: string;
    };
    expect(body.text).not.toContain("context:");
  });
});

describe("emitOpsAlert — composite result", () => {
  it("returns {sentry:true, slack:'sent'} for a fully healthy dispatch", async () => {
    const sentryCapture = makeSentryCapture(() => "id");
    const fetchImpl = makeFetchOk();

    const result = await emitOpsAlert(
      {
        type: "bulk_hold_suppression_active",
        severity: "high",
        message: "happy path",
      },
      {
        sentryCapture,
        fetchImpl,
        slackWebhookUrl: "https://hooks.slack.com/services/fake",
      },
    );

    expect(result).toEqual({ sentry: true, slack: "sent" });
  });

  it("returns {sentry:false, slack:'failed'} when everything fails — and still does not throw", async () => {
    const sentryCapture = makeSentryCapture(() => {
      throw new Error("sentry broken");
    });
    const fetchImpl = makeFetchFail();

    const result = await emitOpsAlert(
      {
        type: "bulk_hold_suppression_active",
        severity: "high",
        message: "sad path",
      },
      {
        sentryCapture,
        fetchImpl,
        slackWebhookUrl: "https://hooks.slack.com/services/fake",
      },
    );

    expect(result).toEqual({ sentry: false, slack: "failed" });
  });
});
