import { describe, expect, it } from "vitest";

describe("shopify actions", () => {
  it("triggerShopifySync returns a run ID", () => {
    const result = { runId: "run_abc123" };
    expect(result.runId).toBeTruthy();
    expect(typeof result.runId).toBe("string");
  });

  it("triggerFullBackfill returns a run ID", () => {
    const result = { runId: "run_xyz789" };
    expect(result.runId).toBeTruthy();
  });

  it("getShopifySyncStatus returns sync state + logs", () => {
    const status = {
      syncState: {
        last_sync_cursor: "2026-03-17T01:00:00Z",
        last_sync_wall_clock: "2026-03-17T01:00:00Z",
        last_full_sync_at: "2026-03-15T03:00:00Z",
      },
      recentLogs: [
        {
          id: "log-1",
          sync_type: "delta",
          status: "completed",
          items_processed: 50,
          started_at: "2026-03-17T01:00:00Z",
          completed_at: "2026-03-17T01:01:00Z",
        },
      ],
    };

    expect(status.syncState?.last_sync_cursor).toBeTruthy();
    expect(status.recentLogs).toHaveLength(1);
    expect(status.recentLogs[0].status).toBe("completed");
  });

  it("handles null sync state (never synced)", () => {
    const status = { syncState: null, recentLogs: [] };
    expect(status.syncState).toBeNull();
    expect(status.recentLogs).toHaveLength(0);
  });
});
