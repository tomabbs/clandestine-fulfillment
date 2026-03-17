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
    from: "Clandestine Fulfillment Support <support@mail.clandestinefulfillment.com>",
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
