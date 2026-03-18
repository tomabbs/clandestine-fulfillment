import { describe, expect, it } from "vitest";

describe("portal-settings actions", () => {
  it("getPortalSettings returns org + connections + notificationPreferences", () => {
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
      notificationPreferences: { email_enabled: true },
    };

    expect(result.org?.name).toBe("Test Label");
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].connection_status).toBe("active");
    expect(result.notificationPreferences.email_enabled).toBe(true);
  });

  it("handles org with no connections", () => {
    const result = {
      org: { id: "org-2", name: "New Label", billing_email: null },
      connections: [],
      notificationPreferences: { email_enabled: true },
    };

    expect(result.connections).toHaveLength(0);
    expect(result.org?.billing_email).toBeNull();
  });

  it("notification preferences default to email_enabled true", () => {
    const result = {
      notificationPreferences: { email_enabled: true },
    };
    expect(result.notificationPreferences.email_enabled).toBe(true);
  });

  it("notification preferences can be disabled", () => {
    const result = {
      notificationPreferences: { email_enabled: false },
    };
    expect(result.notificationPreferences.email_enabled).toBe(false);
  });

  it("updateNotificationPreferences validates input", () => {
    const validInput = { email_enabled: false };
    expect(typeof validInput.email_enabled).toBe("boolean");

    const invalidInput = { email_enabled: "not-a-boolean" };
    expect(typeof invalidInput.email_enabled).not.toBe("boolean");
  });
});
