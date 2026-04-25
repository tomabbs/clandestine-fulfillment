// Phase 12 / Slice 2 — Unified customer-facing email pipeline.
//
// ONE task with two entry points:
//   1. post-label-purchase orchestrator → trigger_status: 'shipped'
//   2. EP webhook tracker.updated      → trigger_status mapped from EP status
//
// Slice 2 reorders the success path to the DB-first canonical idempotency
// contract. The previous Phase 12 ordering was:
//
//     send-with-Resend → record-send(status='sent')
//
// which leaves a window where: (a) Resend accepts, (b) the task crashes
// before the row is recorded, (c) Trigger.dev retries the task, (d) we send
// again. The crash is rare in practice but inevitable at scale; Resend's
// own idempotency key window is 24h so a 24h-delayed retry circumvents
// even that. The Slice 2 ordering closes the window:
//
//   1. Pre-check (findPriorActiveSend) — skip if any active row already
//      exists for (shipment_id, trigger_status). cancelled / provider_failed
//      rows are intentionally NOT in the active set so operator-driven
//      retries can re-enter the pipeline cleanly.
//   2. Insert `pending` row via recordSend(). The widened partial unique
//      index (Slice 2 migration) on (shipment_id, trigger_status) WHERE
//      status IN active_set traps races at the DB layer; on 23505 the
//      helper returns the winner row instead of throwing.
//   3. Call Resend with `idempotencyKey = tracking-email/{shipment}/{trigger}`
//      (defense-in-depth — Resend collapses re-sends with the same key
//      within 24h).
//   4. Transition status via updateNotificationStatusSafe():
//        - 2xx: pending → sent (stamps sent_at + resend_message_id)
//        - 4xx (validation): pending → provider_failed (TERMINAL — no retry)
//        - 409 (provider idempotency): pending → provider_failed (TERMINAL —
//          our DB has the winner; Resend rejected as duplicate)
//        - 429 / 5xx / network (transient): KEEP pending, bump attempt
//          bookkeeping, throw → Trigger.dev backoff retries on the SAME row.
//
// The other gates (strategy, suppress_emails, recipient suppression, no
// recipient resolved) all short-circuit BEFORE the pending insert and
// record their own terminal status (skipped / suppressed) directly.

import { logger, task } from "@trigger.dev/sdk";
import { ResendSendError, sendTrackingEmail } from "@/lib/clients/resend-client";
import {
  bumpAttemptBookkeeping,
  findPriorActiveSend,
  isRecipientSuppressed,
  type NotificationTriggerStatus,
  recordSend,
} from "@/lib/server/notification-sends";
import { updateNotificationStatusSafe } from "@/lib/server/notification-status";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { env } from "@/lib/shared/env";
import {
  deriveNotificationStrategy,
  inferChannelFromSSMarketplace,
} from "@/lib/shared/notification-strategy";
import { buildPublicTrackUrl } from "@/lib/shared/public-track-token";
import {
  type OrgBranding,
  renderForTrigger,
  type TemplateContext,
} from "@/lib/shared/tracking-email-templates";

interface Payload {
  shipment_id: string;
  trigger_status: NotificationTriggerStatus;
  /** Optional payload extras (e.g. EP exception_message for trigger='exception'). */
  exception_message?: string | null;
  /** Optional event datetime (delivered email uses this). */
  event_date?: string | null;
}

interface TaskResult {
  ok: boolean;
  decision:
    | "sent"
    | "shadow"
    | "skipped_strategy"
    | "skipped_suppress_emails"
    | "skipped_suppressed_recipient"
    | "skipped_already_sent"
    | "skipped_no_recipient"
    | "provider_failed"
    | "failed";
  notification_send_id?: string;
  resend_message_id?: string;
  rationale: string;
  error?: string;
}

const PUBLIC_HOST_FALLBACK = "https://app.clandestinedistro.com";

// Stable idempotency key per logical send. Survives Trigger.dev retries,
// task code redeploys, and Resend's 24h provider window (DB row is canonical
// beyond 24h). MUST be deterministic so concurrent attempts collide on the
// notification_sends_idempotency_key_unique partial unique index.
function buildIdempotencyKey(shipmentId: string, trigger: NotificationTriggerStatus): string {
  return `tracking-email/${shipmentId}/${trigger}`;
}

// Backoff for transient errors (429 / 5xx). Trigger.dev re-runs the task
// on throw; we set next_retry_at to make the operator UI show "retrying in
// X minutes" rather than just "pending forever".
function nextRetryDelayMs(attemptCount: number): number {
  // 1 → 1m, 2 → 2m, 3 → 4m, 4 → 8m, 5+ → 16m
  const minutes = Math.min(16, 2 ** Math.max(0, attemptCount - 1));
  return minutes * 60_000;
}

export const sendTrackingEmailTask = task({
  id: "send-tracking-email",
  maxDuration: 30,
  retry: { maxAttempts: 5 },
  run: async (payload: Payload): Promise<TaskResult> => {
    const supabase = createServiceRoleClient();
    const { shipment_id, trigger_status } = payload;

    // ── 1. Load shipment + minimum joins ─────────────────────────────────
    const { data: shipment, error } = await supabase
      .from("warehouse_shipments")
      .select(
        `id, workspace_id, org_id, public_track_token, suppress_emails,
         tracking_number, carrier, ship_date, shipstation_order_id,
         order_id, mailorder_id, bandcamp_payment_id`,
      )
      .eq("id", shipment_id)
      .maybeSingle();
    if (error || !shipment) {
      logger.warn("[send-tracking-email] shipment not found", { shipment_id, err: error?.message });
      return {
        ok: false,
        decision: "failed",
        rationale: "shipment not found",
        error: error?.message ?? "shipment not found",
      };
    }
    if (!shipment.public_track_token) {
      // Should never happen post-Phase-12-backfill, but defensive.
      logger.warn("[send-tracking-email] shipment missing public_track_token", { shipment_id });
      return {
        ok: false,
        decision: "failed",
        rationale: "shipment missing public_track_token; cannot build tracking URL",
      };
    }

    const workspaceId = shipment.workspace_id as string;

    // ── 2. Strategy gate ─────────────────────────────────────────────────
    const flags = await getWorkspaceFlags(workspaceId);
    const channelInfo = await resolveChannel(supabase, shipment);
    const strategy = deriveNotificationStrategy({
      channel: channelInfo.channel,
      carrier: (shipment.carrier as string | null) ?? null,
      workspaceFlags: {
        email_send_strategy: flags.email_send_strategy,
        bandcamp_skip_ss_email: flags.bandcamp_skip_ss_email,
      },
      shipmentOverrides: {
        suppress_emails: shipment.suppress_emails as boolean | null,
      },
    });

    // Audit row even when we skip — proves the cron checked, not lost.
    if (!strategy.sendUnifiedResendEmails) {
      const skipped = await recordSend(supabase, {
        workspaceId,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: "(none)",
        status: "skipped",
        error: `strategy=${flags.email_send_strategy ?? "off"} → ${strategy.rationale}`,
      });
      return {
        ok: true,
        decision: "skipped_strategy",
        notification_send_id: skipped.id,
        rationale: strategy.rationale,
      };
    }
    if (shipment.suppress_emails) {
      const skipped = await recordSend(supabase, {
        workspaceId,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: "(none)",
        status: "skipped",
        error: "shipment.suppress_emails=true",
      });
      return {
        ok: true,
        decision: "skipped_suppress_emails",
        notification_send_id: skipped.id,
        rationale: "shipment.suppress_emails=true",
      };
    }

    // ── 3. Resolve recipient ─────────────────────────────────────────────
    const realRecipient = await resolveRecipientEmail(supabase, shipment);
    if (!realRecipient) {
      const skipped = await recordSend(supabase, {
        workspaceId,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: "(unresolved)",
        status: "skipped",
        error: "could not resolve customer email for shipment",
      });
      return {
        ok: true,
        decision: "skipped_no_recipient",
        notification_send_id: skipped.id,
        rationale: "no recipient email available",
      };
    }

    // Shadow-mode redirect target.
    const shadowRecipients = (flags.shadow_recipients ?? []) as string[];
    const isShadow = strategy.shadowMode === true;
    const sendTo = isShadow ? (shadowRecipients[0] ?? null) : realRecipient;
    if (isShadow && !sendTo) {
      const skipped = await recordSend(supabase, {
        workspaceId,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: "(no shadow recipient configured)",
        status: "skipped",
        error: "shadow mode but workspaceFlags.shadow_recipients is empty",
        shadowIntendedRecipient: realRecipient,
      });
      return {
        ok: false,
        decision: "skipped_no_recipient",
        notification_send_id: skipped.id,
        rationale: "shadow mode but no shadow_recipients configured",
      };
    }
    if (!sendTo) {
      throw new Error("recipient unexpectedly null after resolution");
    }

    // ── 4. Suppression check ─────────────────────────────────────────────
    if (
      await isRecipientSuppressed(supabase, {
        workspaceId,
        recipient: sendTo,
      })
    ) {
      const suppressed = await recordSend(supabase, {
        workspaceId,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: sendTo,
        status: "suppressed",
        error: "recipient on resend_suppressions list",
        shadowIntendedRecipient: isShadow ? realRecipient : null,
      });
      return {
        ok: true,
        decision: "skipped_suppressed_recipient",
        notification_send_id: suppressed.id,
        rationale: "recipient suppressed",
      };
    }

    // ── 5. Application-layer pre-check (DB-first canonical idempotency) ──
    // findPriorActiveSend covers the WIDE active set so any prior pending /
    // sent / delivered / delayed / bounced / complained / provider_suppressed
    // / shadow row blocks. provider_failed and cancelled are intentionally
    // outside the active set so an operator Retry can re-enter.
    const prior = await findPriorActiveSend(supabase, {
      shipmentId: shipment_id,
      triggerStatus: trigger_status,
    });
    if (prior) {
      return {
        ok: true,
        decision: "skipped_already_sent",
        notification_send_id: prior.id,
        rationale: `prior ${prior.status} send (id=${prior.id}) at ${prior.pending_at ?? prior.sent_at ?? "unknown"}`,
      };
    }

    // ── 6. Build template ────────────────────────────────────────────────
    const orgBranding = await loadOrgBranding(supabase, shipment.org_id as string | null);
    const itemSummary = await loadItemSummary(supabase, shipment, channelInfo);
    const customerName = await loadCustomerName(supabase, shipment);
    const orderNumber = await loadOrderNumber(supabase, shipment);

    const trackingUrl = buildPublicTrackUrl(
      shipment.public_track_token as string,
      env().NEXT_PUBLIC_APP_URL || PUBLIC_HOST_FALLBACK,
    );

    const ctx: TemplateContext = {
      org: orgBranding,
      customer_name: customerName,
      order_number: orderNumber,
      item_summary: itemSummary,
      carrier: (shipment.carrier as string | null) ?? null,
      tracking_number: (shipment.tracking_number as string | null) ?? null,
      tracking_url: trackingUrl,
      event_date: payload.event_date ?? null,
      exception_message: payload.exception_message ?? null,
    };
    const rendered = renderForTrigger(trigger_status, ctx);

    const idempotencyKey = buildIdempotencyKey(shipment_id, trigger_status);

    // ── 7. Insert pending row BEFORE Resend call (DB-first contract) ─────
    // The widened partial unique index traps races: a second concurrent
    // attempt collides on 23505 and recordSend returns the existing winner.
    // shadow mode short-circuits to terminal `shadow` status (mirror of
    // sent) — no provider call, no follow-up transition needed.
    const pendingStatus = isShadow ? "shadow" : "pending";
    const pending = await recordSend(supabase, {
      workspaceId,
      shipmentId: shipment_id,
      triggerStatus: trigger_status,
      templateId: trigger_status,
      recipient: sendTo,
      status: pendingStatus,
      idempotencyKey,
      shadowIntendedRecipient: isShadow ? realRecipient : null,
      attemptCount: 1,
      lastAttemptAt: new Date().toISOString(),
    });

    // If recordSend returned an existing row instead of a freshly inserted
    // one (race recovery), short-circuit to skipped_already_sent — the
    // winner row is the canonical send.
    if (pending.status !== pendingStatus || pending.idempotency_key !== idempotencyKey) {
      return {
        ok: true,
        decision: "skipped_already_sent",
        notification_send_id: pending.id,
        rationale: `race-recovered to existing ${pending.status} row (id=${pending.id})`,
      };
    }

    if (isShadow) {
      // Shadow mode: no real provider call. The pending row above is
      // already in `shadow` terminal state; nothing else to do.
      return {
        ok: true,
        decision: "shadow",
        notification_send_id: pending.id,
        rationale: strategy.rationale,
      };
    }

    // ── 8. Provider call ─────────────────────────────────────────────────
    try {
      const sendResult = await sendTrackingEmail({
        to: sendTo,
        fromName: orgBranding.org_name,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey,
        replyTo: orgBranding.support_email ?? undefined,
        tags: {
          kind: `tracking_${trigger_status}`,
          workspace: workspaceId,
          trigger: trigger_status,
        },
      });

      // ── 9. Transition pending → sent + stamp message id ─────────────────
      await updateNotificationStatusSafe(supabase, {
        notificationSendId: pending.id,
        newStatus: "sent",
        resendMessageId: sendResult.messageId,
      });

      return {
        ok: true,
        decision: "sent",
        notification_send_id: pending.id,
        resend_message_id: sendResult.messageId,
        rationale: strategy.rationale,
      };
    } catch (err) {
      // Classified ResendSendError or generic Error.
      if (err instanceof ResendSendError) {
        if (err.kind === "rate_limited" || err.kind === "transient") {
          // KEEP pending — Trigger.dev will retry on the SAME row (preserving
          // idempotency_key, so Resend collapses re-sends within its 24h
          // window). Bump bookkeeping for ops UI visibility.
          const nextAttempt = (pending.attempt_count ?? 1) + 1;
          await bumpAttemptBookkeeping(supabase, {
            notificationSendId: pending.id,
            attemptCount: nextAttempt,
            lastAttemptAt: new Date().toISOString(),
            nextRetryAt: new Date(Date.now() + nextRetryDelayMs(nextAttempt)).toISOString(),
            error: err.message,
          });
          throw err; // → Trigger.dev exponential backoff
        }
        // 4xx validation OR 409 idempotency: TERMINAL provider_failed,
        // do NOT retry. The plan calls out 409 as final because our DB
        // already has the winner row.
        await updateNotificationStatusSafe(supabase, {
          notificationSendId: pending.id,
          newStatus: "provider_failed",
          error: err.message,
        });
        return {
          ok: false,
          decision: "provider_failed",
          notification_send_id: pending.id,
          rationale: `Resend ${err.kind}: ${err.message}`,
          error: err.message,
        };
      }

      // Unknown / unclassified — treat as transient (retry).
      const msg = err instanceof Error ? err.message : String(err);
      const nextAttempt = (pending.attempt_count ?? 1) + 1;
      await bumpAttemptBookkeeping(supabase, {
        notificationSendId: pending.id,
        attemptCount: nextAttempt,
        lastAttemptAt: new Date().toISOString(),
        nextRetryAt: new Date(Date.now() + nextRetryDelayMs(nextAttempt)).toISOString(),
        error: msg,
      });
      throw err;
    }
  },
});

// ── Per-shipment context helpers ─────────────────────────────────────────

interface ChannelInfo {
  channel: ReturnType<typeof inferChannelFromSSMarketplace>;
}

async function resolveChannel(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: Record<string, unknown>,
): Promise<ChannelInfo> {
  const shipstationOrderId = shipment.shipstation_order_id as string | null;
  if (shipstationOrderId) {
    const { data } = await supabase
      .from("shipstation_orders")
      .select("marketplace_name")
      .eq("id", shipstationOrderId)
      .maybeSingle();
    return {
      channel: inferChannelFromSSMarketplace((data?.marketplace_name as string | null) ?? null),
    };
  }
  if (shipment.mailorder_id) return { channel: "shopify_main" };
  if (shipment.order_id) {
    // warehouse_orders.source tells us which marketplace.
    const { data } = await supabase
      .from("warehouse_orders")
      .select("source")
      .eq("id", shipment.order_id as string)
      .maybeSingle();
    const src = (data?.source as string | null) ?? null;
    if (src === "bandcamp") return { channel: "bandcamp" };
    if (src === "shopify") return { channel: "shopify_client" };
    return { channel: "unknown" };
  }
  return { channel: "manual_ss" };
}

async function loadOrgBranding(
  supabase: ReturnType<typeof createServiceRoleClient>,
  orgId: string | null,
): Promise<OrgBranding> {
  if (!orgId) {
    return {
      org_name: "Clandestine Distribution",
      brand_color: null,
      support_email: "support@clandestinedistro.com",
      logo_url: null,
    };
  }
  const { data } = await supabase
    .from("organizations")
    .select("name, brand_color, support_email, logo_url")
    .eq("id", orgId)
    .maybeSingle();
  return {
    org_name: (data?.name as string | null) ?? "Clandestine Distribution",
    brand_color: (data?.brand_color as string | null) ?? null,
    support_email: (data?.support_email as string | null) ?? "support@clandestinedistro.com",
    logo_url: (data?.logo_url as string | null) ?? null,
  };
}

async function loadCustomerName(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: Record<string, unknown>,
): Promise<string | null> {
  const shipstationOrderId = shipment.shipstation_order_id as string | null;
  if (shipstationOrderId) {
    const { data } = await supabase
      .from("shipstation_orders")
      .select("customer_name")
      .eq("id", shipstationOrderId)
      .maybeSingle();
    return (data?.customer_name as string | null) ?? null;
  }
  const orderId = shipment.order_id as string | null;
  if (orderId) {
    const { data } = await supabase
      .from("warehouse_orders")
      .select("customer_name")
      .eq("id", orderId)
      .maybeSingle();
    return (data?.customer_name as string | null) ?? null;
  }
  const mailorderId = shipment.mailorder_id as string | null;
  if (mailorderId) {
    const { data } = await supabase
      .from("mailorder_orders")
      .select("customer_name")
      .eq("id", mailorderId)
      .maybeSingle();
    return (data?.customer_name as string | null) ?? null;
  }
  return null;
}

async function loadOrderNumber(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: Record<string, unknown>,
): Promise<string> {
  const shipstationOrderId = shipment.shipstation_order_id as string | null;
  if (shipstationOrderId) {
    const { data } = await supabase
      .from("shipstation_orders")
      .select("order_number")
      .eq("id", shipstationOrderId)
      .maybeSingle();
    if (data?.order_number) return data.order_number as string;
  }
  const orderId = shipment.order_id as string | null;
  if (orderId) {
    const { data } = await supabase
      .from("warehouse_orders")
      .select("order_number")
      .eq("id", orderId)
      .maybeSingle();
    if (data?.order_number) return data.order_number as string;
  }
  const mailorderId = shipment.mailorder_id as string | null;
  if (mailorderId) {
    const { data } = await supabase
      .from("mailorder_orders")
      .select("order_number")
      .eq("id", mailorderId)
      .maybeSingle();
    if (data?.order_number) return data.order_number as string;
  }
  return (shipment.id as string).slice(0, 8);
}

async function loadItemSummary(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: Record<string, unknown>,
  _channelInfo: ChannelInfo,
): Promise<string | null> {
  // Best-effort: pick the first item title. Multi-item orders can be summarized
  // as "Album X + 2 more" but that's polish for later.
  const shipstationOrderId = shipment.shipstation_order_id as string | null;
  if (shipstationOrderId) {
    const { data } = await supabase
      .from("shipstation_order_items")
      .select("name")
      .eq("shipstation_order_id", shipstationOrderId)
      .order("item_index", { ascending: true })
      .limit(1)
      .maybeSingle();
    return (data?.name as string | null) ?? null;
  }
  const orderId = shipment.order_id as string | null;
  if (orderId) {
    const { data } = await supabase
      .from("warehouse_order_items")
      .select("title")
      .eq("order_id", orderId)
      .limit(1)
      .maybeSingle();
    return (data?.title as string | null) ?? null;
  }
  return null;
}

async function resolveRecipientEmail(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: Record<string, unknown>,
): Promise<string | null> {
  const shipstationOrderId = shipment.shipstation_order_id as string | null;
  if (shipstationOrderId) {
    const { data } = await supabase
      .from("shipstation_orders")
      .select("customer_email")
      .eq("id", shipstationOrderId)
      .maybeSingle();
    if (data?.customer_email) return data.customer_email as string;
  }
  const orderId = shipment.order_id as string | null;
  if (orderId) {
    const { data } = await supabase
      .from("warehouse_orders")
      .select("customer_email")
      .eq("id", orderId)
      .maybeSingle();
    if (data?.customer_email) return data.customer_email as string;
  }
  const mailorderId = shipment.mailorder_id as string | null;
  if (mailorderId) {
    const { data } = await supabase
      .from("mailorder_orders")
      .select("customer_email")
      .eq("id", mailorderId)
      .maybeSingle();
    if (data?.customer_email) return data.customer_email as string;
  }
  return null;
}
