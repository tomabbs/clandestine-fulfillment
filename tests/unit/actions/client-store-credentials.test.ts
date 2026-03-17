import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();

const mockServerClient = {
  auth: { getUser: mockGetUser },
  from: vi.fn(),
};

const mockServiceFrom = vi.fn();
const mockServiceClient = {
  from: mockServiceFrom,
};

vi.mock("@/lib/server/supabase-server", () => ({
  createServerSupabaseClient: async () => mockServerClient,
  createServiceRoleClient: () => mockServiceClient,
}));

// Import after mocks
import { submitClientStoreCredentials } from "@/actions/client-store-credentials";

describe("client-store-credentials (Rule #19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "auth-user-1" } } });
  });

  // === Auth tests ===

  it("throws when user is not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expect(submitClientStoreCredentials("conn-1", { apiKey: "test-key" })).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("throws when connectionId is empty", async () => {
    await expect(submitClientStoreCredentials("", { apiKey: "test-key" })).rejects.toThrow(
      "Connection ID is required",
    );
  });

  it("throws when apiKey is empty", async () => {
    await expect(submitClientStoreCredentials("conn-1", { apiKey: "" })).rejects.toThrow();
  });

  // === Org validation ===

  it("throws when connection not found", async () => {
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    });

    await expect(submitClientStoreCredentials("conn-1", { apiKey: "test-key" })).rejects.toThrow(
      "Connection not found",
    );
  });

  it("throws when user record not found", async () => {
    // Connection lookup
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: "org-1" },
            error: null,
          }),
        }),
      }),
    });

    // User lookup
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    });

    await expect(submitClientStoreCredentials("conn-1", { apiKey: "test-key" })).rejects.toThrow(
      "User record not found",
    );
  });

  it("throws when user org does not match connection org", async () => {
    // Connection lookup — org_id: "org-1"
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: "org-1" },
            error: null,
          }),
        }),
      }),
    });

    // User lookup — org_id: "org-DIFFERENT"
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: "org-DIFFERENT" },
            error: null,
          }),
        }),
      }),
    });

    await expect(submitClientStoreCredentials("conn-1", { apiKey: "test-key" })).rejects.toThrow(
      "You do not have permission to modify this connection",
    );
  });

  // === Successful write via service_role ===

  it("writes credentials via service_role when org matches", async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    // Connection lookup
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: "org-1" },
            error: null,
          }),
        }),
      }),
    });

    // User lookup
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: "org-1" },
            error: null,
          }),
        }),
      }),
    });

    // Credential update via service_role
    mockServiceFrom.mockReturnValueOnce({
      update: mockUpdate,
    });

    const result = await submitClientStoreCredentials("conn-1", {
      apiKey: "new-api-key",
      apiSecret: "new-api-secret",
    });

    expect(result).toEqual({ success: true });

    // Verify service_role client was used to write (bypasses staff-only RLS)
    expect(mockServiceFrom).toHaveBeenCalledWith("client_store_connections");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key: "new-api-key",
        api_secret: "new-api-secret",
      }),
    );
  });

  it("writes only apiKey when apiSecret not provided", async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    // Connection lookup
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: "org-1" },
            error: null,
          }),
        }),
      }),
    });

    // User lookup
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: "org-1" },
            error: null,
          }),
        }),
      }),
    });

    // Credential update
    mockServiceFrom.mockReturnValueOnce({
      update: mockUpdate,
    });

    await submitClientStoreCredentials("conn-1", { apiKey: "only-key" });

    // Should NOT include api_secret in update
    const updateArg = mockUpdate.mock.calls[0][0];
    expect(updateArg.api_key).toBe("only-key");
    expect(updateArg).not.toHaveProperty("api_secret");
  });
});
