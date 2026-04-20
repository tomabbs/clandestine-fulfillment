// Phase 10.2 — EasyPost webhook Route Handler.
//
// Replaces (eventually, see Phase 10.5 sunset) /api/webhooks/aftership.
// During the dual-mode window BOTH AfterShip and EasyPost feed
// warehouse_tracking_events; the parity sensor compares per-shipment
// event counts so we can flip off AfterShip with confidence.
//
// HMAC validation happens against the raw arrayBuffer body — NOT a
// re-stringified parsed body. EP Node SDK issue #467 documents fractional-
// weight precision loss after re-serialization (e.g. 136.0 → 136). We
// always read bytes, validate, THEN parse.
//
// Header support:
//   x-hmac-signature-v2  (preferred — adds timestamp replay protection)
//   x-hmac-signature     (fallback — older webhook configs)
// Production secret REQUIRED; missing-in-prod returns 500 (mirrors SS pattern).
//
// Dedup: webhook_events.external_webhook_id = `easypost:tracker:{event_id}`
// Failure surfaces: Sentry breadcrumbs for invalid sig + replay rejects.

import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import { type NextRequest, NextResponse } from "next/server";
import { verifyEasypostSignature } from "@/lib/server/easypost-webhook-signature";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

export const runtime = "nodejs";

interface EasyPostTrackerEvent {
  id?: string;
  object?: string;
  description?: string;
  result?: {
    id?: string;
    object?: string;
    tracking_code?: string;
    status?: string;
    status_detail?: string;
    carrier?: string;
    public_url?: string;
    tracking_details?: Array<{
      object?: string;
      message?: string;
      description?: string;
      status?: string;
      status_detail?: string;
      datetime?: string;
      source?: string;
      tracking_location?: {
        object?: string;
        city?: string;
        state?: string;
        country?: string;
        zip?: string;
      };
    }>;
    weight?: number; // fractional — the field that historically broke HMAC
  };
}

// Map EP status → our internal warehouse_shipments.status enum, mirroring
// the AfterShip handler so TrackingTimeline keeps working unchanged.
const EP_STATUS_MAP: Record<string, string> = {
  pre_transit: "in_transit",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  available_for_pickup: "out_for_delivery",
  return_to_sender: "exception",
  failure: "delivery_failed",
  cancelled: "exception",
  error: "exception",
  unknown: "in_transit",
};

export async function POST(req: NextRequest) {
  // CRITICAL: read raw bytes BEFORE any text() / json() — EP Node SDK
  // fractional-weight bug requires byte-for-byte HMAC validation.
  const rawBodyBuffer = Buffer.from(await req.arrayBuffer());
  const { EASYPOST_WEBHOOK_SECRET } = env();
  const isProd = process.env.NODE_ENV === "production";

  if (isProd && !EASYPOST_WEBHOOK_SECRET) {
    Sentry.captureMessage(
      "[easypost-webhook] EASYPOST_WEBHOOK_SECRET unset in production",
      {
        level: "error",
        tags: { platform: "easypost", failure: "secret_missing_in_prod" },
      },
    );
    return NextResponse.json({ error: "webhook secret not configured" }, { status: 500 });
  }

  if (EASYPOST_WEBHOOK_SECRET) {
    const v1 = req.headers.get("x-hmac-signature");
    const v2 = req.headers.get("x-hmac-signature-v2");
    const verify = verifyEasypostSignature({
      rawBody: rawBodyBuffer,
      secret: EASYPOST_WEBHOOK_SECRET,
      v1Header: v1,
      v2Header: v2,
    });
    if (!verify.valid) {
      Sentry.captureMessage(
        `[easypost-webhook] signature verify failed: ${verify.reason}`,
        {
          level: "warning",
          tags: { platform: "easypost", failure: verify.reason ?? "unknown" },
          extra: {
            timestamp: verify.timestamp ?? null,
            sigVersion: v2 ? "v2" : v1 ? "v1" : "missing",
          },
        },
      );
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  // Parse AFTER validation — guaranteed identical bytes.
  let payload: EasyPostTrackerEvent;
  try {
    payload = JSON.parse(rawBodyBuffer.toString("utf8")) as EasyPostTrackerEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const tracker = payload?.result;
  const trackingCode = tracker?.tracking_code;
  if (!tracker || !trackingCode) {
    return NextResponse.json({ ok: true, status: "no_tracker_data" });
  }

  // Dedup. EP event ids are stable per delivery attempt.
  const externalId = `easypost:tracker:${payload.id ?? `${trackingCode}:${Date.now()}`}`;
  const supabase = createServiceRoleClient();
  const { error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "easypost",
      external_webhook_id: externalId,
      topic: payload.description ?? "tracker.updated",
      metadata: {
        tracking_code: trackingCode,
        carrier: tracker.carrier ?? null,
      },
    })
    .select("id")
    .single();
  if (dedupError) {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  try {
    // Resolve shipment by tracking_number (case-sensitive — EP returns the
    // exact code we registered with).
    const { data: shipment } = await supabase
      .from("warehouse_shipments")
      .select("id, workspace_id")
      .eq("tracking_number", trackingCode)
      .maybeSingle();
    if (!shipment) {
      // EP can deliver events for trackers we don't own (e.g. multi-tenant
      // EP account), or for shipments we deleted. Not fatal.
      return NextResponse.json({ ok: true, status: "no_matching_shipment" });
    }

    // Diff incoming tracking_details against existing rows by (event_time + status).
    const details = tracker.tracking_details ?? [];
    if (details.length > 0) {
      const { data: existing } = await supabase
        .from("warehouse_tracking_events")
        .select("event_time, status")
        .eq("shipment_id", shipment.id)
        .limit(500);
      const seen = new Set(
        (existing ?? []).map((r) => `${r.event_time ?? ""}::${r.status ?? ""}`),
      );

      const inserts: Array<Record<string, unknown>> = [];
      for (const d of details) {
        const status = (d.status ?? "unknown").toLowerCase();
        const key = `${d.datetime ?? ""}::${status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inserts.push({
          shipment_id: shipment.id,
          workspace_id: shipment.workspace_id,
          status,
          description: d.description ?? d.message ?? null,
          location: buildLocation(d.tracking_location),
          event_time: d.datetime ?? null,
          source: "easypost",
        });
      }
      if (inserts.length > 0) {
        await supabase.from("warehouse_tracking_events").insert(inserts);
      }
    }

    // Update shipment status from latest detail (or top-level status).
    const top = (tracker.status ?? "").toLowerCase();
    const mapped = EP_STATUS_MAP[top];
    if (mapped) {
      const update: Record<string, unknown> = {
        status: mapped,
        updated_at: new Date().toISOString(),
      };
      if (mapped === "delivered") {
        const last = details[details.length - 1];
        const ts = last?.datetime;
        if (ts) {
          update.delivery_date = String(ts).split("T")[0];
        }
      }
      await supabase.from("warehouse_shipments").update(update).eq("id", shipment.id);
    }

    // Phase 12 — trigger customer-facing email when the new status warrants
    // one. send-tracking-email is the unified pipeline; it consults the
    // workspace strategy flag + per-shipment overrides + dedup before
    // actually sending. Safe to wire here even pre-cutover (nothing sends
    // until strategy='shadow' or 'unified_resend'). Map only the customer-
    // facing statuses; transient ones (in_transit, pre_transit) get no email.
    let emailTrigger: "out_for_delivery" | "delivered" | "exception" | null = null;
    if (top === "out_for_delivery") emailTrigger = "out_for_delivery";
    else if (top === "delivered") emailTrigger = "delivered";
    else if (top === "return_to_sender" || top === "failure" || top === "cancelled")
      emailTrigger = "exception";
    if (emailTrigger) {
      try {
        const lastDetail = details[details.length - 1];
        await tasks.trigger("send-tracking-email", {
          shipment_id: shipment.id,
          trigger_status: emailTrigger,
          event_date: lastDetail?.datetime ?? null,
          exception_message:
            emailTrigger === "exception"
              ? (lastDetail?.message ?? lastDetail?.description ?? null)
              : null,
        });
      } catch (err) {
        // Non-fatal — recon cron picks up missed sends within 24h.
        Sentry.captureException(err, {
          tags: { platform: "easypost", failure: "trigger_send_tracking_email" },
        });
      }
    }
  } catch (err) {
    // ALWAYS return 200 from the route — Trigger.dev / EP will retry storms
    // if we 500 here. Log the error for triage.
    Sentry.captureException(err, {
      tags: { platform: "easypost", failure: "processing_error" },
    });
  }

  return NextResponse.json({ ok: true });
}

function buildLocation(loc?: EasyPostTrackerEvent["result"] extends infer R
  ? R extends { tracking_details?: Array<infer D> }
    ? D extends { tracking_location?: infer L }
      ? L
      : never
    : never
  : never): string | null {
  if (!loc || typeof loc !== "object") return null;
  const l = loc as { city?: string; state?: string; country?: string };
  const parts = [l.city, l.state, l.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}
