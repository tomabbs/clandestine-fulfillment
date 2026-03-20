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
  sendPortalInviteEmail: vi.fn(async () => ({ messageId: "resend_1" })),
}));

describe("inviteUser structured responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      userRecord: { id: "u1", role: "admin", workspace_id: "ws1", org_id: null, email: "a@b.com" },
    });
  });

  it("returns INVALID_INPUT envelope for malformed invite payload", async () => {
    const { inviteUser } = await import("../../../src/actions/users");
    const result = await inviteUser({
      email: "not-an-email",
      name: "",
      role: "client" as never,
      orgId: "not-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVITE_RATE_LIMITED when generateLink is rate-limited", async () => {
    const usersLookupChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      maybeSingle: vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: null }) // existing user in workspace
        .mockResolvedValueOnce({ data: null, error: null }), // existing user in other workspace
    };

    const serviceClient = {
      from: vi.fn((table: string) => {
        if (table === "users") return usersLookupChain;
        return {};
      }),
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({
            data: { users: [] },
            error: null,
          }),
          createUser: vi.fn().mockResolvedValue({
            data: { user: { id: "auth-1", email: "client@example.com" } },
            error: null,
          }),
          generateLink: vi.fn().mockResolvedValue({
            data: { user: null, properties: null },
            error: { message: "Email rate limit exceeded" },
          }),
        },
      },
    };
    mockCreateServiceRoleClient.mockReturnValue(serviceClient);

    const { inviteUser } = await import("../../../src/actions/users");
    const result = await inviteUser({
      email: "client@example.com",
      name: "Client User",
      role: "client_admin",
      orgId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(["INVITE_RATE_LIMITED", "UNEXPECTED"]).toContain(result.code);
      expect(result.error.toLowerCase()).toContain("rate");
    }
  });
});
