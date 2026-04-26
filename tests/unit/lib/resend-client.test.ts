import { describe, expect, it } from "vitest";
import {
  inboundEmailWebhookSchema,
  parseInboundWebhook,
  ResendSendError,
  sanitizeTagValue,
} from "@/lib/clients/resend-client";

describe("parseInboundWebhook", () => {
  // Verbatim payload from https://resend.com/docs/webhooks/emails/received
  // (R-10 — would have caught the original to-as-array bug instantly).
  const docsExample = {
    type: "email.received",
    created_at: "2026-02-22T23:41:12.126Z",
    data: {
      email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      created_at: "2026-02-22T23:41:11.894719+00:00",
      from: "Acme <onboarding@resend.dev>",
      to: ["delivered@resend.dev"],
      bcc: [],
      cc: [],
      message_id: "<example+123>",
      subject: "Sending this example",
      attachments: [
        {
          id: "2a0c9ce0-3112-4728-976e-47ddcd16a318",
          filename: "avatar.png",
          content_type: "image/png",
          content_disposition: "inline",
          content_id: "img001",
        },
      ],
    },
  };

  it("parses Resend's documented email.received envelope", () => {
    const parsed = parseInboundWebhook(docsExample);
    expect(parsed).toEqual({
      type: "email.received",
      emailId: "56761188-7520-42d8-8898-ff6fc54ce618",
      envelopeFrom: "Acme <onboarding@resend.dev>",
      envelopeTo: ["delivered@resend.dev"],
      cc: [],
      bcc: [],
      subject: "Sending this example",
      messageId: "<example+123>",
    });
  });

  it("parses a real production webhook envelope (Bandcamp order forwarded)", () => {
    // Captured from webhook_events.metadata in production — proves the
    // schema accepts what Resend actually sends through Workspace forwarding.
    const realPayload = {
      type: "email.received",
      created_at: "2026-04-22T21:41:33.000Z",
      data: {
        cc: [],
        to: ["orders@clandestinedistro.com"],
        bcc: [],
        from: "orders@clandestinedistro.com",
        subject: "Bam! Another order for True Panther",
        email_id: "6f491b0c-4dd5-4bb6-a69e-fb8d8d11cc7b",
        created_at: "2026-04-22T21:41:37.050Z",
        message_id: "<bzw2Wwz6TRywAGaofa6SpQ@geopod-ismtpd-20>",
        attachments: [],
      },
    };
    const parsed = parseInboundWebhook(realPayload);
    expect(parsed.type).toBe("email.received");
    expect(parsed.emailId).toBe("6f491b0c-4dd5-4bb6-a69e-fb8d8d11cc7b");
    expect(parsed.envelopeTo).toEqual(["orders@clandestinedistro.com"]);
    expect(parsed.subject).toBe("Bam! Another order for True Panther");
  });

  it("defaults missing optional arrays/strings", () => {
    const minimal = {
      type: "email.received",
      data: {
        email_id: "abc",
        from: "x@y.com",
      },
    };
    const parsed = parseInboundWebhook(minimal);
    expect(parsed.envelopeTo).toEqual([]);
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.subject).toBe("(no subject)");
    expect(parsed.messageId).toBe("");
  });

  it("rejects payloads where to is a string (the prior bug)", () => {
    // Strict assertion that we never regress to accepting `to: string` —
    // the production schema sends an array, and accepting a string would
    // silently mask future shape drift.
    const bad = {
      type: "email.received",
      data: {
        email_id: "abc",
        from: "x@y.com",
        to: "string-not-array@y.com",
      },
    };
    const result = inboundEmailWebhookSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects payloads missing required fields", () => {
    expect(() => parseInboundWebhook({})).toThrow();
    expect(() => parseInboundWebhook({ type: "email.received" })).toThrow();
    expect(() => parseInboundWebhook({ type: "email.received", data: {} })).toThrow();
    expect(() =>
      parseInboundWebhook({ type: "email.received", data: { email_id: "x" } }),
    ).toThrow();
  });

  it("accepts arbitrary event types (caller decides what to ignore)", () => {
    // R-1: the schema is permissive on `type` so the route handler can log
    // and dismiss non-received events rather than 500ing.
    const otherEvent = {
      type: "email.delivered",
      data: { email_id: "abc", from: "x@y.com" },
    };
    expect(() => parseInboundWebhook(otherEvent)).not.toThrow();
  });
});

// ── Slice 2: ResendSendError caller-contract surface ────────────────────
describe("ResendSendError (Slice 2 — caller contract)", () => {
  it("preserves kind / statusCode / providerMessage", () => {
    const e = new ResendSendError("oops", "validation", 422, "bad recipient");
    expect(e.name).toBe("ResendSendError");
    expect(e.kind).toBe("validation");
    expect(e.statusCode).toBe(422);
    expect(e.providerMessage).toBe("bad recipient");
    expect(e.message).toContain("oops");
  });

  it("each kind tag round-trips", () => {
    for (const kind of ["validation", "idempotency", "rate_limited", "transient"] as const) {
      const e = new ResendSendError("x", kind);
      expect(e.kind).toBe(kind);
    }
  });
});

// ── Slice 2: sanitizeTagValue — Resend rejects out-of-charset tag values ──
describe("sanitizeTagValue (Slice 2 — Resend tag charset)", () => {
  it("passes through allowed chars [a-zA-Z0-9_-]", () => {
    expect(sanitizeTagValue("kind")).toBe("kind");
    expect(sanitizeTagValue("workspace_42")).toBe("workspace_42");
    expect(sanitizeTagValue("with-dash")).toBe("with-dash");
  });

  it("collapses out-of-charset to underscores", () => {
    expect(sanitizeTagValue("kind:tracking@email")).toBe("kind_tracking_email");
    expect(sanitizeTagValue("client@example.com")).toBe("client_example.com".replace(".", "_"));
    expect(sanitizeTagValue("héllo wörld")).toBe("h_llo_w_rld");
  });

  it("returns 'unspecified' for empty/missing input", () => {
    expect(sanitizeTagValue("")).toBe("unspecified");
  });

  it("clamps to 256 chars", () => {
    const out = sanitizeTagValue("a".repeat(1024));
    expect(out.length).toBe(256);
  });
});
