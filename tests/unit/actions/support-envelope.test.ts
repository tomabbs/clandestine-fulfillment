import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAuth = vi.fn();
const mockCreateServiceRoleClient = vi.fn();

vi.mock("@/lib/server/auth-context", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));

vi.mock("@/lib/clients/resend-client", () => ({
  sendSupportEmail: vi.fn(async () => ({ messageId: "msg_123" })),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: {
    trigger: vi.fn(async () => ({ id: "run-1" })),
  },
}));

describe("support action envelopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createConversation returns structured error on invalid input", async () => {
    const { createConversation } = await import("../../../src/actions/support");
    const result = await createConversation({ subject: "", body: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("valid subject");
    }
  });

  it("createConversation returns org-required for client without org", async () => {
    mockRequireAuth.mockResolvedValue({
      supabase: {},
      userRecord: { id: "u1", org_id: null, workspace_id: "w1", role: "client" },
      isStaff: false,
    });
    mockCreateServiceRoleClient.mockReturnValue({ from: vi.fn() });

    const { createConversation } = await import("../../../src/actions/support");
    const result = await createConversation({ subject: "Need help", body: "Details" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Organization required");
    }
  });

  it("sendMessage returns structured validation error on bad input", async () => {
    const { sendMessage } = await import("../../../src/actions/support");
    const result = await sendMessage({ conversationId: "not-a-uuid", body: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("valid message");
    }
  });
});
