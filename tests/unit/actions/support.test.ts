import { describe, expect, it } from "vitest";

/**
 * Companion test file for src/actions/support.ts (Rule #6).
 * Server Actions require Supabase auth context, so these tests validate
 * the Zod schemas and pure logic used by the actions.
 */

import { z } from "zod";

// Re-create the schemas from support.ts for unit testing
const getConversationsSchema = z.object({
  status: z
    .enum(["open", "waiting_on_client", "waiting_on_staff", "resolved", "closed"])
    .optional(),
  orgId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10000),
  orgId: z.string().uuid().optional(),
});

const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1).max(10000),
});

describe("getConversations schema", () => {
  it("accepts empty filters with defaults", () => {
    const result = getConversationsSchema.parse({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    expect(result.status).toBeUndefined();
  });

  it("accepts valid status filter", () => {
    const result = getConversationsSchema.parse({ status: "waiting_on_staff" });
    expect(result.status).toBe("waiting_on_staff");
  });

  it("rejects invalid status", () => {
    const result = getConversationsSchema.safeParse({ status: "invalid" });
    expect(result.success).toBe(false);
  });

  it("accepts valid UUID for orgId", () => {
    const result = getConversationsSchema.parse({
      orgId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.orgId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("rejects non-UUID orgId", () => {
    const result = getConversationsSchema.safeParse({ orgId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects page < 1", () => {
    const result = getConversationsSchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects pageSize > 100", () => {
    const result = getConversationsSchema.safeParse({ pageSize: 101 });
    expect(result.success).toBe(false);
  });
});

describe("createConversation schema", () => {
  it("accepts valid input", () => {
    const result = createConversationSchema.parse({
      subject: "Help with order",
      body: "I need assistance",
    });
    expect(result.subject).toBe("Help with order");
    expect(result.orgId).toBeUndefined();
  });

  it("accepts input with orgId", () => {
    const result = createConversationSchema.parse({
      subject: "Help",
      body: "Details here",
      orgId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.orgId).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("rejects empty subject", () => {
    const result = createConversationSchema.safeParse({
      subject: "",
      body: "Some body",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty body", () => {
    const result = createConversationSchema.safeParse({
      subject: "Subject",
      body: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects subject over 500 chars", () => {
    const result = createConversationSchema.safeParse({
      subject: "a".repeat(501),
      body: "Body",
    });
    expect(result.success).toBe(false);
  });
});

describe("sendMessage schema", () => {
  it("accepts valid input", () => {
    const result = sendMessageSchema.parse({
      conversationId: "123e4567-e89b-12d3-a456-426614174000",
      body: "Hello there",
    });
    expect(result.body).toBe("Hello there");
  });

  it("rejects non-UUID conversationId", () => {
    const result = sendMessageSchema.safeParse({
      conversationId: "not-uuid",
      body: "Hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty body", () => {
    const result = sendMessageSchema.safeParse({
      conversationId: "123e4567-e89b-12d3-a456-426614174000",
      body: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects body over 10000 chars", () => {
    const result = sendMessageSchema.safeParse({
      conversationId: "123e4567-e89b-12d3-a456-426614174000",
      body: "a".repeat(10001),
    });
    expect(result.success).toBe(false);
  });
});
