/**
 * Autonomous SKU matcher — thin ops-alert dispatcher.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"New helpers this plan introduces" note for `emitOpsAlert`.
 *
 * `emitOpsAlert` is a dispatcher (NOT a new notification channel) that
 * fans out a single ops-severity signal to:
 *   1. Sentry (`@sentry/nextjs`) as a captured "message" event with
 *      structured tags + extras — this is the primary on-call surface.
 *   2. Slack (`SLACK_OPS_WEBHOOK_URL`, optional) as a human-readable
 *      summary — supplementary channel, non-critical if it fails.
 *
 * Scope rules:
 *   * This module MUST stay small. If a caller needs bespoke alert
 *     formatting or extra side-effects (email, PagerDuty, etc.) they
 *     build the side-effect themselves and call `emitOpsAlert` for
 *     the Sentry/Slack portion. This keeps one call site per alert.
 *   * Bulk-hold suppression (SKU-AUTO-31) calls this ONCE per
 *     suppression window, not once per suppressed hold, so the
 *     function does not include in-process debouncing — the caller
 *     owns that responsibility.
 *   * Non-blocking: Slack failures never throw. Sentry failures never
 *     throw. This function always resolves.
 *
 * Alert-type registry:
 *   New alert types MUST be added to the `OpsAlertType` union here
 *   (forces type-check to catch typos). Current types are documented
 *   inline; extend as new use cases land.
 */

import * as Sentry from "@sentry/nextjs";
import { env } from "@/lib/shared/env";

const RUNBOOK_URL = "https://clandestine-fulfillment.runbooks/ops-alerts";

/**
 * Alert-type registry. Add a new entry here when a new caller starts
 * emitting ops alerts. The string is Sentry-safe (lowercase, dashes).
 */
export type OpsAlertType =
  | "bulk_hold_suppression_active"
  | "hold_alert_dispatch_failed"
  | "sku_autonomous_emergency_paused"
  | "phase_advancement_blocked"
  | "sku_autonomous_cancellation_raised";

export type OpsAlertSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface OpsAlertInput {
  /** Alert-type string — MUST be a registered `OpsAlertType`. */
  type: OpsAlertType;
  /** Severity hint. Drives Sentry level + Slack icon. */
  severity: OpsAlertSeverity;
  /** Short human-readable summary for Slack + Sentry message. */
  message: string;
  /** Workspace the alert is scoped to, when applicable. */
  workspaceId?: string | null;
  /** Connection the alert is scoped to, when applicable. */
  connectionId?: string | null;
  /** Additional structured context for Sentry extras + Slack JSON. */
  extras?: Record<string, unknown>;
}

export interface OpsAlertResult {
  sentry: boolean;
  slack: "sent" | "unconfigured" | "failed";
}

function severityToSentryLevel(severity: OpsAlertSeverity): Sentry.SeverityLevel {
  switch (severity) {
    case "info":
      return "info";
    case "low":
      return "warning";
    case "medium":
      return "warning";
    case "high":
      return "error";
    case "critical":
      return "fatal";
  }
}

function severityToSlackIcon(severity: OpsAlertSeverity): string {
  switch (severity) {
    case "info":
      return ":information_source:";
    case "low":
      return ":warning:";
    case "medium":
      return ":warning:";
    case "high":
      return ":rotating_light:";
    case "critical":
      return ":fire:";
  }
}

/**
 * Fan out an ops alert to Sentry + (optionally) Slack. Never throws.
 *
 * `fetchImpl` is injectable for unit tests; production callers use
 * the global `fetch`. `sentryCapture` is also injectable for unit
 * tests so we can assert the exact payload without coupling tests to
 * Sentry's SDK internals.
 */
export async function emitOpsAlert(
  input: OpsAlertInput,
  deps: {
    fetchImpl?: typeof fetch;
    sentryCapture?: (message: string, options: Sentry.CaptureContext) => string;
    slackWebhookUrl?: string | null;
  } = {},
): Promise<OpsAlertResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sentryCapture =
    deps.sentryCapture ??
    ((message: string, options: Sentry.CaptureContext) =>
      Sentry.captureMessage(message, options) as unknown as string);

  let slackUrl = deps.slackWebhookUrl;
  if (slackUrl === undefined) {
    try {
      slackUrl = env().SLACK_OPS_WEBHOOK_URL ?? null;
    } catch {
      // env() may throw in test contexts without full env; treat as
      // unconfigured.
      slackUrl = null;
    }
  }

  // ── Sentry ─────────────────────────────────────────────────────────
  let sentryOk = false;
  try {
    sentryCapture(`[ops-alert] ${input.message}`, {
      level: severityToSentryLevel(input.severity),
      tags: {
        ops_alert: "true",
        ops_alert_type: input.type,
        ops_alert_severity: input.severity,
      },
      extra: {
        workspace_id: input.workspaceId ?? null,
        connection_id: input.connectionId ?? null,
        ...(input.extras ?? {}),
      },
    });
    sentryOk = true;
  } catch {
    sentryOk = false;
  }

  // ── Slack ──────────────────────────────────────────────────────────
  let slackResult: "sent" | "unconfigured" | "failed" = "unconfigured";
  if (slackUrl) {
    try {
      const icon = severityToSlackIcon(input.severity);
      const parts: string[] = [
        `${icon} *${input.type}* (severity: ${input.severity})`,
        input.message,
      ];
      if (input.workspaceId) parts.push(`• workspace: \`${input.workspaceId}\``);
      if (input.connectionId) parts.push(`• connection: \`${input.connectionId}\``);
      if (input.extras && Object.keys(input.extras).length > 0) {
        parts.push(`• context: \`${JSON.stringify(input.extras)}\``);
      }
      parts.push(`• runbook: ${RUNBOOK_URL}`);

      const response = await fetchImpl(slackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: parts.join("\n") }),
      });
      slackResult = response.ok ? "sent" : "failed";
    } catch {
      slackResult = "failed";
    }
  }

  return { sentry: sentryOk, slack: slackResult };
}
