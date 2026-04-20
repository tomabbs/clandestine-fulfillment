// Phase 12 — Unified customer-facing email pipeline.
//
// ONE task with two entry points:
//   1. post-label-purchase orchestrator → trigger_status: 'shipped'
//   2. EP webhook tracker.updated      → trigger_status mapped from EP status
//
// Hardening (the "stop unneeded customer complaints" requirements):
//   - Strategy gate: deriveNotificationStrategy must return
//     sendUnifiedResendEmails=true. Otherwise skip + log.
//   - Per-shipment kill switch: warehouse_shipments.suppress_emails
//   - Recipient suppression: resend_suppressions table check
//   - Dedup (3 layers):
//       a) findPriorSuccessfulSend()                    — app check
//       b) notification_sends UNIQUE partial index      — DB check
//       c) EP webhook external_webhook_id dedup         — receiver check
//   - Shadow mode: redirects every send to workspaceFlags.shadow_recipients
//     while still recording the intended real recipient for audit reconciliation.
//   - Always-record: every outcome (sent / failed / suppressed / skipped /
//     shadow) writes a notification_sends row so the daily reconciliation
//     cron can answer "did we send?" by SQL.
//
// On failure: throw → Trigger.dev retries (3 attempts default). Permanent
// failures (4xx from Resend) are recorded as 'failed' and not retried.

import { logger, task } from "@trigger.dev/sdk";
import { sendTrackingEmail } from "@/lib/clients/resend-client";
import {
  findPriorSuccessfulSend,
  isRecipientSuppressed,
  type NotificationTriggerStatus,
  recordSend,
} from "@/lib/server/notification-sends";
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
    | "failed";
  notification_send_id?: string;
  resend_message_id?: string;
  rationale: string;
  error?: string;
}

const PUBLIC_HOST_FALLBACK = "https://app.clandestinedistro.com";

export const sendTrackingEmailTask = task({
  id: "send-tracking-email",
  maxDuration: 30,
  retry: { maxAttempts: 3 },
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

    // ── 2. Strategy gate ─────────────────────────────────────────────────
    const flags = await getWorkspaceFlags(shipment.workspace_id as string);
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
        workspaceId: shipment.workspace_id as string,
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
        workspaceId: shipment.workspace_id as string,
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
        workspaceId: shipment.workspace_id as string,
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
    const sendTo = isShadow
      ? (shadowRecipients[0] ?? null)
      : realRecipient;
    if (isShadow && !sendTo) {
      const skipped = await recordSend(supabase, {
        workspaceId: shipment.workspace_id as string,
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

    // ── 4. Suppression check ─────────────────────────────────────────────
    if (await isRecipientSuppressed(supabase, {
      workspaceId: shipment.workspace_id as string,
      recipient: sendTo!,
    })) {
      const suppressed = await recordSend(supabase, {
        workspaceId: shipment.workspace_id as string,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: sendTo!,
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

    // ── 5. Application-layer dedup gate ──────────────────────────────────
    const prior = await findPriorSuccessfulSend(supabase, {
      shipmentId: shipment_id,
      triggerStatus: trigger_status,
    });
    if (prior) {
      return {
        ok: true,
        decision: "skipped_already_sent",
        notification_send_id: prior.id,
        rationale: `prior ${prior.status} send at ${prior.sent_at}`,
      };
    }

    // ── 6. Build template + send ─────────────────────────────────────────
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

    try {
      const sendResult = await sendTrackingEmail({
        to: sendTo!,
        fromName: orgBranding.org_name,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tag: `tracking_${trigger_status}${isShadow ? "_shadow" : ""}`,
      });

      const stamped = await recordSend(supabase, {
        workspaceId: shipment.workspace_id as string,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: sendTo!,
        status: isShadow ? "shadow" : "sent",
        resendMessageId: sendResult.messageId,
        shadowIntendedRecipient: isShadow ? realRecipient : null,
      });

      return {
        ok: true,
        decision: isShadow ? "shadow" : "sent",
        notification_send_id: stamped.id,
        resend_message_id: sendResult.messageId,
        rationale: strategy.rationale,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stamped = await recordSend(supabase, {
        workspaceId: shipment.workspace_id as string,
        shipmentId: shipment_id,
        triggerStatus: trigger_status,
        templateId: trigger_status,
        recipient: sendTo!,
        status: "failed",
        error: msg,
        shadowIntendedRecipient: isShadow ? realRecipient : null,
      });
      // 4xx from Resend = bad recipient / template; do not retry. Trigger.dev
      // re-throws → retry only if message looks transient.
      if (/^Resend tracking-email send failed: .* \b4\d\d/.test(msg)) {
        return {
          ok: false,
          decision: "failed",
          notification_send_id: stamped.id,
          rationale: strategy.rationale,
          error: msg,
        };
      }
      throw err; // 5xx → retry
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
      channel: inferChannelFromSSMarketplace(
        (data?.marketplace_name as string | null) ?? null,
      ),
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
    support_email:
      (data?.support_email as string | null) ?? "support@clandestinedistro.com",
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
