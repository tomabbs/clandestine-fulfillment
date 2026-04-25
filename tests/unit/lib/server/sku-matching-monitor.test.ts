import { describe, expect, it } from "vitest";
import { summarizeSkuMatchingMonitoring } from "@/lib/server/sku-matching-monitor";

describe("summarizeSkuMatchingMonitoring", () => {
  it("reports healthy metrics when load time and conflicts stay within budget", () => {
    const summary = summarizeSkuMatchingMonitoring([
      {
        workspace_id: "ws_1",
        event_type: "workspace_load",
        duration_ms: 1200,
        conflict_count: 3,
        created_at: "2026-04-25T10:00:00.000Z",
      },
      {
        workspace_id: "ws_1",
        event_type: "preview_open",
        duration_ms: 300,
        conflict_count: null,
        created_at: "2026-04-25T10:01:00.000Z",
      },
      {
        workspace_id: "ws_1",
        event_type: "match_accept",
        duration_ms: null,
        conflict_count: null,
        created_at: "2026-04-25T10:02:00.000Z",
      },
    ]);

    expect(summary.status).toBe("healthy");
    expect(summary.acceptanceRate).toBe(1);
    expect(summary.reviewOnlyCount).toBe(0);
    expect(summary.conflictGrowth).toBe(0);
  });

  it("warns when workspace-load p90 or conflict growth breaches the budget", () => {
    const summary = summarizeSkuMatchingMonitoring([
      {
        workspace_id: "ws_1",
        event_type: "workspace_load",
        duration_ms: 900,
        conflict_count: 8,
        created_at: "2026-04-18T10:00:00.000Z",
      },
      {
        workspace_id: "ws_1",
        event_type: "workspace_load",
        duration_ms: 4500,
        conflict_count: 24,
        created_at: "2026-04-25T10:00:00.000Z",
      },
      {
        workspace_id: "ws_1",
        event_type: "preview_open",
        duration_ms: 250,
        conflict_count: null,
        created_at: "2026-04-25T10:01:00.000Z",
      },
      {
        workspace_id: "ws_1",
        event_type: "preview_open",
        duration_ms: 260,
        conflict_count: null,
        created_at: "2026-04-25T10:02:00.000Z",
      },
      {
        workspace_id: "ws_1",
        event_type: "match_accept",
        duration_ms: null,
        conflict_count: null,
        created_at: "2026-04-25T10:03:00.000Z",
      },
    ]);

    expect(summary.status).toBe("warning");
    expect(summary.reasons).toContain("workspace_load_p90>3000");
    expect(summary.reasons).toContain("conflict_growth");
    expect(summary.reviewOnlyCount).toBe(1);
    expect(summary.acceptanceRate).toBe(0.5);
  });
});
