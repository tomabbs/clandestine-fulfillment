// Phase 12 / Slice 1 + Slice 2 — Resend webhook receiver.
//
// Slice 1 wiring (this commit's worth):
//   - Verify Svix signature (with optional dual-secret rotation overlap).
//   - Insert webhook_events for replay-protection dedup. Use
//     interpretDedupError so transient PostgREST errors → 503 (retry),
//     duplicates → 200 OK, schema regressions → 503 + Sentry.
//   - Insert notification_provider_events FIRST (immutable ledger) — even
//     for events we don't have a notification_sends rollup for.
//   - Map Resend event type → notification_sends rollup transition via the
//     status state machine wrapper (Slice 2 introduces the wrapper; the
//     Slice 1 version goes through the same helper so the contract is
//     stable across slices).
//   - Handle the broader Resend event surface: email.sent (no-op),
//     email.delivered (audit), email.delivery_delayed (transitional),
//     email.bounced (suppress + final), email.complained (suppress +
//     final), email.failed (provider-failed final), email.suppressed
//     (provider-suppressed final), email.opened / email.clicked
//     (currently no-op but persisted to ledger).
//
// Production secret REQUIRED; missing-in-prod returns 500 (mirrors EP / SS).

import * as Sentry from "@sentry/nextjs";
import { type NextRequest, NextResponse } from "next/server";
import { recordProviderEvent } from "@/lib/server/notification-provider-events";
import {
  findNotificationSendByMessageId,
  type NotificationSendStatus,
  suppressRecipient,
} from "@/lib/server/notification-sends";
import { updateNotificationStatusSafe } from "@/lib/server/notification-status";
import { verifyResendWebhook } from "@/lib/server/resend-webhook-signature";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { interpretDedupError } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResendWebhookPayload {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    from?: string;
    subject?: string;
    bounce?: { message?: string; type?: string };
    complaint?: { message?: string };
    /** Some failure events surface a plain `error` string. */
    error?: string | { message?: string };
  };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const { RESEND_WEBHOOK_SECRET, RESEND_WEBHOOK_SECRET_PREVIOUS } = env();
  const isProd = process.env.NODE_ENV === "production";
  const secrets = [RESEND_WEBHOOK_SECRET, RESEND_WEBHOOK_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (isProd && secrets.length === 0) {
    Sentry.captureMessage("[resend-webhook] secret unset in production", {
      level: "error",
      tags: { platform: "resend", failure: "secret_missing_in_prod" },
    });
    return NextResponse.json({ error: "Webhook misconfigured" }, { status: 500 });
  }

  const svixId = req.headers.get("svix-id");
  if (secrets.length > 0) {
    const verify = verifyResendWebhook({
      rawBody,
      secrets,
      svixId,
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
    });
    if (!verify.valid) {
      Sentry.captureMessage(`[resend-webhook] verify failed: ${verify.reason}`, {
        level: "warning",
        tags: { platform: "resend", failure: verify.reason ?? "unknown" },
      });
      // Slice 4 — persist a webhook_events row with status='signature_failed'
      // so notification-failure-sensor can roll up per-platform sig-failure
      // rates per hour. svix-id (when present) makes retries collapse on the
      // existing UNIQUE index instead of inflating the rollup.
      const { createHash } = await import("node:crypto");
      const sigFailureExternalId = svixId
        ? `resend:sigfail:${svixId}`
        : `resend:sigfail:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
      try {
        await createServiceRoleClient()
          .from("webhook_events")
          .insert({
            platform: "resend",
            external_webhook_id: sigFailureExternalId,
            topic: "signature_failed",
            status: "signature_failed",
            metadata: {
              reason: verify.reason ?? "unknown",
              svix_id: svixId,
            },
          });
      } catch {
        // never let logging break the response
      }
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (typeof verify.secretIndex === "number" && verify.secretIndex > 0) {
      Sentry.captureMessage("[resend-webhook] verified with previous (rotation) secret", {
        level: "info",
        tags: { platform: "resend", rotation: "previous_secret" },
      });
    }
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ResendWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const messageId = payload.data?.email_id ?? null;
  const eventType = payload.type ?? "unknown";
  const supabase = createServiceRoleClient();

  // Rule #62: dedup via webhook_events INSERT ON CONFLICT. Prefer svix-id
  // (per-delivery unique, set by Svix on every attempted delivery — survives
  // Resend retries cleanly); fall back to `${type}:${email_id}` when the
  // header is absent (e.g. dev replays).
  const externalId = svixId ? `resend:${svixId}` : `resend:${eventType}:${messageId ?? "no-id"}`;
  const { data: insertedRow, error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "resend",
      external_webhook_id: externalId,
      topic: eventType,
      metadata: { type: eventType, email_id: messageId },
    })
    .select("id")
    .single();
  const dedupResult = interpretDedupError(insertedRow, dedupError);
  if (dedupResult.kind === "duplicate") {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }
  if (dedupResult.kind === "transient" || dedupResult.kind === "unknown") {
    Sentry.captureMessage(`[resend-webhook] dedup insert failed: ${dedupResult.kind}`, {
      level: dedupResult.kind === "unknown" ? "error" : "warning",
      tags: { platform: "resend", failure: dedupResult.kind },
      extra: {
        external_webhook_id: externalId,
        sql_state: dedupResult.sqlState ?? null,
        reason: dedupResult.reason,
      },
    });
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  // Resolve the linked notification_sends row by Resend message id (if any).
  // Done BEFORE the ledger insert so the ledger row carries the link.
  const sendRow = messageId ? await findNotificationSendByMessageId(supabase, messageId) : null;

  // ── 1. Append-only ledger insert (NEVER skipped) ────────────────────────
  const recipients = collectRecipients(payload.data?.to ?? []);
  try {
    await recordProviderEvent(supabase, {
      provider: "resend",
      providerEventId: svixId ?? `${eventType}:${messageId ?? externalId}`,
      eventType,
      providerMessageId: messageId,
      // Carry workspace + shipment context when the matched send row has it
      // so the Slice 4 per-shipment drilldown can render a unified timeline
      // without re-resolving the link from notification_send_id.
      workspaceId: sendRow?.workspace_id ?? null,
      notificationSendId: sendRow?.id ?? null,
      shipmentId: sendRow?.shipment_id ?? null,
      recipient: recipients[0] ?? null,
      occurredAt: payload.created_at ?? null,
      payload: payload as unknown as Record<string, unknown>,
    });
  } catch (err) {
    // Ledger write failure is logged but does NOT abort the webhook —
    // we still want the rollup transition to apply (and the platform
    // would re-send if we 503'd, leading to the same problem on the next
    // attempt). Sentry will surface the regression so we can fix it.
    Sentry.captureException(err, {
      tags: { platform: "resend", failure: "provider_event_insert" },
    });
  }

  if (!messageId) {
    return NextResponse.json({ ok: true, status: "no_email_id" });
  }

  try {
    // ── 2. Map provider event → rollup status (state-machine guarded) ─────
    const transition = mapEventToTransition(eventType, payload);
    if (!transition) {
      // Persisted to ledger above; nothing to roll up.
      return NextResponse.json({ ok: true, status: "ignored", type: eventType });
    }

    if (!sendRow) {
      // No matching notification_sends row — the ledger captured the
      // event for forensics. This happens when a provider event arrives
      // for a send that was created in a rolled-back transaction or
      // before the rollup table existed. Not an error.
      return NextResponse.json({ ok: true, status: "no_matching_send" });
    }

    const result = await updateNotificationStatusSafe(supabase, {
      notificationSendId: sendRow.id,
      newStatus: transition.status,
      error: transition.detail,
      providerEventType: eventType,
    });

    // ── 3. Side effects (suppression, alerting) ───────────────────────────
    if (
      transition.status === "bounced" ||
      transition.status === "complained" ||
      transition.status === "provider_suppressed"
    ) {
      const suppressionType =
        transition.status === "bounced"
          ? "bounce"
          : transition.status === "complained"
            ? "complaint"
            : "manual";
      for (const r of recipients) {
        await suppressRecipient(supabase, {
          workspaceId: sendRow.workspace_id,
          recipient: r,
          suppressionType,
          reason: transition.detail,
          sourceMessageId: messageId,
        });
      }
      if (transition.status === "complained") {
        Sentry.captureMessage(`[resend-webhook] complaint received for message ${messageId}`, {
          level: "warning",
          tags: { platform: "resend", failure: "complaint" },
          extra: { recipients, detail: transition.detail },
        });
      }
    }

    return NextResponse.json({
      ok: true,
      status: result.applied ? "processed" : "no_op",
      previous_status: result.previousStatus,
      new_status: result.newStatus,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { platform: "resend", failure: "processing_error" },
    });
    // 200 OK so the platform doesn't retry — ledger has the raw event,
    // Sentry has the diagnostic, ops can replay manually if needed.
    return NextResponse.json({ ok: true, status: "error_logged" });
  }
}

interface RollupTransition {
  status: NotificationSendStatus;
  detail: string | null;
}

function mapEventToTransition(
  type: string,
  payload: ResendWebhookPayload,
): RollupTransition | null {
  switch (type) {
    case "email.sent":
      // We already wrote 'sent' or 'pending'→'sent' from the producer side.
      return null;
    case "email.delivered":
      return { status: "delivered", detail: null };
    case "email.delivery_delayed":
      return { status: "delivery_delayed", detail: null };
    case "email.bounced":
      return {
        status: "bounced",
        detail: payload.data?.bounce?.message ?? payload.data?.bounce?.type ?? "bounced",
      };
    case "email.complained":
      return {
        status: "complained",
        detail: payload.data?.complaint?.message ?? "spam complaint",
      };
    case "email.failed": {
      const err = payload.data?.error;
      const msg = typeof err === "string" ? err : (err?.message ?? "provider failed");
      return { status: "provider_failed", detail: msg };
    }
    case "email.suppressed": {
      // Resend's suppression event — recipient is on the global suppression
      // list (prior bounce / complaint / manual suppression). Sticky-terminal
      // status. If Resend renames or removes this event before merge, the
      // default branch below preserves ledger-only behavior (no crash).
      return {
        status: "provider_suppressed",
        detail: typeof payload.data?.error === "string" ? payload.data?.error : "suppressed",
      };
    }
    default:
      // Persist to ledger (already done) but no rollup change for opened/
      // clicked/etc. — could be wired to engagement metrics later.
      // Per v5: unknown event types default to ledger-only, never crash.
      return null;
  }
}

function collectRecipients(
  to: ResendWebhookPayload["data"] extends infer D
    ? D extends { to?: infer T }
      ? T
      : never
    : never,
): string[] {
  if (!to) return [];
  if (Array.isArray(to)) return to.filter((r): r is string => typeof r === "string");
  if (typeof to === "string") return [to];
  return [];
}
