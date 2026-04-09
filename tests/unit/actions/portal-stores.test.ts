import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/auth-context", () => ({
  requireClient: vi.fn(() => Promise.resolve({ orgId: "org-1" })),
}));

const mockFrom = vi.fn();

const mockServiceClient = { from: mockFrom };

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: vi.fn(() => mockServiceClient),
}));

import {
  deleteStoreConnection,
  getMyStoreConnections,
  getWooCommerceAuthUrl,
} from "@/actions/portal-stores";

describe("portal-stores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  describe("getMyStoreConnections", () => {
    it("returns connections filtered by orgId", async () => {
      const rows = [{ id: "c1", org_id: "org-1", platform: "shopify" }];
      const promise = Promise.resolve({ data: rows, error: null });
      const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
      };
      chain.select.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      chain.order.mockReturnValue(promise);
      mockFrom.mockReturnValue(chain);

      const result = await getMyStoreConnections();

      expect(chain.eq).toHaveBeenCalledWith("org_id", "org-1");
      expect(result.connections).toEqual(rows);
      expect(result.orgId).toBe("org-1");
    });
  });

  describe("deleteStoreConnection", () => {
    it("filters by connection id and org_id", async () => {
      const eqOrg = vi.fn().mockResolvedValue({ error: null });
      const eqId = vi.fn().mockReturnValue({ eq: eqOrg });
      mockFrom.mockReturnValue({
        delete: vi.fn().mockReturnValue({ eq: eqId }),
      });

      await deleteStoreConnection("conn-9");

      expect(eqId).toHaveBeenCalledWith("id", "conn-9");
      expect(eqOrg).toHaveBeenCalledWith("org_id", "org-1");
    });
  });

  describe("getWooCommerceAuthUrl", () => {
    it("returns a login URL whose redirect encodes wc-auth authorize params", async () => {
      const { url } = await getWooCommerceAuthUrl("https://store.example.com/");

      expect(url).toMatch(/^https:\/\/store\.example\.com\/wp-login\.php\?redirect_to=/);
      const redirectTo = new URL(url).searchParams.get("redirect_to");
      expect(redirectTo).toBeTruthy();
      const wcAuth = redirectTo ?? "";
      expect(wcAuth).toContain("/wc-auth/v1/authorize?");
      expect(wcAuth).toContain("app_name=Clandestine+Fulfillment");
      expect(wcAuth).toContain("scope=read_write");
      expect(wcAuth).toContain("user_id=org-1");
      expect(wcAuth).toContain("return_url=");
      expect(wcAuth).toContain("callback_url=");
    });

    it("includes org_id and store_url in the OAuth callback query", async () => {
      const { url } = await getWooCommerceAuthUrl("https://store.example.com");

      const redirectTo = new URL(url).searchParams.get("redirect_to");
      const auth = new URL(redirectTo ?? "");
      const callbackUrl = auth.searchParams.get("callback_url");
      expect(callbackUrl).toBeTruthy();
      const cb = new URL(callbackUrl ?? "");
      expect(cb.pathname).toBe("/api/oauth/woocommerce/callback");
      expect(cb.searchParams.get("org_id")).toBe("org-1");
      expect(cb.searchParams.get("store_url")).toBe("https://store.example.com");
    });
  });
});
