import { describe, expect, it } from "vitest";

/**
 * Companion test file for src/actions/support.ts (Rule #6).
 * Server Actions require Supabase auth context, so these tests validate
 * the Zod schemas and pure logic used by the actions.
 */

import { z } from "zod";
import { nextSupportDeliveryRetryAt } from "@/lib/server/support-delivery";
import { conversationMatchesQueue, getSupportQueueFlags } from "@/lib/server/support-queues";
import { calculateSupportSlaDeadlines } from "@/lib/server/support-sla";

// Re-create the schemas from support.ts for unit testing
const getConversationsSchema = z.object({
  status: z
    .enum(["open", "waiting_on_client", "waiting_on_staff", "resolved", "closed"])
    .optional(),
  queue: z
    .enum([
      "needs_triage",
      "mine",
      "waiting_on_staff",
      "waiting_on_client",
      "sla_breach_soon",
      "sla_breached",
      "unassigned",
      "snoozed",
      "resolved",
    ])
    .optional(),
  orgId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  search: z.string().trim().min(1).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10000),
  orgId: z.string().uuid().optional(),
  category: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

const sendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().min(1).max(10000),
  clientMutationId: z.string().min(8).max(120).optional(),
  lastSeenMessageId: z.string().uuid().optional(),
  lastSeenMessageCreatedAt: z.string().optional(),
  forceSendAfterCollision: z.boolean().optional(),
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

  it("accepts computed queue filters", () => {
    const result = getConversationsSchema.parse({ queue: "needs_triage", search: "shipment" });
    expect(result.queue).toBe("needs_triage");
    expect(result.search).toBe("shipment");
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
    expect(result.priority).toBe("normal");
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

  it("accepts idempotency and collision fields", () => {
    const result = sendMessageSchema.parse({
      conversationId: "123e4567-e89b-12d3-a456-426614174000",
      body: "Hello there",
      clientMutationId: "client-mutation-1",
      lastSeenMessageId: "123e4567-e89b-12d3-a456-426614174001",
      forceSendAfterCollision: true,
    });
    expect(result.clientMutationId).toBe("client-mutation-1");
    expect(result.forceSendAfterCollision).toBe(true);
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

describe("support queue helpers", () => {
  const baseConversation = {
    status: "waiting_on_staff" as const,
    assigned_to: null,
    category: null,
    priority: "normal",
    snoozed_until: null,
    next_response_due_at: "2026-03-16T12:30:00Z",
    sla_paused: false,
  };

  it("classifies needs triage from canonical fields", () => {
    const flags = getSupportQueueFlags(
      baseConversation,
      "user-1",
      new Date("2026-03-16T12:00:00Z"),
    );
    expect(flags.needsTriage).toBe(true);
    expect(flags.unassigned).toBe(true);
    expect(
      conversationMatchesQueue(
        baseConversation,
        "needs_triage",
        "user-1",
        new Date("2026-03-16T12:00:00Z"),
      ),
    ).toBe(true);
  });

  it("marks SLA breach soon and breached separately", () => {
    const soon = getSupportQueueFlags(baseConversation, "user-1", new Date("2026-03-16T12:00:00Z"));
    const breached = getSupportQueueFlags(
      baseConversation,
      "user-1",
      new Date("2026-03-16T12:31:00Z"),
    );
    expect(soon.slaBreachSoon).toBe(true);
    expect(soon.slaBreached).toBe(false);
    expect(breached.slaBreached).toBe(true);
  });

  it("does not count paused SLA tickets as breached", () => {
    const flags = getSupportQueueFlags(
      { ...baseConversation, sla_paused: true },
      "user-1",
      new Date("2026-03-16T12:31:00Z"),
    );
    expect(flags.slaBreached).toBe(false);
  });
});

describe("support SLA and delivery helpers", () => {
  it("calculates first, next, and resolution due dates from policy minutes", () => {
    const deadlines = calculateSupportSlaDeadlines(
      {
        first_response_minutes: 30,
        next_response_minutes: 60,
        resolution_minutes: 120,
      },
      new Date("2026-03-16T12:00:00Z"),
    );
    expect(deadlines.first_response_due_at).toBe("2026-03-16T12:30:00.000Z");
    expect(deadlines.next_response_due_at).toBe("2026-03-16T13:00:00.000Z");
    expect(deadlines.resolution_due_at).toBe("2026-03-16T14:00:00.000Z");
  });

  it("uses exponential retry windows for support delivery recovery", () => {
    const retryAt = nextSupportDeliveryRetryAt(2, new Date("2026-03-16T12:00:00Z"));
    expect(retryAt).toBe("2026-03-16T12:15:00.000Z");
  });
});
