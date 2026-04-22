// Phase 12 — Resend webhook receiver.
//
// Handles delivery + bounce + complaint events from Resend. The most
// important behaviors:
//   - on `email.bounced`  → mark notification_sends row as 'bounced' AND add
//                           recipient to resend_suppressions so we never
//                           re-attempt to send to that address.
//   - on `email.complained` → same as bounced + status='complained'. This
//                             is a deliverability emergency — recipient
//                             flagged us as spam. Hard-suppress globally if
//                             needed; alert ops via Sentry.
//   - on `email.delivered` → audit-only update on the notification_sends row.
//   - on `email.sent`      → no-op (we already wrote that row when we sent).
//
// Production secret REQUIRED; missing-in-prod returns 500 (mirrors EP / SS).

import * as Sentry from "@sentry/nextjs";
import { type NextRequest, NextResponse } from "next/server";
import {
  type NotificationSendStatus,
  suppressRecipient,
  updateSendOutcomeByMessageId,
} from "@/lib/server/notification-sends";
import { verifyResendWebhook } from "@/lib/server/resend-webhook-signature";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResendWebhookPayload {
  type?: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    from?: string;
    subject?: string;
    bounce?: { message?: string; type?: string };
    complaint?: { message?: string };
  };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const { RESEND_WEBHOOK_SECRET } = env();
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !RESEND_WEBHOOK_SECRET) {
    Sentry.captureMessage("[resend-webhook] secret unset in production", {
      level: "error",
      tags: { platform: "resend", failure: "secret_missing_in_prod" },
    });
    return NextResponse.json({ error: "secret not configured" }, { status: 500 });
  }

  const svixId = req.headers.get("svix-id");
  if (RESEND_WEBHOOK_SECRET) {
    const verify = verifyResendWebhook({
      rawBody,
      secret: RESEND_WEBHOOK_SECRET,
      svixId,
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
    });
    if (!verify.valid) {
      Sentry.captureMessage(`[resend-webhook] verify failed: ${verify.reason}`, {
        level: "warning",
        tags: { platform: "resend", failure: verify.reason ?? "unknown" },
      });
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ResendWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const messageId = payload.data?.email_id;
  if (!messageId) {
    return NextResponse.json({ ok: true, status: "no_email_id" });
  }
  const supabase = createServiceRoleClient();

  // Rule #62: dedup via webhook_events INSERT ON CONFLICT. Resend fires
  // multiple events per email (sent / delivered / bounced / complained / …)
  // so the dedup key must include the event TYPE in addition to the
  // delivery id. Prefer svix-id (per-delivery unique, set by Svix on every
  // attempted delivery — survives Resend retries cleanly); fall back to
  // `${type}:${email_id}` when the header is absent (e.g. dev replays).
  const externalId = svixId
    ? `resend:${svixId}`
    : `resend:${payload.type ?? "unknown"}:${messageId}`;
  const { error: dedupError } = await supabase.from("webhook_events").insert({
    platform: "resend",
    external_webhook_id: externalId,
    payload: { type: payload.type, email_id: messageId },
  });
  if (dedupError) {
    if (dedupError.code === "23505") {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    Sentry.captureException(dedupError, {
      tags: { platform: "resend", failure: "dedup_insert_failed" },
    });
    // Fail-open: continue processing; idempotent updates downstream.
  }

  try {
    let outcome: NotificationSendStatus | null = null;
    let detail: string | null = null;
    switch (payload.type) {
      case "email.delivered":
        // Audit-only — overwrite 'sent' with 'sent' (idempotent), no extra fields needed.
        outcome = "sent";
        break;
      case "email.bounced":
        outcome = "bounced";
        detail = payload.data?.bounce?.message ?? payload.data?.bounce?.type ?? "bounced";
        break;
      case "email.complained":
        outcome = "complained";
        detail = payload.data?.complaint?.message ?? "spam complaint";
        break;
      default:
        // Other event types (sent, opened, clicked, etc.) — no-op.
        return NextResponse.json({ ok: true, status: "ignored", type: payload.type });
    }

    const updated = await updateSendOutcomeByMessageId(supabase, {
      resendMessageId: messageId,
      newStatus: outcome,
      error: detail,
    });

    // On bounce/complaint, suppress the recipient so future sends short-circuit.
    if (outcome === "bounced" || outcome === "complained") {
      const recipients = Array.isArray(payload.data?.to)
        ? payload.data!.to
        : payload.data?.to
          ? [payload.data.to]
          : [];
      for (const r of recipients) {
        // Workspace-scoped suppression — pull workspace_id from the
        // notification_sends row by message_id.
        const { data: sendRow } = await supabase
          .from("notification_sends")
          .select("workspace_id")
          .eq("resend_message_id", messageId)
          .maybeSingle();
        const wsId = (sendRow?.workspace_id as string | null) ?? null;
        await suppressRecipient(supabase, {
          workspaceId: wsId,
          recipient: r,
          suppressionType: outcome === "bounced" ? "bounce" : "complaint",
          reason: detail,
          sourceMessageId: messageId,
        });
      }

      // Complaints are an immediate deliverability concern — Sentry alert.
      if (outcome === "complained") {
        Sentry.captureMessage(`[resend-webhook] complaint received for message ${messageId}`, {
          level: "warning",
          tags: { platform: "resend", failure: "complaint" },
          extra: { recipients, detail },
        });
      }
    }

    return NextResponse.json({ ok: true, status: "processed", updated });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { platform: "resend", failure: "processing_error" },
    });
    return NextResponse.json({ ok: true, status: "error_logged" });
  }
}
