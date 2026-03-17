import { describe, expect, it } from "vitest";
import { inboundEmailSchema, parseInboundEmail } from "@/lib/clients/resend-client";

describe("parseInboundEmail", () => {
  it("parses a complete inbound email payload", () => {
    const payload = {
      from: "Alice <alice@example.com>",
      to: "support@mail.clandestinefulfillment.com",
      subject: "Need help with my order",
      text: "Hi, I have a question about order #1234.",
      message_id: "<msg-123@example.com>",
      in_reply_to: "<msg-000@example.com>",
    };

    const result = parseInboundEmail(payload);

    expect(result).toEqual({
      from: "Alice <alice@example.com>",
      to: "support@mail.clandestinefulfillment.com",
      subject: "Need help with my order",
      body: "Hi, I have a question about order #1234.",
      messageId: "<msg-123@example.com>",
      inReplyTo: "<msg-000@example.com>",
    });
  });

  it("handles missing optional fields with defaults", () => {
    const payload = {
      from: "bob@example.com",
      to: "support@mail.clandestinefulfillment.com",
      message_id: "<msg-456@example.com>",
    };

    const result = parseInboundEmail(payload);

    expect(result.subject).toBe("(no subject)");
    expect(result.body).toBe("");
    expect(result.inReplyTo).toBeUndefined();
  });

  it("parses plain email address in from field", () => {
    const payload = {
      from: "plain@example.com",
      to: "support@example.com",
      subject: "Test",
      text: "Body text",
      message_id: "<msg-789@example.com>",
    };

    const result = parseInboundEmail(payload);
    expect(result.from).toBe("plain@example.com");
  });

  it("throws on missing required fields", () => {
    expect(() => parseInboundEmail({})).toThrow();
    expect(() => parseInboundEmail({ from: "a@b.com" })).toThrow();
    expect(() => parseInboundEmail({ from: "a@b.com", to: "b@c.com" })).toThrow();
  });

  it("validates with inboundEmailSchema directly", () => {
    const valid = {
      from: "test@example.com",
      to: "support@example.com",
      subject: "Test Subject",
      text: "Hello",
      message_id: "<abc@example.com>",
    };

    const result = inboundEmailSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects invalid schema payloads", () => {
    const result = inboundEmailSchema.safeParse({
      from: 123, // should be string
      to: "support@example.com",
      message_id: "<abc@example.com>",
    });
    expect(result.success).toBe(false);
  });
});
