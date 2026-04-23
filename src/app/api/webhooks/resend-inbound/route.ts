import crypto from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import {
  type FetchedInboundEmail,
  fetchInboundEmail,
  parseInboundWebhook,
} from "@/lib/clients/resend-client";
import { routeInboundEmail } from "@/lib/server/resend-inbound-router";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rule #63: Verify Resend Svix signature before any side effects
function verifySvixSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
): boolean {
  const secret = env().RESEND_INBOUND_WEBHOOK_SECRET;
  // Svix secrets are base64-encoded, prefixed with "whsec_"
  const secretBytes = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac("sha256", secretBytes)
    .update(toSign)
    .digest("base64");

  // Svix signature header may contain multiple signatures: "v1,<sig1> v1,<sig2>"
  const signatures = svixSignature.split(" ");
  for (const sig of signatures) {
    const sigValue = sig.startsWith("v1,") ? sig.slice(3) : sig;
    if (crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(sigValue))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the workspace that should own this inbound email.
 *
 * Single-tenant deployments: just the oldest workspace, deterministic
 * (matches the workspace seeded at install). When we go multi-tenant we'll
 * need to derive workspace from the destination address (envelopeTo).
 *
 * R-7: ORDER BY created_at ASC fixes the prior heap-order bug where the
 * "first" workspace returned by Postgres could vary between calls.
 */
async function resolveWorkspaceId(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    Sentry.captureException(error, {
      tags: { route: "resend-inbound", failure: "workspace_lookup_failed" },
    });
    return null;
  }
  return data?.id ?? null;
}

export async function POST(req: Request): Promise<Response> {
  // Rule #36: always use req.text() for raw body
  const rawBody = await req.text();

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing signature headers" }, { status: 401 });
  }

  // Replay protection: reject webhooks older than 5 minutes
  const timestampSeconds = Number.parseInt(svixTimestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > 300) {
    return NextResponse.json({ error: "Timestamp too old" }, { status: 401 });
  }

  if (!verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  // R-7: deterministic workspace resolution.
  const workspaceId = await resolveWorkspaceId(supabase);
  if (!workspaceId) {
    Sentry.captureMessage("[resend-inbound] no workspace configured", {
      level: "error",
      tags: { route: "resend-inbound", failure: "no_workspace" },
    });
    return NextResponse.json({ error: "No workspace configured" }, { status: 500 });
  }

  // Rule #62: dedup via webhook_events INSERT ON CONFLICT
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { data: dedupRow, error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      workspace_id: workspaceId,
      platform: "resend",
      external_webhook_id: svixId,
      topic: "email.received",
      metadata: parsedBody,
    })
    .select("id")
    .single();

  if (!dedupRow) {
    if (dedupError?.code === "23505") {
      // True duplicate — Resend retried a delivery we already processed.
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    // Any other failure (RLS, schema drift, network hiccup) — DO NOT
    // silently 200. Sentry-capture and 500 so Resend retries. (Bug 9 fix.)
    Sentry.captureException(dedupError ?? new Error("webhook_events insert returned no row"), {
      tags: { route: "resend-inbound", failure: "dedup_insert_failed" },
    });
    return NextResponse.json({ error: "dedup insert failed" }, { status: 500 });
  }

  // R-1: parse the Resend webhook envelope (NOT the email body — that
  // requires a separate API call, see R-2 below).
  let envelope: ReturnType<typeof parseInboundWebhook>;
  try {
    envelope = parseInboundWebhook(parsedBody);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "resend-inbound", failure: "envelope_parse_failed" },
      extra: { rawBodyPreview: rawBody.slice(0, 500) },
    });
    await supabase
      .from("webhook_events")
      .update({ status: "envelope_parse_failed" })
      .eq("id", dedupRow.id);
    // 200 so Resend stops retrying — the row is in the DB for forensics
    // and the replay job (scripts/_replay-resend-inbound.ts) can re-run
    // once the schema is fixed.
    return NextResponse.json({ ok: true, status: "envelope_parse_failed" });
  }

  // Resend only sends `email.received` for inbound; bail safely on anything
  // else (the OUTBOUND delivery-status events go to /api/webhooks/resend).
  if (envelope.type !== "email.received") {
    await supabase
      .from("webhook_events")
      .update({ status: "ignored_event_type" })
      .eq("id", dedupRow.id);
    return NextResponse.json({ ok: true, status: "ignored_event_type", type: envelope.type });
  }

  // R-2: fetch the full email content (body + headers + recovered real
  // sender) via the Resend Receiving API. The webhook envelope alone has
  // none of these.
  let email: FetchedInboundEmail;
  try {
    email = await fetchInboundEmail(envelope.emailId);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "resend-inbound", failure: "fetch_body_failed" },
      extra: { emailId: envelope.emailId },
    });
    await supabase
      .from("webhook_events")
      .update({ status: "fetch_body_failed" })
      .eq("id", dedupRow.id);
    // 500 so Resend retries — the body fetch is transient (Resend API
    // outage, 429, etc.) and the email_id is stable.
    return NextResponse.json({ error: "fetch body failed" }, { status: 500 });
  }

  try {
    const result = await routeInboundEmail({
      supabase,
      workspaceId,
      webhookEventId: dedupRow.id,
      email,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: "resend-inbound", failure: "routing_error" },
      extra: { emailId: envelope.emailId, realFrom: email.realFrom },
    });
    await supabase.from("webhook_events").update({ status: "routing_error" }).eq("id", dedupRow.id);
    // 200 — the row is captured, replay job can re-fire after the bug fix.
    return NextResponse.json({ ok: true, status: "routing_error" });
  }
}
