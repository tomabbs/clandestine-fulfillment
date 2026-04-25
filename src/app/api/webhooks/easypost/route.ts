// Phase 10.2 / Slice 1 — EasyPost webhook Route Handler.
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
// Slice 1 hardening:
//   - Fail-CLOSED in production when the secret is unset (was warn-and-
//     accept; that defaulted production to "secret exists but unset" =
//     accept everything). Override via EASYPOST_WEBHOOK_REQUIRE_SIGNATURE
//     for incident response only.
//   - Verifier now matches the actual EasyPost contract (v2: x-timestamp +
//     x-path + x-hmac-signature-v2 with `hmac-sha256-hex=` prefix; v1:
//     x-hmac-signature with the same prefix and NFKD-normalized secret).
//   - Dual-secret rotation via EASYPOST_WEBHOOK_SECRET +
//     EASYPOST_WEBHOOK_SECRET_PREVIOUS.
//   - Generic external error response on signature failure (never leak
//     the verifier's `reason` to the caller — those reasons are oracle
//     hints for an attacker probing our format).
//   - Stable dedup id: hash of (timestamp + tracking_code + status) when
//     payload.id is missing, NOT Date.now() (which made retries fresh).
//   - Wire interpretDedupError so transient PostgREST/network errors
//     surface as 503 (platform retries) instead of being swallowed as
//     "duplicate".

import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { tasks } from "@trigger.dev/sdk";
import { type NextRequest, NextResponse } from "next/server";
import { verifyEasypostSignature } from "@/lib/server/easypost-webhook-signature";
import { recordProviderEvent } from "@/lib/server/notification-provider-events";
import { updateShipmentTrackingStatusSafe } from "@/lib/server/notification-status";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { interpretDedupError } from "@/lib/server/webhook-body";
import { env } from "@/lib/shared/env";

// F-2: see client-store/route.ts for rationale; enforced by
// scripts/check-webhook-runtime.sh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_PATH = "/api/webhooks/easypost";

// One-shot Sentry warning per cold start when secret is unset in non-prod.
// Prod fails closed before this matters.
let warnedAboutMissingEpSecretInDev = false;

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
      /** EP-assigned per-event id; Slice 3 uses this as provider_event_id. */
      id?: string;
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
  const {
    EASYPOST_WEBHOOK_SECRET,
    EASYPOST_WEBHOOK_SECRET_PREVIOUS,
    EASYPOST_WEBHOOK_REQUIRE_SIGNATURE,
  } = env();

  const isProduction = process.env.NODE_ENV === "production";
  const requireSignature = EASYPOST_WEBHOOK_REQUIRE_SIGNATURE !== "false" && isProduction;

  const secrets = [EASYPOST_WEBHOOK_SECRET, EASYPOST_WEBHOOK_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );

  if (secrets.length === 0) {
    if (requireSignature) {
      // Fail CLOSED. EP will retry the webhook; operator must provision
      // EASYPOST_WEBHOOK_SECRET to accept events.
      Sentry.captureMessage(
        "[easypost-webhook] EASYPOST_WEBHOOK_SECRET unset in production — failing closed",
        {
          level: "error",
          tags: { platform: "easypost", failure: "secret_unset_in_production" },
        },
      );
      return NextResponse.json({ error: "Webhook misconfigured" }, { status: 500 });
    }
    if (!warnedAboutMissingEpSecretInDev) {
      Sentry.captureMessage(
        "[easypost-webhook] EASYPOST_WEBHOOK_SECRET unset (non-production) — accepting unsigned events",
        {
          level: "info",
          tags: { platform: "easypost", failure: "secret_unset_in_dev" },
        },
      );
      warnedAboutMissingEpSecretInDev = true;
    }
  } else {
    const verify = verifyEasypostSignature({
      rawBody: rawBodyBuffer,
      secrets,
      xTimestamp: req.headers.get("x-timestamp"),
      xPath: req.headers.get("x-path"),
      xHmacSignatureV2: req.headers.get("x-hmac-signature-v2"),
      method: req.method,
      expectedPath: EXPECTED_PATH,
      xHmacSignature: req.headers.get("x-hmac-signature"),
    });
    if (!verify.valid) {
      // Internal Sentry breadcrumb keeps the diagnostic detail. The
      // external response is generic so an attacker probing our format
      // can't distinguish "missing header" from "wrong signature" from
      // "stale timestamp".
      Sentry.captureMessage(`[easypost-webhook] signature verify failed: ${verify.reason}`, {
        level: "warning",
        tags: { platform: "easypost", failure: verify.reason ?? "unknown" },
        extra: { timestamp: verify.timestamp ?? null },
      });
      // Slice 4 — persist a webhook_events row with status='signature_failed'
      // so notification-failure-sensor can roll up per-platform sig-failure
      // rates per hour. The external_webhook_id uses a stable hash of the
      // request bytes so retries from EP collapse on the existing UNIQUE
      // index instead of inflating the rollup. We never persist the raw body
      // — only the dedup id + reason — so this is safe to write outside the
      // post-validation parse path.
      const sigFailureExternalId = `sigfail:${createHash("sha256")
        .update(rawBodyBuffer)
        .digest("hex")
        .slice(0, 32)}`;
      try {
        await createServiceRoleClient()
          .from("webhook_events")
          .insert({
            platform: "easypost",
            external_webhook_id: sigFailureExternalId,
            topic: "signature_failed",
            status: "signature_failed",
            metadata: {
              reason: verify.reason ?? "unknown",
              variant: verify.variant ?? null,
              timestamp_header: req.headers.get("x-timestamp"),
            },
          });
      } catch {
        // never let logging break the response
      }
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (typeof verify.secretIndex === "number" && verify.secretIndex > 0) {
      // Surfaces rotation traffic so the operator can confirm consumers
      // have moved over before retiring the previous secret.
      Sentry.captureMessage("[easypost-webhook] verified with previous (rotation) secret", {
        level: "info",
        tags: {
          platform: "easypost",
          rotation: "previous_secret",
          variant: verify.variant ?? "unknown",
        },
      });
    }
  }

  // Parse AFTER validation — guaranteed identical bytes.
  let payload: EasyPostTrackerEvent;
  try {
    payload = JSON.parse(rawBodyBuffer.toString("utf8")) as EasyPostTrackerEvent;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const tracker = payload?.result;
  const trackingCode = tracker?.tracking_code;
  if (!tracker || !trackingCode) {
    return NextResponse.json({ ok: true, status: "no_tracker_data" });
  }

  // Stable dedup id. EP event ids are stable per delivery attempt; when
  // missing we hash a deterministic projection of the payload (NEVER
  // Date.now() — that made retries look fresh and bypassed dedup).
  const externalId = buildExternalWebhookId(payload, tracker, trackingCode);
  const supabase = createServiceRoleClient();
  const { data: insertedRow, error: dedupError } = await supabase
    .from("webhook_events")
    .insert({
      platform: "easypost",
      external_webhook_id: externalId,
      topic: payload.description ?? "tracker.updated",
      metadata: {
        tracking_code: trackingCode,
        carrier: tracker.carrier ?? null,
        status: (tracker.status ?? "").toLowerCase() || null,
      },
    })
    .select("id")
    .single();
  const dedupResult = interpretDedupError(insertedRow, dedupError);
  if (dedupResult.kind === "duplicate") {
    return NextResponse.json({ ok: true, status: "duplicate" });
  }
  if (dedupResult.kind === "transient" || dedupResult.kind === "unknown") {
    Sentry.captureMessage(`[easypost-webhook] dedup insert failed: ${dedupResult.kind}`, {
      level: dedupResult.kind === "unknown" ? "error" : "warning",
      tags: { platform: "easypost", failure: dedupResult.kind },
      extra: {
        external_webhook_id: externalId,
        sql_state: dedupResult.sqlState ?? null,
        reason: dedupResult.reason,
      },
    });
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  try {
    // Resolve shipment by tracking_number (case-sensitive — EP returns the
    // exact code we registered with).
    const { data: shipment } = await supabase
      .from("warehouse_shipments")
      .select(
        "id, workspace_id, easypost_tracker_id, easypost_tracker_public_url, easypost_tracker_status",
      )
      .eq("tracking_number", trackingCode)
      .maybeSingle();

    // ── Append-only provider-event ledger insert ──────────────────────────
    // Slice 1 contract: BOTH providers feed the same notification_provider_events
    // table so the per-shipment drilldown (Slice 4) can render one time-ordered
    // timeline across email + tracking events. Insert BEFORE the no-shipment
    // early-return so events for unmatched trackers still land in the ledger
    // for forensics. Idempotent on (provider, provider_event_id) so retries
    // collapse cleanly.
    try {
      await recordProviderEvent(supabase, {
        provider: "easypost",
        providerEventId: externalId,
        eventType: payload.description ?? payload.object ?? "tracker.updated",
        workspaceId: shipment?.workspace_id ?? null,
        shipmentId: shipment?.id ?? null,
        occurredAt:
          tracker.tracking_details?.[tracker.tracking_details.length - 1]?.datetime ?? null,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (err) {
      // Ledger write failure is logged but does NOT abort the webhook —
      // we still want the rollup transition to apply. Sentry will surface
      // the regression so we can fix it.
      Sentry.captureException(err, {
        tags: { platform: "easypost", failure: "provider_event_insert" },
      });
    }

    if (!shipment) {
      // EP can deliver events for trackers we don't own (e.g. multi-tenant
      // EP account), or for shipments we deleted. Not fatal.
      return NextResponse.json({ ok: true, status: "no_matching_shipment" });
    }

    // Diff incoming tracking_details against existing rows. Slice 3 prefers
    // the new `provider_event_id` column (EP `tracking_details[].id` when EP
    // exposes it) so retries collapse on the unique partial index. We keep
    // the legacy `(event_time, status)` projection as a fallback for events
    // that do not carry an EP id (older payloads, manually-injected events).
    const details = tracker.tracking_details ?? [];
    if (details.length > 0) {
      const { data: existing } = await supabase
        .from("warehouse_tracking_events")
        .select("event_time, status, provider_event_id")
        .eq("shipment_id", shipment.id)
        .limit(500);
      const seenLegacy = new Set(
        (existing ?? []).map((r) => `${r.event_time ?? ""}::${r.status ?? ""}`),
      );
      const seenProvider = new Set(
        (existing ?? [])
          .map((r) => r.provider_event_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      );

      const inserts: Array<Record<string, unknown>> = [];
      for (const d of details) {
        const status = (d.status ?? "unknown").toLowerCase();
        const providerEventId = buildTrackingDetailProviderEventId(trackingCode, d);
        if (providerEventId && seenProvider.has(providerEventId)) continue;
        const legacyKey = `${d.datetime ?? ""}::${status}`;
        if (seenLegacy.has(legacyKey)) continue;
        seenLegacy.add(legacyKey);
        if (providerEventId) seenProvider.add(providerEventId);
        inserts.push({
          shipment_id: shipment.id,
          workspace_id: shipment.workspace_id,
          status,
          description: d.description ?? d.message ?? null,
          location: buildLocation(d.tracking_location),
          event_time: d.datetime ?? null,
          source: "easypost",
          provider_event_id: providerEventId,
        });
      }
      if (inserts.length > 0) {
        // Best-effort: the unique partial index on provider_event_id makes
        // this idempotent under retry. Insert with `ignoreDuplicates`
        // semantics by upserting on conflict so a Slice 3 retry doesn't
        // raise a 23505 that would surface as 500.
        await supabase
          .from("warehouse_tracking_events")
          .upsert(inserts, { onConflict: "provider_event_id", ignoreDuplicates: true });
      }
    }

    // Update shipment status from latest detail (or top-level status).
    // Slice 3: route the EP-side status through update_shipment_tracking_status_safe
    // so the sticky-terminal state machine is enforced (delivered → in_transit
    // is no longer possible, even on a delayed late-event delivery). The non-
    // status side fields (delivery_date, easypost_tracker_public_url) are
    // updated separately via plain UPDATE because they are not part of the
    // state machine.
    const top = (tracker.status ?? "").toLowerCase();
    const mapped = EP_STATUS_MAP[top];
    const lastDetail = details[details.length - 1] ?? null;
    if (mapped) {
      const verdict = await updateShipmentTrackingStatusSafe(supabase, {
        shipmentId: shipment.id,
        newStatus: mapped,
        statusDetail: lastDetail?.status_detail ?? lastDetail?.description ?? null,
        statusAt: lastDetail?.datetime ?? null,
      });
      if (
        !verdict.applied &&
        verdict.skippedReason &&
        verdict.skippedReason !== "no_op_same_status"
      ) {
        // Sentry visibility for delivered → in_transit attempts and similar
        // — these are the events that pre-Slice-3 used to silently flip
        // tracker.status backwards.
        Sentry.captureMessage(
          `[easypost-webhook] tracking-status state-machine rejected: ${verdict.skippedReason}`,
          {
            level: "info",
            tags: { platform: "easypost", skipped_reason: verdict.skippedReason },
            extra: {
              shipment_id: shipment.id,
              previous_status: verdict.previousStatus,
              attempted_status: mapped,
            },
          },
        );
      }
    }

    // Side-fields (not part of the state machine) — write only when changed.
    const sideUpdate: Record<string, unknown> = {};
    if (mapped === "delivered" && lastDetail?.datetime) {
      sideUpdate.delivery_date = String(lastDetail.datetime).split("T")[0];
    }
    if (tracker.public_url && tracker.public_url !== shipment.easypost_tracker_public_url) {
      sideUpdate.easypost_tracker_public_url = tracker.public_url;
    }
    if (Object.keys(sideUpdate).length > 0) {
      sideUpdate.updated_at = new Date().toISOString();
      await supabase.from("warehouse_shipments").update(sideUpdate).eq("id", shipment.id);
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

/**
 * Derive a stable webhook-event id when EP omits `payload.id`.
 *
 * Pre-Slice-1 fallback was `${trackingCode}:${Date.now()}` — every retry
 * got a new timestamp and looked fresh, defeating dedup. The Slice 1
 * fallback hashes a deterministic projection of the event so retries of
 * the same logical event collide on the unique index.
 */
function buildExternalWebhookId(
  payload: EasyPostTrackerEvent,
  tracker: NonNullable<EasyPostTrackerEvent["result"]>,
  trackingCode: string,
): string {
  if (payload.id) return `easypost:tracker:${payload.id}`;
  const last = (tracker.tracking_details ?? []).at(-1);
  const projection = JSON.stringify({
    code: trackingCode,
    status: (tracker.status ?? "").toLowerCase(),
    detailTs: last?.datetime ?? null,
    detailStatus: (last?.status ?? "").toLowerCase(),
    detailMessage: last?.message ?? last?.description ?? null,
  });
  const digest = createHash("sha256").update(projection).digest("hex").slice(0, 32);
  return `easypost:tracker:fallback:${digest}`;
}

function buildLocation(
  loc?: EasyPostTrackerEvent["result"] extends infer R
    ? R extends { tracking_details?: Array<infer D> }
      ? D extends { tracking_location?: infer L }
        ? L
        : never
      : never
    : never,
): string | null {
  if (!loc || typeof loc !== "object") return null;
  const l = loc as { city?: string; state?: string; country?: string };
  const parts = [l.city, l.state, l.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Slice 3 — derive a stable per-tracking-detail provider_event_id.
 *
 * EP `tracking_details[].id` is stable per-event when present; we hash
 * a deterministic projection when it isn't. The shipping `tracking_code`
 * is included so the same EP "in_transit at 12:00 PM" event for two
 * different shipments doesn't collide on the unique partial index.
 *
 * Returns null when we can't derive ANY stable signal — the caller falls
 * back to the legacy `(event_time, status)` projection in that case.
 */
function buildTrackingDetailProviderEventId(
  trackingCode: string,
  detail: NonNullable<NonNullable<EasyPostTrackerEvent["result"]>["tracking_details"]>[number],
): string | null {
  const epId = (detail as { id?: string }).id;
  if (typeof epId === "string" && epId.length > 0) {
    return `easypost:detail:${epId}`;
  }
  if (!detail.datetime || !detail.status) return null;
  const projection = JSON.stringify({
    code: trackingCode,
    ts: detail.datetime,
    status: (detail.status ?? "").toLowerCase(),
    statusDetail: (detail.status_detail ?? "").toLowerCase(),
    msg: detail.message ?? detail.description ?? null,
  });
  const digest = createHash("sha256").update(projection).digest("hex").slice(0, 32);
  return `easypost:detail:fallback:${digest}`;
}
