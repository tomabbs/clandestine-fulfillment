import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  correlationIdBucket,
  isInRolloutBucket,
  loadFanoutGuard,
  makeGuard,
} from "@/lib/server/fanout-guard";

const baseRow = {
  inventory_sync_paused: false,
  shipstation_sync_paused: false,
  bandcamp_sync_paused: false,
  clandestine_shopify_sync_paused: false,
  client_store_sync_paused: false,
  fanout_rollout_percent: 100,
};

function fakeSupabase(rowOrError: typeof baseRow | { error: unknown } | null): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            if (rowOrError === null) return { data: null, error: { message: "missing" } };
            if ("error" in rowOrError) return { data: null, error: rowOrError.error };
            return { data: rowOrError, error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("correlationIdBucket", () => {
  it("is deterministic for the same input", () => {
    expect(correlationIdBucket("ws_123:sku_abc")).toBe(correlationIdBucket("ws_123:sku_abc"));
  });

  it("returns a value in [0, 99]", () => {
    for (const id of ["a", "abcdef", "ws_999:sku_LILA-AV1", "shipstation:9871"]) {
      const b = correlationIdBucket(id);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(99);
    }
  });

  it("distributes across the buckets", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(correlationIdBucket(`corr_${i}`));
    expect(seen.size).toBeGreaterThan(60);
  });
});

describe("isInRolloutBucket", () => {
  it("100% always passes", () => {
    expect(isInRolloutBucket("anything", 100)).toBe(true);
  });
  it("0% always fails", () => {
    expect(isInRolloutBucket("anything", 0)).toBe(false);
  });
  it("partial percentages bucket deterministically", () => {
    const id = "ws_42:bandcamp:order_777";
    const bucket = correlationIdBucket(id);
    expect(isInRolloutBucket(id, bucket)).toBe(false);
    expect(isInRolloutBucket(id, bucket + 1)).toBe(true);
  });
});

describe("makeGuard.evaluate", () => {
  const cid = "ws_42:bandcamp:order_777";
  it("global pause beats integration", () => {
    const g = makeGuard({ ...baseRow, inventory_sync_paused: true });
    expect(g.evaluate("bandcamp", cid)).toEqual({ allow: false, reason: "global_paused" });
  });
  it("per-integration pause", () => {
    const g = makeGuard({ ...baseRow, bandcamp_sync_paused: true });
    expect(g.evaluate("bandcamp", cid)).toEqual({
      allow: false,
      reason: "integration_paused",
    });
    expect(g.evaluate("shipstation", cid).allow).toBe(true);
  });
  it("rollout exclusion", () => {
    const g = makeGuard({ ...baseRow, fanout_rollout_percent: 0 });
    expect(g.evaluate("bandcamp", cid)).toEqual({ allow: false, reason: "rollout_excluded" });
  });
  it("allows when nothing blocks", () => {
    const g = makeGuard(baseRow);
    expect(g.evaluate("shipstation", cid)).toEqual({ allow: true });
  });
});

describe("loadFanoutGuard", () => {
  it("returns deny-all when row missing", async () => {
    const g = await loadFanoutGuard(fakeSupabase(null), "ws_missing");
    expect(g.shouldFanout("bandcamp", "x")).toBe(false);
    expect(g.row.inventory_sync_paused).toBe(true);
  });
  it("returns deny-all on error", async () => {
    const g = await loadFanoutGuard(fakeSupabase({ error: { message: "fail" } }), "ws_x");
    expect(g.shouldFanout("shipstation", "y")).toBe(false);
  });
  it("uses live row when present", async () => {
    const g = await loadFanoutGuard(fakeSupabase(baseRow), "ws_live");
    expect(g.shouldFanout("bandcamp", "corr_x")).toBe(true);
    expect(g.row.fanout_rollout_percent).toBe(100);
  });
});
