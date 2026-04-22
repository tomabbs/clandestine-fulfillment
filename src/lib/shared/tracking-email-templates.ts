// Phase 12 — Customer-facing email templates.
//
// Inline HTML builder pattern (matches the existing sendPortalInviteEmail
// in resend-client.ts). Avoids adding React Email as a new dependency.
// All templates produce both `html` and `text` outputs so Resend can fall
// back gracefully on plain-text-only mail clients.
//
// Branding rules:
//   - Org name + brand color from organizations row
//   - Tracking URL is OUR /track/[token] page (always)
//   - Footer always carries the support contact
//   - Plain-text alt is auto-derived for accessibility + spam-score
//
// Customer expectation:
//   - 1 Shipment Confirmation per shipment
//   - 0-1 Out-for-Delivery per shipment (only if carrier emits it)
//   - 1 Delivered per shipment
//   - 0-1 Exception (only on real failure modes)

export interface OrgBranding {
  org_name: string;
  brand_color: string | null;
  support_email: string | null;
  /** Optional logo URL — when absent, header shows org_name as text. */
  logo_url?: string | null;
}

export interface TemplateContext {
  org: OrgBranding;
  customer_name: string | null;
  /** 4-style: "BC-1234567" or SS order# */
  order_number: string;
  /** Primary item title — e.g. "Album X by Band Beta" — for the subject line. */
  item_summary: string | null;
  carrier: string | null;
  tracking_number: string | null;
  /** Absolute URL to /track/[token]. */
  tracking_url: string;
  /** ISO date string when known (delivered template uses this). */
  event_date?: string | null;
  /** Free-text message from EP webhook (exception template uses this). */
  exception_message?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND_COLOR_FALLBACK = "#111827";

function escapeHtml(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/** Common chrome wrapping every template body. */
function shell(opts: { org: OrgBranding; preheader: string; bodyHtml: string }): string {
  const brand = opts.org.brand_color ?? BRAND_COLOR_FALLBACK;
  const support = opts.org.support_email ?? "";
  const supportLine = support
    ? `Questions? Reply to <a href="mailto:${escapeAttr(support)}">${escapeHtml(support)}</a>.`
    : "Questions? Just reply to this email.";
  // Phase 12 follow-up — transactional emails are exempt from CAN-SPAM
  // unsubscribe requirements but it's still best practice + reduces spam
  // complaints. We don't have a per-recipient opt-out flow; for now we
  // direct opt-out requests to support so they can land on the
  // resend_suppressions list manually.
  const optOutAddress = support || "support@clandestinedistro.com";
  const optOutLine = `Don't want shipping updates from us? <a href="mailto:${escapeAttr(optOutAddress)}?subject=Unsubscribe%20from%20shipping%20updates">Email us to opt out</a>.`;
  const logoBlock = opts.org.logo_url
    ? `<img src="${escapeAttr(opts.org.logo_url)}" alt="${escapeAttr(opts.org.org_name)}" style="max-height:40px;max-width:200px;display:block;margin-bottom:8px"/>`
    : `<div style="font-size:18px;font-weight:600;color:${escapeAttr(brand)}">${escapeHtml(opts.org.org_name)}</div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { margin:0; padding:0; background:#f3f4f6; font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:#111827; line-height:1.5; }
  .wrap { max-width:560px; margin:0 auto; padding:24px 16px; }
  .card { background:#ffffff; border-radius:12px; padding:28px 24px; }
  .accent { color:${escapeAttr(brand)}; }
  .btn { display:inline-block; background:${escapeAttr(brand)}; color:#ffffff !important; text-decoration:none; padding:12px 22px; border-radius:8px; font-weight:600; font-size:14px; }
  .small { font-size:12px; color:#6b7280; }
  .preheader { display:none; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; }
  hr { border:none; border-top:1px solid #e5e7eb; margin:18px 0; }
  @media (max-width:480px) { .card { padding:20px 16px; } }
</style></head><body>
  <span class="preheader">${escapeHtml(opts.preheader)}</span>
  <div class="wrap"><div class="card">
    ${logoBlock}
    <hr>
    ${opts.bodyHtml}
    <hr>
    <p class="small">${supportLine}</p>
    <p class="small" style="opacity:0.7">${optOutLine}</p>
    <p class="small">${escapeHtml(opts.org.org_name)}</p>
  </div></div>
</body></html>`;
}

/** Plain-text mirror — same content, no markup. */
function textBlock(opts: { org: OrgBranding; bodyText: string; trackingUrl: string }): string {
  const support = opts.org.support_email
    ? `Questions? Reply to ${opts.org.support_email}.`
    : "Questions? Just reply to this email.";
  const optOut = `Don't want shipping updates? Email ${opts.org.support_email ?? "support@clandestinedistro.com"} to opt out.`;
  return [
    opts.bodyText,
    "",
    `Track your order: ${opts.trackingUrl}`,
    "",
    support,
    optOut,
    opts.org.org_name,
  ].join("\n");
}

// ── Template 1: Shipment Confirmation ─────────────────────────────────────

export function renderShipmentConfirmation(ctx: TemplateContext): RenderedEmail {
  const greeting = ctx.customer_name
    ? `Hi ${escapeHtml(ctx.customer_name.split(" ")[0])}`
    : "Hi there";
  const itemLine = ctx.item_summary
    ? `Your order — <strong>${escapeHtml(ctx.item_summary)}</strong> — is on its way.`
    : "Your order is on its way.";
  const carrierLine =
    ctx.carrier && ctx.tracking_number
      ? `Shipped via ${escapeHtml(ctx.carrier)} · tracking <code>${escapeHtml(ctx.tracking_number)}</code>`
      : ctx.carrier
        ? `Shipped via ${escapeHtml(ctx.carrier)}`
        : "";
  const subject = ctx.item_summary
    ? `Your ${ctx.item_summary} is on the way`
    : `Order ${ctx.order_number} shipped`;
  const html = shell({
    org: ctx.org,
    preheader: `Order ${ctx.order_number} is on the way`,
    bodyHtml: `
      <p style="margin:0 0 8px 0">${greeting},</p>
      <p style="margin:0 0 16px 0">${itemLine}</p>
      ${carrierLine ? `<p style="margin:0 0 18px 0" class="small">${carrierLine}</p>` : ""}
      <p style="margin:0 0 22px 0"><a class="btn" href="${escapeAttr(ctx.tracking_url)}">Track your order</a></p>
      <p class="small">Order ${escapeHtml(ctx.order_number)}</p>
    `,
  });
  const text = textBlock({
    org: ctx.org,
    bodyText: [
      `${ctx.customer_name?.split(" ")[0] ?? "Hi"},`,
      ctx.item_summary
        ? `Your order — ${ctx.item_summary} — is on its way.`
        : "Your order is on its way.",
      ctx.carrier && ctx.tracking_number
        ? `Shipped via ${ctx.carrier} · tracking ${ctx.tracking_number}`
        : "",
      `Order ${ctx.order_number}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    trackingUrl: ctx.tracking_url,
  });
  return { subject, html, text };
}

// ── Template 2: Out for Delivery ──────────────────────────────────────────

export function renderOutForDelivery(ctx: TemplateContext): RenderedEmail {
  const greeting = ctx.customer_name
    ? `Hi ${escapeHtml(ctx.customer_name.split(" ")[0])}`
    : "Hi there";
  const subject = ctx.item_summary
    ? `Out for delivery: ${ctx.item_summary}`
    : `Order ${ctx.order_number} is out for delivery`;
  const html = shell({
    org: ctx.org,
    preheader: "Arriving today",
    bodyHtml: `
      <p style="margin:0 0 8px 0">${greeting},</p>
      <p style="margin:0 0 16px 0">${ctx.item_summary ? `Your <strong>${escapeHtml(ctx.item_summary)}</strong> is` : "Your order is"} <span class="accent"><strong>out for delivery today</strong></span>.</p>
      <p style="margin:0 0 22px 0"><a class="btn" href="${escapeAttr(ctx.tracking_url)}">Track your order</a></p>
      <p class="small">Order ${escapeHtml(ctx.order_number)}</p>
    `,
  });
  const text = textBlock({
    org: ctx.org,
    bodyText: `${ctx.item_summary ? `Your ${ctx.item_summary}` : "Your order"} is out for delivery today.\nOrder ${ctx.order_number}`,
    trackingUrl: ctx.tracking_url,
  });
  return { subject, html, text };
}

// ── Template 3: Delivered ─────────────────────────────────────────────────

export function renderDelivered(ctx: TemplateContext): RenderedEmail {
  const greeting = ctx.customer_name
    ? `Hi ${escapeHtml(ctx.customer_name.split(" ")[0])}`
    : "Hi there";
  const subject = ctx.item_summary
    ? `Delivered: ${ctx.item_summary}`
    : `Order ${ctx.order_number} delivered`;
  const dateLine = ctx.event_date
    ? `Delivered ${new Date(ctx.event_date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}.`
    : "Delivered.";
  const html = shell({
    org: ctx.org,
    preheader: "Delivered",
    bodyHtml: `
      <p style="margin:0 0 8px 0">${greeting},</p>
      <p style="margin:0 0 16px 0"><span class="accent"><strong>${dateLine}</strong></span></p>
      <p style="margin:0 0 16px 0">${ctx.item_summary ? `Your <strong>${escapeHtml(ctx.item_summary)}</strong> has arrived.` : "Your order has arrived."} Hope it's exactly what you wanted.</p>
      <p style="margin:0 0 22px 0"><a class="btn" href="${escapeAttr(ctx.tracking_url)}">View order</a></p>
      <p class="small">Order ${escapeHtml(ctx.order_number)}</p>
    `,
  });
  const text = textBlock({
    org: ctx.org,
    bodyText: `${dateLine}\n${ctx.item_summary ? `Your ${ctx.item_summary} has arrived.` : "Your order has arrived."}\n\nOrder ${ctx.order_number}`,
    trackingUrl: ctx.tracking_url,
  });
  return { subject, html, text };
}

// ── Template 4: Exception ─────────────────────────────────────────────────

export function renderException(ctx: TemplateContext): RenderedEmail {
  const greeting = ctx.customer_name
    ? `Hi ${escapeHtml(ctx.customer_name.split(" ")[0])}`
    : "Hi there";
  const detail = ctx.exception_message
    ? `<p class="small">Carrier message: ${escapeHtml(ctx.exception_message)}</p>`
    : "";
  const subject = `Update on order ${ctx.order_number}`;
  const html = shell({
    org: ctx.org,
    preheader: "Update on your order",
    bodyHtml: `
      <p style="margin:0 0 8px 0">${greeting},</p>
      <p style="margin:0 0 16px 0">We're seeing an issue with delivery for order <strong>${escapeHtml(ctx.order_number)}</strong>${ctx.item_summary ? ` (${escapeHtml(ctx.item_summary)})` : ""}. We're looking into it now.</p>
      ${detail}
      <p style="margin:0 0 22px 0"><a class="btn" href="${escapeAttr(ctx.tracking_url)}">View tracking details</a></p>
      <p class="small">No action needed from you yet — we'll follow up if anything changes.</p>
    `,
  });
  const text = textBlock({
    org: ctx.org,
    bodyText: [
      `${ctx.customer_name?.split(" ")[0] ?? "Hi"},`,
      `We're seeing an issue with delivery for order ${ctx.order_number}${ctx.item_summary ? ` (${ctx.item_summary})` : ""}. We're looking into it now.`,
      ctx.exception_message ? `Carrier message: ${ctx.exception_message}` : "",
      "No action needed from you yet — we'll follow up if anything changes.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    trackingUrl: ctx.tracking_url,
  });
  return { subject, html, text };
}

/**
 * Convenience dispatcher — picks the right template by trigger_status.
 * Used by send-tracking-email so the task doesn't need to switch on status
 * directly.
 */
export function renderForTrigger(
  trigger: "shipped" | "out_for_delivery" | "delivered" | "exception",
  ctx: TemplateContext,
): RenderedEmail {
  switch (trigger) {
    case "shipped":
      return renderShipmentConfirmation(ctx);
    case "out_for_delivery":
      return renderOutForDelivery(ctx);
    case "delivered":
      return renderDelivered(ctx);
    case "exception":
      return renderException(ctx);
  }
}
