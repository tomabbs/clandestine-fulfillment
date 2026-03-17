import type { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => mockSupabaseClient),
}));

const mockRedirect = vi.fn();
const mockNextResponse = {
  next: vi.fn(() => ({
    cookies: { set: vi.fn() },
  })),
  redirect: mockRedirect,
};

vi.mock("next/server", () => ({
  NextResponse: mockNextResponse,
}));

vi.mock("@/lib/shared/constants", () => ({
  STAFF_ROLES: ["admin", "super_admin", "label_staff", "label_management", "warehouse_manager"],
}));

// --- Helpers ---

function makeCloneableUrl(pathname: string): URL & { clone: () => URL } {
  const url = new URL(`http://localhost:3000${pathname}`) as URL & { clone: () => URL };
  url.clone = () => makeCloneableUrl(pathname);
  return url;
}

function makeRequest(pathname: string): unknown {
  return {
    nextUrl: makeCloneableUrl(pathname),
    cookies: {
      getAll: () => [],
      set: vi.fn(),
    },
  };
}

function mockAuthenticatedUser(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId } },
  });
}

function mockUnauthenticatedUser() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
  });
}

function mockUserRole(role: string | null) {
  const selectMock = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: role ? { role } : null,
      }),
    }),
  });
  mockFrom.mockReturnValue({ select: selectMock });
}

// Import middleware after mocks
let middlewareFn: (request: NextRequest) => Promise<unknown>;

beforeAll(async () => {
  const mod = await import("../../middleware");
  middlewareFn = mod.middleware;
});

describe("middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNextResponse.next.mockReturnValue({ cookies: { set: vi.fn() } });
    mockRedirect.mockImplementation((url: URL) => ({ redirected: true, url: url.toString() }));
  });

  describe("public paths (no auth required)", () => {
    it("allows /api/webhooks/* through without auth", async () => {
      await middlewareFn(makeRequest("/api/webhooks/shopify") as NextRequest);

      expect(mockNextResponse.next).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it("allows /api/health through without auth", async () => {
      await middlewareFn(makeRequest("/api/health") as NextRequest);

      expect(mockNextResponse.next).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it("allows /login through without auth", async () => {
      await middlewareFn(makeRequest("/login") as NextRequest);

      expect(mockNextResponse.next).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it("allows /auth/callback through without auth", async () => {
      await middlewareFn(makeRequest("/auth/callback") as NextRequest);

      expect(mockNextResponse.next).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
    });
  });

  describe("unauthenticated users", () => {
    it("redirects to /login", async () => {
      mockUnauthenticatedUser();
      await middlewareFn(makeRequest("/admin/dashboard") as NextRequest);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectUrl = (mockRedirect.mock.calls[0][0] as URL).toString();
      expect(redirectUrl).toContain("/login");
    });

    it("includes next param in redirect", async () => {
      mockUnauthenticatedUser();
      await middlewareFn(makeRequest("/portal/inventory") as NextRequest);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectUrl = (mockRedirect.mock.calls[0][0] as URL).toString();
      expect(redirectUrl).toContain("next=%2Fportal%2Finventory");
    });
  });

  describe("/admin/* requires staff role", () => {
    it("allows admin users to access /admin", async () => {
      mockAuthenticatedUser("user-1");
      mockUserRole("admin");
      await middlewareFn(makeRequest("/admin/dashboard") as NextRequest);

      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("allows super_admin users to access /admin", async () => {
      mockAuthenticatedUser("user-2");
      mockUserRole("super_admin");
      await middlewareFn(makeRequest("/admin/settings") as NextRequest);

      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("allows warehouse_manager to access /admin", async () => {
      mockAuthenticatedUser("user-3");
      mockUserRole("warehouse_manager");
      await middlewareFn(makeRequest("/admin/inbound") as NextRequest);

      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("redirects client users away from /admin to /portal", async () => {
      mockAuthenticatedUser("user-4");
      mockUserRole("client");
      await middlewareFn(makeRequest("/admin/dashboard") as NextRequest);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectUrl = (mockRedirect.mock.calls[0][0] as URL).toString();
      expect(redirectUrl).toContain("/portal");
    });

    it("redirects client_admin users away from /admin to /portal", async () => {
      mockAuthenticatedUser("user-5");
      mockUserRole("client_admin");
      await middlewareFn(makeRequest("/admin/billing") as NextRequest);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectUrl = (mockRedirect.mock.calls[0][0] as URL).toString();
      expect(redirectUrl).toContain("/portal");
    });

    it("redirects users with no role to /login", async () => {
      mockAuthenticatedUser("user-6");
      mockUserRole(null);
      await middlewareFn(makeRequest("/admin/dashboard") as NextRequest);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectUrl = (mockRedirect.mock.calls[0][0] as URL).toString();
      expect(redirectUrl).toContain("/login");
    });
  });

  describe("/portal/* requires client role", () => {
    it("allows client users to access /portal", async () => {
      mockAuthenticatedUser("user-7");
      mockUserRole("client");
      await middlewareFn(makeRequest("/portal/inventory") as NextRequest);

      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("allows client_admin users to access /portal", async () => {
      mockAuthenticatedUser("user-8");
      mockUserRole("client_admin");
      await middlewareFn(makeRequest("/portal/settings") as NextRequest);

      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("redirects staff users away from /portal to /admin", async () => {
      mockAuthenticatedUser("user-9");
      mockUserRole("admin");
      await middlewareFn(makeRequest("/portal/inventory") as NextRequest);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectUrl = (mockRedirect.mock.calls[0][0] as URL).toString();
      expect(redirectUrl).toContain("/admin");
    });

    it("redirects users with no role to /login", async () => {
      mockAuthenticatedUser("user-10");
      mockUserRole(null);
      await middlewareFn(makeRequest("/portal/dashboard") as NextRequest);

      expect(mockRedirect).toHaveBeenCalled();
      const redirectUrl = (mockRedirect.mock.calls[0][0] as URL).toString();
      expect(redirectUrl).toContain("/login");
    });
  });
});
