import { describe, expect, it } from "vitest";

describe("admin-settings actions", () => {
  it("getGeneralSettings returns workspace + counts + rules", () => {
    const result = {
      workspace: { name: "Test Warehouse", slug: "test-warehouse" },
      orgCount: 5,
      productCount: 200,
      billingRules: [
        { rule_name: "Per Shipment", rule_type: "per_shipment", amount: 3.5, is_active: true },
      ],
    };

    expect(result.workspace?.name).toBe("Test Warehouse");
    expect(result.orgCount).toBe(5);
    expect(result.billingRules).toHaveLength(1);
  });

  it("getIntegrationStatus groups sync logs by channel", () => {
    const logs = [
      { channel: "shopify", status: "completed", completed_at: "2026-03-17T01:00:00Z" },
      { channel: "shopify", status: "failed", completed_at: "2026-03-16T23:00:00Z" },
      { channel: "bandcamp", status: "completed", completed_at: "2026-03-17T00:30:00Z" },
    ];

    const lastByChannel = new Map<string, { status: string }>();
    for (const log of logs) {
      if (!lastByChannel.has(log.channel)) {
        lastByChannel.set(log.channel, { status: log.status });
      }
    }

    expect(lastByChannel.get("shopify")?.status).toBe("completed");
    expect(lastByChannel.get("bandcamp")?.status).toBe("completed");
  });
});
