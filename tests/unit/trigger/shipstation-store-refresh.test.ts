import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  task: (def: { run: (...args: unknown[]) => unknown }) => def,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: { name: "shipstation" },
}));

const insertSpy = vi.fn().mockResolvedValue({ error: null });
const updateChain = {
  eq: () => updateChain,
  update: () => updateChain,
};
const updateSpy = vi.fn(() => updateChain);

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: vi.fn(() => ({
      insert: insertSpy,
      update: updateSpy,
      eq: () => updateChain,
    })),
  }),
}));

import { runShipstationStoreRefresh } from "@/trigger/tasks/shipstation-store-refresh";

const taskCtx = { run: { id: "run_refresh_test" } };

describe("shipstationStoreRefreshTask (stub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns deferred status with the canonical reason while endpoint is TBD", async () => {
    const result = await runShipstationStoreRefresh(
      { workspaceId: "ws-1", storeId: 12345, reason: "draft_saved" },
      taskCtx,
    );

    expect(result.status).toBe("deferred");
    expect(result.reason).toBe("endpoint_tbd_using_24h_auto_import_fallback");
    expect(result.store_id).toBe(12345);
    expect(result.workspace_id).toBe("ws-1");
  });

  it("records the request in channel_sync_log even though no API call is made", async () => {
    await runShipstationStoreRefresh({ workspaceId: "ws-2", storeId: 99 }, taskCtx);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});
