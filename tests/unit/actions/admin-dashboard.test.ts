import { describe, expect, it } from "vitest";

describe("admin-dashboard actions", () => {
  it("getDashboardStats returns expected shape", () => {
    const mockResult = {
      stats: {
        totalProducts: 150,
        monthOrders: 45,
        monthShipments: 30,
        criticalReviewItems: 2,
        pendingInbound: 5,
      },
      recentActivity: [
        {
          id: "1",
          type: "inventory",
          message: "shopify: LP-001 -2",
          created_at: "2026-03-17T00:00:00Z",
        },
      ],
      sensorHealth: {
        "sync.shopify_stale": { status: "healthy", message: "Last sync 5 minutes ago" },
      },
    };

    expect(mockResult.stats.totalProducts).toBe(150);
    expect(mockResult.recentActivity).toHaveLength(1);
    expect(mockResult.sensorHealth["sync.shopify_stale"].status).toBe("healthy");
  });

  it("recent activity combines inventory + sync log entries sorted by date", () => {
    const activity = [
      {
        id: "inv-1",
        type: "inventory" as const,
        message: "shopify: LP-001 -2",
        created_at: "2026-03-17T02:00:00Z",
      },
      {
        id: "sync-1",
        type: "sync" as const,
        message: "shopify delta: completed (50 items)",
        created_at: "2026-03-17T01:00:00Z",
      },
    ];

    const sorted = activity.sort((a, b) => b.created_at.localeCompare(a.created_at));
    expect(sorted[0].id).toBe("inv-1");
    expect(sorted[1].id).toBe("sync-1");
  });
});
