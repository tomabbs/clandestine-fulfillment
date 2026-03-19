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
    from: "Clandestine Fulfillment Support <support@clandestinedistro.com>",
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
    ? `${params.inviterName} invited you to Clandestine Fulfillment.`
    : "You were invited to Clandestine Fulfillment.";

  const subject = "Your Clandestine Fulfillment portal invite";
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
    "— Clandestine Fulfillment",
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
    from: "Clandestine Fulfillment Support <support@clandestinedistro.com>",
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

export const inboundEmailSchema = z.object({
  from: z.string(),
  to: z.string(),
  subject: z.string().default("(no subject)"),
  text: z.string().default(""),
  message_id: z.string(),
  in_reply_to: z.string().optional(),
});

export type InboundEmail = z.infer<typeof inboundEmailSchema>;

export interface ParsedInboundEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo: string | undefined;
}

export function parseInboundEmail(payload: unknown): ParsedInboundEmail {
  const parsed = inboundEmailSchema.parse(payload);
  return {
    from: parsed.from,
    to: parsed.to,
    subject: parsed.subject,
    body: parsed.text,
    messageId: parsed.message_id,
    inReplyTo: parsed.in_reply_to,
  };
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
