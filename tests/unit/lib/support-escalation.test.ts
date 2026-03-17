import { describe, expect, it } from "vitest";

/**
 * Unit tests for support escalation timing logic.
 * These test the pure decision functions used by the support-escalation Trigger task.
 */

interface ConversationForEscalation {
  id: string;
  status: string;
  lastMessageAt: string;
  lastMessageSenderType: "staff" | "client" | "system";
}

function shouldEscalateToStaff(
  conversation: ConversationForEscalation,
  now: Date,
  thresholdMinutes: number,
): boolean {
  if (conversation.status !== "waiting_on_staff") return false;
  if (conversation.lastMessageSenderType === "staff") return false;

  const lastMessageTime = new Date(conversation.lastMessageAt).getTime();
  const elapsedMinutes = (now.getTime() - lastMessageTime) / (1000 * 60);
  return elapsedMinutes >= thresholdMinutes;
}

function shouldRemindClient(
  conversation: ConversationForEscalation,
  now: Date,
  thresholdHours: number,
): boolean {
  if (conversation.status !== "waiting_on_client") return false;
  if (conversation.lastMessageSenderType === "client") return false;

  const lastMessageTime = new Date(conversation.lastMessageAt).getTime();
  const elapsedHours = (now.getTime() - lastMessageTime) / (1000 * 60 * 60);
  return elapsedHours >= thresholdHours;
}

describe("shouldEscalateToStaff", () => {
  const now = new Date("2026-03-16T12:00:00Z");

  it("returns true when waiting on staff and last client message is older than threshold", () => {
    const conv: ConversationForEscalation = {
      id: "conv-1",
      status: "waiting_on_staff",
      lastMessageAt: "2026-03-16T11:40:00Z", // 20 min ago
      lastMessageSenderType: "client",
    };

    expect(shouldEscalateToStaff(conv, now, 15)).toBe(true);
  });

  it("returns false when last message is within threshold", () => {
    const conv: ConversationForEscalation = {
      id: "conv-2",
      status: "waiting_on_staff",
      lastMessageAt: "2026-03-16T11:50:00Z", // 10 min ago
      lastMessageSenderType: "client",
    };

    expect(shouldEscalateToStaff(conv, now, 15)).toBe(false);
  });

  it("returns false when last message is from staff (already replied)", () => {
    const conv: ConversationForEscalation = {
      id: "conv-3",
      status: "waiting_on_staff",
      lastMessageAt: "2026-03-16T11:30:00Z", // 30 min ago
      lastMessageSenderType: "staff",
    };

    expect(shouldEscalateToStaff(conv, now, 15)).toBe(false);
  });

  it("returns false when status is not waiting_on_staff", () => {
    const conv: ConversationForEscalation = {
      id: "conv-4",
      status: "open",
      lastMessageAt: "2026-03-16T11:00:00Z",
      lastMessageSenderType: "client",
    };

    expect(shouldEscalateToStaff(conv, now, 15)).toBe(false);
  });

  it("returns true at exact threshold boundary", () => {
    const conv: ConversationForEscalation = {
      id: "conv-5",
      status: "waiting_on_staff",
      lastMessageAt: "2026-03-16T11:45:00Z", // exactly 15 min ago
      lastMessageSenderType: "client",
    };

    expect(shouldEscalateToStaff(conv, now, 15)).toBe(true);
  });

  it("returns false for resolved conversations", () => {
    const conv: ConversationForEscalation = {
      id: "conv-6",
      status: "resolved",
      lastMessageAt: "2026-03-16T10:00:00Z",
      lastMessageSenderType: "client",
    };

    expect(shouldEscalateToStaff(conv, now, 15)).toBe(false);
  });
});

describe("shouldRemindClient", () => {
  const now = new Date("2026-03-16T12:00:00Z");

  it("returns true when waiting on client and last staff message is older than threshold", () => {
    const conv: ConversationForEscalation = {
      id: "conv-1",
      status: "waiting_on_client",
      lastMessageAt: "2026-03-15T10:00:00Z", // 26 hours ago
      lastMessageSenderType: "staff",
    };

    expect(shouldRemindClient(conv, now, 24)).toBe(true);
  });

  it("returns false when last message is within threshold", () => {
    const conv: ConversationForEscalation = {
      id: "conv-2",
      status: "waiting_on_client",
      lastMessageAt: "2026-03-16T00:00:00Z", // 12 hours ago
      lastMessageSenderType: "staff",
    };

    expect(shouldRemindClient(conv, now, 24)).toBe(false);
  });

  it("returns false when last message is from client (they already replied)", () => {
    const conv: ConversationForEscalation = {
      id: "conv-3",
      status: "waiting_on_client",
      lastMessageAt: "2026-03-14T12:00:00Z", // 48 hours ago
      lastMessageSenderType: "client",
    };

    expect(shouldRemindClient(conv, now, 24)).toBe(false);
  });

  it("returns false when status is not waiting_on_client", () => {
    const conv: ConversationForEscalation = {
      id: "conv-4",
      status: "waiting_on_staff",
      lastMessageAt: "2026-03-14T12:00:00Z",
      lastMessageSenderType: "staff",
    };

    expect(shouldRemindClient(conv, now, 24)).toBe(false);
  });

  it("returns true at exact threshold boundary", () => {
    const conv: ConversationForEscalation = {
      id: "conv-5",
      status: "waiting_on_client",
      lastMessageAt: "2026-03-15T12:00:00Z", // exactly 24 hours ago
      lastMessageSenderType: "staff",
    };

    expect(shouldRemindClient(conv, now, 24)).toBe(true);
  });
});
