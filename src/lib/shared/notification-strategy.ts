// Phase 12 — Single source of truth for notification ownership.
//
// Every code path that triggers a customer-facing email (SS markasshipped,
// SS v2 fulfillments, mark-platform-fulfilled, mark-mailorder-fulfilled,
// send-tracking-email) MUST consult this function and obey its result.
// Eliminates the most dangerous bug class in this domain: distributed
// channel-aware logic creating double-emails or silent-send failures.
//
// Phase 12 collapsed the Phase 10 13-row hybrid matrix into 4 clean modes:
//
//   off              : nothing fires. Pre-cutover default. SS still emails,
//                      but ONLY because SS's own settings independently say so;
//                      this fn returns suppress_ss=false so the writeback task
//                      stays at notify_customer=true. Use to revert.
//
//   shadow           : unified pipeline runs but every send is REDIRECTED to
//                      shadow_recipients (ops/staff). Real customers receive
//                      nothing from us; SS continues emailing them as in 'off'.
//                      Used during the soft-launch parallel-run window.
//
//   unified_resend   : WE own all customer shipping emails (Resend). SS
//                      stops emailing customers (notify_customer=false).
//                      BC's connector still fires (notifyOrderSource=true)
//                      so BC marks the order shipped on its dashboard;
//                      that triggers BC's own native receipt email — that's
//                      the "one redundant store-platform email" we accept
//                      per the Phase 12 design call.
//
//   ss_for_all       : legacy fallback — SS owns all customer emails.
//                      Suppresses the unified pipeline entirely. Same
//                      behavior as pre-Phase-12. Available as an emergency
//                      reverse if the unified pipeline misbehaves.
//
// Reviewer 4 hardening (still applies): pure function, no DB / env access,
// rationale string output for audit logging.

export type NotificationChannel =
  | "bandcamp"
  | "shopify_main"
  | "shopify_client"
  | "squarespace"
  | "woocommerce"
  | "manual_ss"
  | "unknown";

/**
 * Phase 12 — workspace-level mode flag.
 *   - 'off' is the safe default; nothing changes.
 *   - 'shadow' is the parallel-run mode for soft-launch.
 *   - 'unified_resend' is the production target.
 *   - 'ss_for_all' is the legacy / emergency-reverse mode.
 */
export type EmailSendStrategy =
  | "off"
  | "shadow"
  | "unified_resend"
  | "ss_for_all";

export interface NotificationStrategy {
  /** SS markasshipped notifyCustomer (v1) / fulfillments notify_customer (v2). */
  callShipstationNotifyCustomer: boolean;
  /** SS notifySalesChannel (v1) / notify_order_source (v2) — drives SS connector
   *  pushing tracking back to BC dashboards, Shopify orders, etc. */
  callShipstationNotifyOrderSource: boolean;
  /** True when the upstream marketplace's own email system fires the shipped
   *  email (BC, Shopify). Informational; doesn't gate behavior. */
  expectMarketplaceNotify: boolean;
  /** Phase 12 — true when send-tracking-email should fire (real or shadow). */
  sendUnifiedResendEmails: boolean;
  /** Phase 12 — true when the unified pipeline should redirect to ops
   *  allowlist instead of real customer (shadow mode). */
  shadowMode: boolean;
  /** mark-platform-fulfilled `notify_customer` parameter for Shopify. */
  suppressShopifyEmail: boolean;
  /** Per-shipment escape hatch. Wins over channel default. */
  suppressSsEmail: boolean;
  /** Human-readable explanation. Logged to sensor_readings on every decision. */
  rationale: string;
}

export interface NotificationContext {
  channel: NotificationChannel;
  carrier: string | null;
  workspaceFlags: {
    email_send_strategy?: EmailSendStrategy;
    /** Phase 10.4 carry-forward — only consulted when strategy is unrelated to
     *  unified mode. In unified_resend mode BC ALWAYS emails (its own native flow)
     *  and SS NEVER emails customers, so this flag is moot. Kept for legacy. */
    bandcamp_skip_ss_email?: boolean;
  };
  shipmentOverrides?: {
    suppress_ss_email?: boolean | null;
    suppress_shopify_email?: boolean | null;
    suppress_emails?: boolean | null;
  };
}

const ASENDIA_CARRIER_PATTERNS = [/asendia/i, /usps_mail_innovation/i, /globalpost/i];

function isAsendiaCarrier(carrier: string | null): boolean {
  if (!carrier) return false;
  return ASENDIA_CARRIER_PATTERNS.some((re) => re.test(carrier));
}

/**
 * Phase 12 helper — infer NotificationChannel from a SS marketplace_name string
 * (per `shipstation_orders.marketplace_name`). Defaults to "manual_ss" when
 * empty (SS native order entry) and "unknown" when unfamiliar marketplace.
 * Pure + tested — no DB access.
 */
export function inferChannelFromSSMarketplace(
  marketplaceName: string | null,
): NotificationChannel {
  if (!marketplaceName || marketplaceName.trim() === "") return "manual_ss";
  const m = marketplaceName.toLowerCase();
  if (m.includes("bandcamp")) return "bandcamp";
  if (m.includes("squarespace")) return "squarespace";
  if (m.includes("woocommerce")) return "woocommerce";
  if (m.includes("shopify")) {
    return "shopify_client";
  }
  return "unknown";
}

/**
 * Phase 12 — Pure decision function. Always returns a fully populated
 * strategy with a `rationale` string. Callers MUST log `rationale` to
 * sensor_readings for audit visibility.
 */
export function deriveNotificationStrategy(ctx: NotificationContext): NotificationStrategy {
  const reasons: string[] = [];
  const strategy = ctx.workspaceFlags.email_send_strategy ?? "off";
  const isAsendia = isAsendiaCarrier(ctx.carrier);

  // Per-shipment hard kill switch — wins over everything else.
  if (ctx.shipmentOverrides?.suppress_emails === true) {
    return {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: false,
      expectMarketplaceNotify: false,
      sendUnifiedResendEmails: false,
      shadowMode: false,
      suppressShopifyEmail: true,
      suppressSsEmail: true,
      rationale: "shipment.suppress_emails=true → all channels suppressed",
    };
  }

  switch (strategy) {
    case "off":
      // Pre-Phase-12 behavior preserved exactly. SS still emails per channel
      // matrix; we don't fire the unified pipeline.
      return offModeStrategy(ctx, reasons);
    case "shadow":
      reasons.push("workspace strategy=shadow → unified pipeline runs to ops allowlist; SS continues emailing customers");
      return {
        callShipstationNotifyCustomer: shouldSsKeepEmailingForChannel(ctx),
        callShipstationNotifyOrderSource: shouldSsKeepNotifyOrderSource(ctx),
        expectMarketplaceNotify: ctx.channel === "bandcamp" || ctx.channel === "shopify_main" || ctx.channel === "shopify_client",
        sendUnifiedResendEmails: true,
        shadowMode: true,
        suppressShopifyEmail: false,
        suppressSsEmail: ctx.shipmentOverrides?.suppress_ss_email === true,
        rationale: reasons.join("; "),
      };
    case "unified_resend":
      reasons.push("workspace strategy=unified_resend → WE own all customer shipping emails via Resend");
      if (isAsendia) reasons.push("carrier is Asendia (no auto-cadence elsewhere; we cover it natively)");
      return {
        // SS stops emailing customers in unified mode. Period.
        callShipstationNotifyCustomer: false,
        // KEEP notifyOrderSource=true so BC connector continues pushing
        // ship_date back to BC dashboards (and BC's native email fires —
        // the accepted "one redundant store-platform email"). Same for
        // Shopify-via-SS workflows.
        callShipstationNotifyOrderSource: true,
        expectMarketplaceNotify: ctx.channel === "bandcamp" || ctx.channel === "shopify_main" || ctx.channel === "shopify_client",
        sendUnifiedResendEmails: true,
        shadowMode: false,
        // mark-platform-fulfilled (Shopify) keeps notify_customer=true so
        // Shopify also fires its native email. Customer gets Shopify's +
        // ours. Acceptable per Phase 12 design call.
        suppressShopifyEmail: false,
        suppressSsEmail: ctx.shipmentOverrides?.suppress_ss_email === true,
        rationale: reasons.join("; "),
      };
    case "ss_for_all":
      reasons.push("workspace strategy=ss_for_all → SS owns all customer emails (legacy fallback)");
      return {
        callShipstationNotifyCustomer: ctx.shipmentOverrides?.suppress_ss_email !== true,
        callShipstationNotifyOrderSource: false,
        expectMarketplaceNotify: false,
        sendUnifiedResendEmails: false,
        shadowMode: false,
        suppressShopifyEmail: true,
        suppressSsEmail: ctx.shipmentOverrides?.suppress_ss_email === true,
        rationale: reasons.join("; "),
      };
    default:
      // Unknown strategy → fail closed. Don't email anyone.
      return {
        callShipstationNotifyCustomer: false,
        callShipstationNotifyOrderSource: false,
        expectMarketplaceNotify: false,
        sendUnifiedResendEmails: false,
        shadowMode: false,
        suppressShopifyEmail: true,
        suppressSsEmail: true,
        rationale: `unknown strategy '${strategy}' → fail-closed (no emails)`,
      };
  }
}

/**
 * Off-mode preserves the exact pre-Phase-12 hybrid matrix behavior. Used as
 * the safe default + the rollback target. Channel-aware, picks one source.
 */
function offModeStrategy(ctx: NotificationContext, reasons: string[]): NotificationStrategy {
  reasons.push("workspace strategy=off (legacy hybrid) → channel-aware decisions");
  let callSsNotifyCustomer = false;
  let callSsNotifyOrderSource = false;
  let expectMarketplaceNotify = false;
  let suppressShopifyEmail = false;

  switch (ctx.channel) {
    case "bandcamp": {
      reasons.push("channel=bandcamp → BC native via SS connector");
      callSsNotifyOrderSource = true;
      expectMarketplaceNotify = true;
      const skipSs = ctx.workspaceFlags.bandcamp_skip_ss_email !== false;
      callSsNotifyCustomer = !skipSs;
      reasons.push(skipSs ? "skipping SS confirmation for BC" : "SS confirmation enabled (flag override)");
      break;
    }
    case "shopify_main":
    case "shopify_client": {
      reasons.push(`channel=${ctx.channel} → Shopify native confirmation`);
      suppressShopifyEmail = false;
      callSsNotifyCustomer = false;
      callSsNotifyOrderSource = false;
      expectMarketplaceNotify = true;
      break;
    }
    case "squarespace":
    case "woocommerce":
    case "manual_ss":
    case "unknown": {
      reasons.push(`channel=${ctx.channel} → SS native confirmation`);
      callSsNotifyCustomer = true;
      callSsNotifyOrderSource = ctx.channel !== "manual_ss";
      expectMarketplaceNotify = false;
      break;
    }
  }
  const suppressSsEmail = ctx.shipmentOverrides?.suppress_ss_email === true;
  if (suppressSsEmail) {
    callSsNotifyCustomer = false;
    reasons.push("suppress_ss_email override on shipment row");
  }
  if (ctx.shipmentOverrides?.suppress_shopify_email === true) {
    suppressShopifyEmail = true;
    reasons.push("suppress_shopify_email override on shipment row");
  }
  return {
    callShipstationNotifyCustomer: callSsNotifyCustomer,
    callShipstationNotifyOrderSource: callSsNotifyOrderSource,
    expectMarketplaceNotify,
    sendUnifiedResendEmails: false,
    shadowMode: false,
    suppressShopifyEmail,
    suppressSsEmail,
    rationale: reasons.join("; "),
  };
}

// In shadow mode SS continues emailing customers exactly as in off mode,
// because we explicitly DON'T disrupt the live customer flow during the
// parallel-run window. Reuses off-mode channel logic.
function shouldSsKeepEmailingForChannel(ctx: NotificationContext): boolean {
  // In shadow mode, default to "what off mode would do."
  return offModeStrategy(ctx, []).callShipstationNotifyCustomer;
}
function shouldSsKeepNotifyOrderSource(ctx: NotificationContext): boolean {
  return offModeStrategy(ctx, []).callShipstationNotifyOrderSource;
}
