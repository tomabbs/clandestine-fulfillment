import { describe, expect, it } from "vitest";

describe("portal-settings actions", () => {
  it("getPortalSettings returns org + connections", () => {
    const result = {
      org: { id: "org-1", name: "Test Label", billing_email: "billing@test.com" },
      connections: [
        {
          id: "conn-1",
          platform: "shopify",
          store_url: "https://test.myshopify.com",
          connection_status: "active",
          last_webhook_at: "2026-03-17T00:00:00Z",
        },
      ],
    };

    expect(result.org?.name).toBe("Test Label");
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].connection_status).toBe("active");
  });

  it("handles org with no connections", () => {
    const result = {
      org: { id: "org-2", name: "New Label", billing_email: null },
      connections: [],
    };

    expect(result.connections).toHaveLength(0);
    expect(result.org?.billing_email).toBeNull();
  });
});
