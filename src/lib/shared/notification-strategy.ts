// Phase 10.4 — Single source of truth for notification ownership.
//
// Every code path that triggers a customer-facing email (SS markasshipped,
// SS v2 fulfillments, mark-platform-fulfilled / mark-mailorder-fulfilled,
// bandcamp-shipping-verify, the eventual send-asendia-cadence-email) MUST
// call this function and obey its result. This eliminates the most
// dangerous bug class: distributed channel-aware logic creating double
// emails or silent-send failures.
//
// Reviewer 4 hardening: pure function, easy to unit-test, consumes ALL
// the inputs that affect the decision (channel, carrier, workspace flags,
// per-shipment overrides) and returns a flat record of "should we do X?"
// booleans + a `rationale` string for sensor-readings audit logging.

export type NotificationChannel =
  | "bandcamp"
  | "shopify_main"
  | "shopify_client"
  | "squarespace"
  | "woocommerce"
  | "manual_ss"
  | "unknown";

export type EmailSendStrategy =
  | "ss_for_all"
  | "hybrid"
  | "resend_for_all";

export interface NotificationStrategy {
  /** SS markasshipped notifyCustomer (v1) / fulfillments notify_customer (v2). */
  callShipstationNotifyCustomer: boolean;
  /** SS notifySalesChannel (v1) / notify_order_source (v2) — drives SS connector
   *  pushing tracking back to BC, Shopify, etc. */
  callShipstationNotifyOrderSource: boolean;
  /** True when we expect the upstream marketplace's own email system to fire
   *  the shipped email (BC, Shopify) — informational, doesn't gate behavior. */
  expectMarketplaceNotify: boolean;
  /** Phase 12.4 — true when we should send Out-For-Delivery / Delivered emails
   *  ourselves via Resend (Asendia gap-fill). */
  sendResendCadence: boolean;
  /** Phase 4.4 — pass to mark-platform-fulfilled `notify_customer` parameter. */
  suppressShopifyEmail: boolean;
  /** Per-shipment escape hatch — wins over channel default. */
  suppressSsEmail: boolean;
  /** Human-readable explanation. Logged to sensor_readings on every decision. */
  rationale: string;
}

export interface NotificationContext {
  channel: NotificationChannel;
  carrier: string | null;
  workspaceFlags: {
    email_send_strategy?: EmailSendStrategy;
    /** Per-channel kill switch. */
    bandcamp_skip_ss_email?: boolean;
  };
  shipmentOverrides?: {
    suppress_ss_email?: boolean | null;
    suppress_shopify_email?: boolean | null;
  };
}

const ASENDIA_CARRIER_PATTERNS = [/asendia/i, /usps_mail_innovation/i, /globalpost/i];

function isAsendiaCarrier(carrier: string | null): boolean {
  if (!carrier) return false;
  return ASENDIA_CARRIER_PATTERNS.some((re) => re.test(carrier));
}

/**
 * Convenience: infer NotificationChannel from a SS marketplace_name string
 * (per `shipstation_orders.marketplace_name`). Defaults to "manual_ss" when
 * empty (SS native order entry) and "unknown" when we don't recognize the
 * marketplace name. Pure + tested — no DB access.
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
    // Heuristic — main vs client is operational. Most "shopify" SS stores
    // for clients map to shopify_client; the main store typically uses a
    // different channel name in practice. Treat ambiguous "shopify" as
    // shopify_client (Shopify owns the email either way).
    return "shopify_client";
  }
  return "unknown";
}

/**
 * Pure decision function. Always returns a fully populated strategy with
 * a rationale string explaining WHY each boolean has its value. Callers
 * MUST log `rationale` to sensor_readings for audit visibility.
 */
export function deriveNotificationStrategy(ctx: NotificationContext): NotificationStrategy {
  const reasons: string[] = [];
  const strategy = ctx.workspaceFlags.email_send_strategy ?? "hybrid";
  const isAsendia = isAsendiaCarrier(ctx.carrier);

  // ── workspace-level kill switches first (highest priority) ───────────────
  if (strategy === "ss_for_all") {
    reasons.push("workspace strategy=ss_for_all → SS owns all confirmations");
    return {
      callShipstationNotifyCustomer: ctx.shipmentOverrides?.suppress_ss_email !== true,
      callShipstationNotifyOrderSource: false, // marketplace will be silent under this strategy
      expectMarketplaceNotify: false,
      sendResendCadence: false,
      suppressShopifyEmail: true,
      suppressSsEmail: ctx.shipmentOverrides?.suppress_ss_email === true,
      rationale: reasons.join("; "),
    };
  }
  if (strategy === "resend_for_all") {
    reasons.push("workspace strategy=resend_for_all → we own all customer emails");
    return {
      callShipstationNotifyCustomer: false,
      callShipstationNotifyOrderSource: false,
      expectMarketplaceNotify: false,
      sendResendCadence: true,
      suppressShopifyEmail: true,
      suppressSsEmail: true,
      rationale: reasons.join("; "),
    };
  }

  // ── hybrid strategy (default) — channel-aware decisions ──────────────────
  let callSsNotifyCustomer = false;
  let callSsNotifyOrderSource = false;
  let expectMarketplaceNotify = false;
  let sendResendCadence = false;
  let suppressShopifyEmail = false;

  switch (ctx.channel) {
    case "bandcamp": {
      reasons.push("channel=bandcamp → BC native via SS connector");
      callSsNotifyOrderSource = true;
      expectMarketplaceNotify = true;
      // Suppress SS confirmation (BC's email is on-brand for the artist).
      // Override via workspace flag if ops needs to test SS for BC.
      const skipSs = ctx.workspaceFlags.bandcamp_skip_ss_email !== false;
      callSsNotifyCustomer = !skipSs;
      reasons.push(skipSs ? "skipping SS confirmation for BC" : "SS confirmation enabled (flag override)");
      break;
    }
    case "shopify_main":
    case "shopify_client": {
      reasons.push(`channel=${ctx.channel} → Shopify native confirmation`);
      // mark-platform-fulfilled passes notify_customer:true to Shopify.
      suppressShopifyEmail = false;
      // Don't ALSO send SS confirmation — that would double-email.
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
      // For SS-ingested orders the "sales channel" is SS itself — we still
      // pass true so SS's connector fires whatever the configured pipeline is.
      callSsNotifyOrderSource = ctx.channel === "manual_ss" ? false : true;
      expectMarketplaceNotify = false;
      break;
    }
  }

  // ── Asendia gap-fill: SS can't pull live events for Asendia, so we send
  //    OOD/Delivered cadence emails ourselves via Resend. Always on for any
  //    channel as long as carrier is Asendia.
  if (isAsendia) {
    sendResendCadence = true;
    reasons.push("carrier is Asendia → Resend cadence enabled (SS can't pull events)");
  }

  // ── per-shipment overrides (final word) ──────────────────────────────────
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
    sendResendCadence,
    suppressShopifyEmail,
    suppressSsEmail,
    rationale: reasons.join("; "),
  };
}
