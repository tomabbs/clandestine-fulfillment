import { describe, expect, it } from "vitest";

/**
 * Unit tests for conversation matching logic used in the Resend inbound webhook.
 * These test the pure logic functions extracted from the route handler.
 */

function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from.trim();
}

interface EmailMapping {
  email_address: string;
  org_id: string;
  is_active: boolean;
}

interface ExistingMessage {
  conversation_id: string;
  email_message_id: string;
}

type MatchResult =
  | { type: "reply"; conversationId: string }
  | { type: "new_conversation"; orgId: string }
  | { type: "unmatched" };

function matchConversation(
  inReplyTo: string | undefined,
  senderAddress: string,
  existingMessages: ExistingMessage[],
  emailMappings: EmailMapping[],
): MatchResult {
  // Strategy 1: Match by In-Reply-To header
  if (inReplyTo) {
    const match = existingMessages.find((m) => m.email_message_id === inReplyTo);
    if (match) {
      return { type: "reply", conversationId: match.conversation_id };
    }
  }

  // Strategy 2: Match by sender email → org mapping
  const mapping = emailMappings.find((m) => m.email_address === senderAddress && m.is_active);
  if (mapping) {
    return { type: "new_conversation", orgId: mapping.org_id };
  }

  // Strategy 3: Unmatched
  return { type: "unmatched" };
}

describe("extractEmailAddress", () => {
  it("extracts email from 'Name <email>' format", () => {
    expect(extractEmailAddress("Alice Smith <alice@example.com>")).toBe("alice@example.com");
  });

  it("returns plain email address as-is", () => {
    expect(extractEmailAddress("bob@example.com")).toBe("bob@example.com");
  });

  it("handles email with extra whitespace", () => {
    expect(extractEmailAddress("  charlie@example.com  ")).toBe("charlie@example.com");
  });

  it("handles complex display name", () => {
    expect(extractEmailAddress('"Smith, Alice" <alice@example.com>')).toBe("alice@example.com");
  });
});

describe("matchConversation", () => {
  const existingMessages: ExistingMessage[] = [
    {
      conversation_id: "conv-111",
      email_message_id: "<msg-aaa@example.com>",
    },
    {
      conversation_id: "conv-222",
      email_message_id: "<msg-bbb@example.com>",
    },
  ];

  const emailMappings: EmailMapping[] = [
    {
      email_address: "alice@records.com",
      org_id: "org-001",
      is_active: true,
    },
    {
      email_address: "old@records.com",
      org_id: "org-002",
      is_active: false,
    },
  ];

  it("matches by In-Reply-To header when message exists", () => {
    const result = matchConversation(
      "<msg-aaa@example.com>",
      "alice@records.com",
      existingMessages,
      emailMappings,
    );

    expect(result).toEqual({
      type: "reply",
      conversationId: "conv-111",
    });
  });

  it("prefers In-Reply-To over email mapping", () => {
    const result = matchConversation(
      "<msg-bbb@example.com>",
      "alice@records.com",
      existingMessages,
      emailMappings,
    );

    expect(result).toEqual({
      type: "reply",
      conversationId: "conv-222",
    });
  });

  it("falls back to email mapping when In-Reply-To doesn't match", () => {
    const result = matchConversation(
      "<msg-nonexistent@example.com>",
      "alice@records.com",
      existingMessages,
      emailMappings,
    );

    expect(result).toEqual({
      type: "new_conversation",
      orgId: "org-001",
    });
  });

  it("creates new conversation from email mapping when no In-Reply-To", () => {
    const result = matchConversation(
      undefined,
      "alice@records.com",
      existingMessages,
      emailMappings,
    );

    expect(result).toEqual({
      type: "new_conversation",
      orgId: "org-001",
    });
  });

  it("ignores inactive email mappings", () => {
    const result = matchConversation(undefined, "old@records.com", existingMessages, emailMappings);

    expect(result).toEqual({ type: "unmatched" });
  });

  it("returns unmatched for unknown sender with no In-Reply-To", () => {
    const result = matchConversation(
      undefined,
      "stranger@example.com",
      existingMessages,
      emailMappings,
    );

    expect(result).toEqual({ type: "unmatched" });
  });

  it("returns unmatched for unknown sender with non-matching In-Reply-To", () => {
    const result = matchConversation(
      "<msg-unknown@example.com>",
      "stranger@example.com",
      existingMessages,
      emailMappings,
    );

    expect(result).toEqual({ type: "unmatched" });
  });
});
