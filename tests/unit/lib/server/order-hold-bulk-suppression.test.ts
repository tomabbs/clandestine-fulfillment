import { describe, expect, it, vi } from "vitest";
import {
  BULK_HOLD_SUPPRESSION_CONTRACT,
  type BulkSuppressionCountQuery,
  type BulkSuppressionHoldReason,
  type BulkSuppressionSupabaseClient,
  shouldSuppressBulkHold,
} from "@/lib/server/order-hold-bulk-suppression";

/**
 * Chainable mock matching the production supabase builder chain used
 * by `shouldSuppressBulkHold`:
 *
 *   supabase
 *     .from("order_fulfillment_hold_events")
 *     .select("id", { count: "exact", head: true })
 *     .eq("workspace_id", ...)
 *     .eq("connection_id", ...)
 *     .eq("event_type", "hold_applied")
 *     .eq("hold_reason", ...)
 *     .gte("created_at", ...)        ← returns PromiseLike<{ count, error }>
 *
 * The .eq() chain is called 4 times before .gte(); the count returned
 * is drawn from the injected `result`.
 */
function makeMockSupabase(result: BulkSuppressionCountQuery): {
  client: BulkSuppressionSupabaseClient;
  spies: {
    from: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    gte: ReturnType<typeof vi.fn>;
  };
} {
  const eqCalls: Array<[string, string]> = [];
  const gteCalls: Array<[string, string]> = [];
  const selectCalls: Array<[string, unknown]> = [];
  const fromCalls: string[] = [];

  const builder = {
    select(columns: string, options?: unknown) {
      selectCalls.push([columns, options]);
      return builder;
    },
    eq(column: string, value: string) {
      eqCalls.push([column, value]);
      return builder;
    },
    gte(column: string, value: string): Promise<BulkSuppressionCountQuery> {
      gteCalls.push([column, value]);
      return Promise.resolve(result);
    },
  };

  const client: BulkSuppressionSupabaseClient = {
    from(table) {
      fromCalls.push(table);
      return builder as unknown as ReturnType<BulkSuppressionSupabaseClient["from"]>;
    },
  };

  return {
    client,
    spies: {
      from: vi.fn((table: string) => fromCalls.push(table)),
      select: vi.fn((c: string, o: unknown) => selectCalls.push([c, o])),
      eq: vi.fn((c: string, v: string) => eqCalls.push([c, v])),
      gte: vi.fn((c: string, v: string) => gteCalls.push([c, v])),
    },
  };
}

describe("shouldSuppressBulkHold — contract constants", () => {
  it("matches plan §Bulk hold suppression threshold + window", () => {
    expect(BULK_HOLD_SUPPRESSION_CONTRACT.threshold).toBe(10);
    expect(BULK_HOLD_SUPPRESSION_CONTRACT.window_minutes).toBe(15);
  });

  it("suppressible_reasons is fetch_incomplete_at_match only", () => {
    expect(BULK_HOLD_SUPPRESSION_CONTRACT.suppressible_reasons).toEqual([
      "fetch_incomplete_at_match",
    ]);
  });
});

describe("shouldSuppressBulkHold — non-suppressible reasons short-circuit", () => {
  const nonSuppressible: BulkSuppressionHoldReason[] = [
    "unknown_remote_sku",
    "placeholder_remote_sku",
    "non_warehouse_match",
  ];

  for (const reason of nonSuppressible) {
    it(`returns {suppress:false} without hitting the DB for ${reason}`, async () => {
      const { client } = makeMockSupabase({ count: 999, error: null });
      const result = await shouldSuppressBulkHold(client, {
        workspaceId: "ws-1",
        connectionId: "conn-1",
        reason,
      });

      expect(result.suppress).toBe(false);
      expect(result.recent_count).toBe(0);
      expect(result.ops_alert_required).toBe(false);
    });
  }
});

describe("shouldSuppressBulkHold — fetch_incomplete_at_match window math", () => {
  it("suppresses when count >= threshold", async () => {
    const { client } = makeMockSupabase({ count: 10, error: null });
    const result = await shouldSuppressBulkHold(client, {
      workspaceId: "ws-1",
      connectionId: "conn-1",
      reason: "fetch_incomplete_at_match",
    });

    expect(result.suppress).toBe(true);
    expect(result.recent_count).toBe(10);
    expect(result.ops_alert_required).toBe(true);
    expect(result.threshold).toBe(10);
    expect(result.window_minutes).toBe(15);
  });

  it("does NOT suppress when count == threshold-1", async () => {
    const { client } = makeMockSupabase({ count: 9, error: null });
    const result = await shouldSuppressBulkHold(client, {
      workspaceId: "ws-1",
      connectionId: "conn-1",
      reason: "fetch_incomplete_at_match",
    });

    expect(result.suppress).toBe(false);
    expect(result.recent_count).toBe(9);
    expect(result.ops_alert_required).toBe(false);
  });

  it("treats count=null as 0", async () => {
    const { client } = makeMockSupabase({ count: null, error: null });
    const result = await shouldSuppressBulkHold(client, {
      workspaceId: "ws-1",
      connectionId: "conn-1",
      reason: "fetch_incomplete_at_match",
    });

    expect(result.suppress).toBe(false);
    expect(result.recent_count).toBe(0);
  });

  it("scopes the windowStart exactly 15 minutes back from nowMs", async () => {
    const gteValues: string[] = [];
    const builder = {
      select() {
        return builder;
      },
      eq() {
        return builder;
      },
      gte(_col: string, v: string): Promise<BulkSuppressionCountQuery> {
        gteValues.push(v);
        return Promise.resolve({ count: 0, error: null });
      },
    };
    const client: BulkSuppressionSupabaseClient = {
      from() {
        return builder as unknown as ReturnType<BulkSuppressionSupabaseClient["from"]>;
      },
    };

    const pinned = Date.UTC(2026, 3, 26, 12, 0, 0);
    await shouldSuppressBulkHold(
      client,
      {
        workspaceId: "ws-1",
        connectionId: "conn-1",
        reason: "fetch_incomplete_at_match",
      },
      pinned,
    );

    expect(gteValues).toHaveLength(1);
    const sent = Date.parse(gteValues[0] ?? "");
    expect(pinned - sent).toBe(15 * 60_000);
  });
});

describe("shouldSuppressBulkHold — error handling (fail-open)", () => {
  it("returns suppress:false on DB error so alerts are never blocked by a transient query failure", async () => {
    const { client } = makeMockSupabase({
      count: null,
      error: { message: "connection timeout" },
    });
    const result = await shouldSuppressBulkHold(client, {
      workspaceId: "ws-1",
      connectionId: "conn-1",
      reason: "fetch_incomplete_at_match",
    });

    expect(result.suppress).toBe(false);
    expect(result.recent_count).toBe(0);
    expect(result.ops_alert_required).toBe(false);
  });
});

describe("shouldSuppressBulkHold — column selection is correct", () => {
  it("filters on workspace_id, connection_id, event_type=hold_applied, hold_reason", async () => {
    const eqValues: Array<[string, string]> = [];
    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: string) {
        eqValues.push([col, val]);
        return builder;
      },
      gte(): Promise<BulkSuppressionCountQuery> {
        return Promise.resolve({ count: 5, error: null });
      },
    };
    const client: BulkSuppressionSupabaseClient = {
      from() {
        return builder as unknown as ReturnType<BulkSuppressionSupabaseClient["from"]>;
      },
    };

    await shouldSuppressBulkHold(client, {
      workspaceId: "ws-ABC",
      connectionId: "conn-XYZ",
      reason: "fetch_incomplete_at_match",
    });

    expect(eqValues).toEqual([
      ["workspace_id", "ws-ABC"],
      ["connection_id", "conn-XYZ"],
      ["event_type", "hold_applied"],
      ["hold_reason", "fetch_incomplete_at_match"],
    ]);
  });
});
