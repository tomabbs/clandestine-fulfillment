import { Resend } from "resend";
import { z } from "zod";
import { env } from "@/lib/shared/env";

let _resend: Resend | null = null;

function getResendClient(): Resend {
  if (_resend) return _resend;
  _resend = new Resend(env().RESEND_API_KEY);
  return _resend;
}

export async function sendSupportEmail(
  to: string,
  subject: string,
  body: string,
  replyToMessageId?: string,
): Promise<{ messageId: string }> {
  const resend = getResendClient();

  const headers: Record<string, string> = {};
  if (replyToMessageId) {
    headers["In-Reply-To"] = replyToMessageId;
    headers.References = replyToMessageId;
  }

  const { data, error } = await resend.emails.send({
    from: "Clandestine Distribution Support <support@clandestinedistro.com>",
    to,
    subject,
    text: body,
    headers,
  });

  if (error || !data) {
    throw new Error(`Failed to send email: ${error?.message ?? "unknown error"}`);
  }

  return { messageId: data.id };
}

export async function sendPortalInviteEmail(params: {
  to: string;
  inviteLink: string;
  inviteeName?: string;
  inviterName?: string | null;
}): Promise<{ messageId: string }> {
  const resend = getResendClient();
  const inviteeName = params.inviteeName?.trim() || "there";
  const inviterLine = params.inviterName?.trim()
    ? `${params.inviterName} invited you to Clandestine Distribution.`
    : "You were invited to Clandestine Distribution.";

  const subject = "Your Clandestine Distribution portal invite";
  const text = [
    `Hi ${inviteeName},`,
    "",
    inviterLine,
    "",
    "Use this secure link to finish sign in:",
    params.inviteLink,
    "",
    "If you were not expecting this invite, you can safely ignore this email.",
    "",
    "— Clandestine Distribution",
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
      <p>Hi ${escapeHtml(inviteeName)},</p>
      <p>${escapeHtml(inviterLine)}</p>
      <p>
        <a href="${escapeAttribute(params.inviteLink)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px">
          Open Portal Invite
        </a>
      </p>
      <p style="font-size:12px;color:#6b7280">
        If the button does not work, copy and paste this link:<br/>
        <a href="${escapeAttribute(params.inviteLink)}">${escapeHtml(params.inviteLink)}</a>
      </p>
      <p style="font-size:12px;color:#6b7280">If you were not expecting this invite, you can ignore this email.</p>
    </div>
  `;

  const { data, error } = await resend.emails.send({
    from: "Clandestine Distribution Support <support@clandestinedistro.com>",
    to: params.to,
    subject,
    text,
    html,
  });

  if (error || !data) {
    throw new Error(`Failed to send invite email: ${error?.message ?? "unknown error"}`);
  }

  return { messageId: data.id };
}

// Phase 12 — Customer-facing tracking email send.
// Uses our shipping sender domain. Returns the Resend message id on success.
export async function sendTrackingEmail(input: {
  to: string;
  fromName: string;
  subject: string;
  html: string;
  text: string;
  /** Tag for Resend dashboard search. */
  tag?: string;
}): Promise<{ messageId: string }> {
  const resend = getResendClient();
  const fromAddress = `${input.fromName} <shipping@clandestinedistro.com>`;
  const { data, error } = await resend.emails.send({
    from: fromAddress,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    tags: input.tag ? [{ name: "kind", value: input.tag }] : undefined,
  });
  if (error || !data) {
    throw new Error(`Resend tracking-email send failed: ${error?.message ?? "unknown"}`);
  }
  return { messageId: data.id };
}

// Resend `email.received` webhook event payload (verified against
// https://resend.com/docs/webhooks/emails/received and against real
// payloads in webhook_events.metadata).
//
// CRITICAL: Resend webhooks ONLY include envelope metadata. The body, HTML,
// headers, and attachments are NOT in the webhook — they must be fetched
// separately via `resend.emails.receiving.get(email_id)`. See
// `fetchInboundEmail()` below.
export const inboundEmailWebhookSchema = z.object({
  type: z.string(),
  data: z.object({
    email_id: z.string(),
    from: z.string(),
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    bcc: z.array(z.string()).default([]),
    subject: z.string().default("(no subject)"),
    message_id: z.string().default(""),
    created_at: z.string().optional(),
    attachments: z.array(z.unknown()).default([]),
  }),
});

export type InboundEmailWebhook = z.infer<typeof inboundEmailWebhookSchema>;

export interface ParsedInboundWebhook {
  type: string;
  emailId: string;
  envelopeFrom: string;
  envelopeTo: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId: string;
}

/**
 * Parse a Resend `email.received` webhook envelope. Throws Zod errors on
 * shape mismatches — callers MUST wrap in try/catch and report failures to
 * Sentry so we never silently 500 on a payload-shape change.
 */
export function parseInboundWebhook(payload: unknown): ParsedInboundWebhook {
  const parsed = inboundEmailWebhookSchema.parse(payload);
  return {
    type: parsed.type,
    emailId: parsed.data.email_id,
    envelopeFrom: parsed.data.from,
    envelopeTo: parsed.data.to,
    cc: parsed.data.cc,
    bcc: parsed.data.bcc,
    subject: parsed.data.subject,
    messageId: parsed.data.message_id,
  };
}

export interface FetchedInboundEmail {
  emailId: string;
  envelopeFrom: string;
  envelopeTo: string[];
  /**
   * The recovered "real" sender — taken from common forwarder-preserving
   * headers in priority order: `X-Original-From` > `Reply-To` >
   * `Return-Path` > `From` > envelope `from`. This survives the typical
   * Gmail/Workspace forward where envelope `from` is rewritten to the
   * forwarding address.
   */
  realFrom: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string | null;
  messageId: string;
  inReplyTo: string | undefined;
  references: string[];
  headers: Record<string, string>;
}

/**
 * Fetch the full email content (body + headers) for a Resend inbound event.
 * The webhook payload only contains envelope metadata, so the route handler
 * MUST call this before any classification or storage logic.
 */
export async function fetchInboundEmail(emailId: string): Promise<FetchedInboundEmail> {
  const resend = getResendClient();
  const { data, error } = await resend.emails.receiving.get(emailId);
  if (error || !data) {
    throw new Error(
      `Failed to fetch inbound email ${emailId}: ${error?.message ?? "unknown error"}`,
    );
  }

  // Headers come back with original casing — normalize to lowercase keys for
  // case-insensitive lookup. Keep the raw value (string OR parsed object) so
  // `pickRealFrom` can dig into structured header shapes.
  const headersRaw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data.headers ?? {})) {
    headersRaw[key.toLowerCase()] = value;
  }
  // Public surface stays string-only for backward compatibility.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersRaw)) {
    if (typeof value === "string") headers[key] = value;
  }

  const realFrom = pickRealFrom({ envelopeFrom: data.from, headers: headersRaw });

  const refsHeader = headers.references ?? "";
  const references = refsHeader
    ? refsHeader
        .split(/\s+/)
        .map((v) => v.trim())
        .filter(Boolean)
    : [];

  return {
    emailId: data.id,
    envelopeFrom: data.from,
    envelopeTo: data.to,
    realFrom,
    to: data.to,
    cc: data.cc ?? [],
    subject: data.subject,
    text: data.text ?? "",
    html: data.html,
    messageId: data.message_id ?? headers["message-id"] ?? "",
    inReplyTo: headers["in-reply-to"] || undefined,
    references,
    headers,
  };
}

/**
 * Recover the original sender after intermediate forwarding. Most operator
 * setups forward from a Workspace/Gmail mailbox into Resend Inbound, which
 * rewrites envelope `from` to the forwarding mailbox. The original sender
 * survives in one of these headers (priority order: Gmail, Google Workspace,
 * Microsoft 365, manual MX setups).
 *
 * IMPORTANT: do NOT include `x-forwarded-for` here — in email semantics that
 * header lists the recipient forwarding chain (e.g. `fulfillment@... tom@...,
 * catie@..., orders@...`), NOT the sender. Picking it produces a multi-address
 * blob that collapses every unmatched email into the same `group_key` and
 * silently dedups them down to a single review-queue row.
 *
 * Resend's `emails.receiving.get()` returns most headers as strings but a few
 * (`return-path`, sometimes `from`/`reply-to`) come back as parsed objects with
 * `{ value: [{ address, name }] }` shape — `headerValueToString` handles both.
 */
function pickRealFrom({
  envelopeFrom,
  headers,
}: {
  envelopeFrom: string;
  headers: Record<string, unknown>;
}): string {
  const candidates = [
    headers["x-original-from"],
    headers["x-original-sender"],
    headers["x-google-original-from"],
    headers.from,
    headers["reply-to"],
    headers.sender,
    envelopeFrom,
  ];
  for (const raw of candidates) {
    const value = headerValueToString(raw).trim();
    if (value) return value;
  }
  return envelopeFrom;
}

/**
 * Resend returns header values as either:
 *  - a plain string ("AmericanBubbleBoy" <hello@americanbubbleboy.com>)
 *  - a structured object ({ value: [{ address, name }], html, text })
 *  - an array of either of the above
 *
 * Normalize to a single human-readable string.
 */
function headerValueToString(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = headerValueToString(item);
      if (s) return s;
    }
    return "";
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const valueField = obj.value;
    if (Array.isArray(valueField) && valueField.length > 0) {
      const first = valueField[0] as Record<string, unknown> | null;
      if (first && typeof first === "object") {
        const address = typeof first.address === "string" ? first.address : "";
        const name = typeof first.name === "string" ? first.name : "";
        if (name && address) return `"${name}" <${address}>`;
        if (address) return address;
      }
    }
    const text = obj.text;
    if (typeof text === "string" && text) return text;
    const html = obj.html;
    if (typeof html === "string" && html) return html;
  }
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
