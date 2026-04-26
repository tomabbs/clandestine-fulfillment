/**
 * Autonomous SKU matcher — stock-reliability unit tests.
 *
 * Contract under test (plan §"Stock signal reliability tiers" +
 * §"Clock-skew handling" + release gates SKU-AUTO-20, SKU-AUTO-24):
 *   - `authoritative` tier for warehouse signals (always).
 *   - `fresh_remote_unbounded` requires explicit isUnbounded=true; large
 *     integers never fake unboundedness.
 *   - Freshness tiers cross thresholds at 15min and 60min local age.
 *   - Clock skew > 1 hour hard-caps to `cached_only`.
 *   - Missing observedAtLocal ⇒ `unknown` tier.
 *   - `atpOf()` subtracts committed + safety stock for authoritative
 *     signals and returns null for unbounded / cached_only / unknown.
 *   - `isStockStableFor()` requires every reading in window to match
 *     the current value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atpOf,
  classifyStockTier,
  computeFreshness,
  isStockStableFor,
  type StockSignal,
} from "@/lib/server/stock-reliability";

const EPOCH = new Date("2026-04-26T12:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});

afterEach(() => {
  vi.useRealTimers();
});

function minAgoIso(mins: number): string {
  return new Date(EPOCH - mins * 60_000).toISOString();
}

describe("classifyStockTier", () => {
  it("returns authoritative for warehouse signals", () => {
    const sig: StockSignal = {
      value: 5,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "warehouse_inventory_levels",
      tier: "unknown",
    };
    expect(classifyStockTier(sig)).toBe("authoritative");
  });

  it("returns fresh_remote_unbounded only when isUnbounded=true", () => {
    const unbounded: StockSignal = {
      value: null,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "squarespace_api",
      tier: "unknown",
      isUnbounded: true,
    };
    expect(classifyStockTier(unbounded)).toBe("fresh_remote_unbounded");

    const largeInteger: StockSignal = {
      value: 999_999,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "squarespace_api",
      tier: "unknown",
    };
    expect(classifyStockTier(largeInteger)).toBe("fresh_remote");
  });

  it("fresh_remote for <15min local age", () => {
    const sig: StockSignal = {
      value: 3,
      observedAt: minAgoIso(5),
      observedAtLocal: minAgoIso(5),
      source: "shopify_graphql",
      tier: "unknown",
    };
    expect(classifyStockTier(sig)).toBe("fresh_remote");
  });

  it("remote_stale for 15-60min local age", () => {
    const sig: StockSignal = {
      value: 3,
      observedAt: minAgoIso(30),
      observedAtLocal: minAgoIso(30),
      source: "shopify_graphql",
      tier: "unknown",
    };
    expect(classifyStockTier(sig)).toBe("remote_stale");
  });

  it("cached_only for >60min local age", () => {
    const sig: StockSignal = {
      value: 3,
      observedAt: minAgoIso(90),
      observedAtLocal: minAgoIso(90),
      source: "shopify_graphql",
      tier: "unknown",
    };
    expect(classifyStockTier(sig)).toBe("cached_only");
  });

  it("unknown when observedAtLocal is missing", () => {
    const sig: StockSignal = {
      value: 3,
      observedAt: minAgoIso(0),
      observedAtLocal: null,
      source: "shopify_graphql",
      tier: "unknown",
    };
    expect(classifyStockTier(sig)).toBe("unknown");
  });

  it("clock skew >1h hard-caps to cached_only even if local age is fresh", () => {
    const sig: StockSignal = {
      // Remote clock claims the read happened 90 minutes in the future
      // (WordPress NTP broken scenario). Local clock says we fetched
      // 2 minutes ago.
      value: 3,
      observedAt: new Date(EPOCH + 90 * 60_000).toISOString(),
      observedAtLocal: minAgoIso(2),
      source: "woocommerce_rest",
      tier: "unknown",
    };
    expect(classifyStockTier(sig)).toBe("cached_only");
  });

  it("skew >5min but <1h falls back to local clock for the freshness bucket", () => {
    const sig: StockSignal = {
      value: 3,
      // Remote claims 20 minutes ago; local says 3 minutes ago.
      observedAt: minAgoIso(20),
      observedAtLocal: minAgoIso(3),
      source: "woocommerce_rest",
      tier: "unknown",
    };
    expect(classifyStockTier(sig)).toBe("fresh_remote");
  });
});

describe("computeFreshness", () => {
  it("trusts the local clock when no remote timestamp is available", () => {
    const sig: StockSignal = {
      value: 3,
      observedAt: null,
      observedAtLocal: minAgoIso(10),
      source: "shopify_graphql",
      tier: "unknown",
    };
    const f = computeFreshness(sig);
    expect(f.trustClock).toBe("local");
    expect(f.freshnessMs).toBe(10 * 60_000);
    expect(f.clockSkewMs).toBe(0);
  });

  it("trusts the remote clock when skew <=5 min", () => {
    const sig: StockSignal = {
      value: 3,
      observedAt: minAgoIso(3),
      observedAtLocal: minAgoIso(2),
      source: "shopify_graphql",
      tier: "unknown",
    };
    const f = computeFreshness(sig);
    expect(f.trustClock).toBe("remote");
  });

  it("returns neither when observedAtLocal is missing", () => {
    const sig: StockSignal = {
      value: 3,
      observedAt: minAgoIso(0),
      observedAtLocal: null,
      source: "shopify_graphql",
      tier: "unknown",
    };
    const f = computeFreshness(sig);
    expect(f.trustClock).toBe("neither");
  });
});

describe("atpOf", () => {
  it("subtracts committed + safetyStock from authoritative warehouse signals", () => {
    const sig: StockSignal = {
      value: 10,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "warehouse_inventory_levels",
      tier: "authoritative",
    };
    expect(atpOf(sig, 3, 2)).toBe(5);
  });

  it("clamps to zero rather than returning negative ATP", () => {
    const sig: StockSignal = {
      value: 5,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "warehouse_inventory_levels",
      tier: "authoritative",
    };
    expect(atpOf(sig, 10, 5)).toBe(0);
  });

  it("returns raw value (non-negative) for fresh_remote", () => {
    const sig: StockSignal = {
      value: 4,
      observedAt: minAgoIso(5),
      observedAtLocal: minAgoIso(5),
      source: "shopify_graphql",
      tier: "fresh_remote",
    };
    expect(atpOf(sig, 0)).toBe(4);
  });

  it("returns null for unbounded", () => {
    const sig: StockSignal = {
      value: null,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "squarespace_api",
      tier: "fresh_remote_unbounded",
      isUnbounded: true,
    };
    expect(atpOf(sig, 0)).toBeNull();
  });

  it("returns null for cached_only / unknown (never a large fake number)", () => {
    const cached: StockSignal = {
      value: 999_999,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "cache",
      tier: "cached_only",
    };
    expect(atpOf(cached, 0)).toBeNull();
  });
});

describe("isStockStableFor", () => {
  it("returns false when history is empty", () => {
    const sig: StockSignal = {
      value: 4,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "shopify_graphql",
      tier: "fresh_remote",
    };
    expect(isStockStableFor("tiebreak", sig, { readings: [] })).toBe(false);
  });

  it("returns true when every reading in tiebreak window matches", () => {
    const sig: StockSignal = {
      value: 4,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "shopify_graphql",
      tier: "fresh_remote",
    };
    const history = {
      readings: [
        { observedAt: minAgoIso(30), value: 4 },
        { observedAt: minAgoIso(120), value: 4 },
        { observedAt: minAgoIso(230), value: 4 },
      ],
    };
    expect(isStockStableFor("tiebreak", sig, history)).toBe(true);
  });

  it("returns false when any reading in window disagrees", () => {
    const sig: StockSignal = {
      value: 4,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "shopify_graphql",
      tier: "fresh_remote",
    };
    const history = {
      readings: [
        { observedAt: minAgoIso(30), value: 4 },
        { observedAt: minAgoIso(120), value: 3 },
      ],
    };
    expect(isStockStableFor("tiebreak", sig, history)).toBe(false);
  });

  it("ignores readings older than the window", () => {
    const sig: StockSignal = {
      value: 4,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "shopify_graphql",
      tier: "fresh_remote",
    };
    // Only the out-of-window (5h old) reading disagrees.
    const history = {
      readings: [
        { observedAt: minAgoIso(30), value: 4 },
        { observedAt: minAgoIso(5 * 60), value: 3 },
      ],
    };
    expect(isStockStableFor("tiebreak", sig, history)).toBe(true);
  });

  it("unbounded signals never stabilize (no numeric tiebreak)", () => {
    const sig: StockSignal = {
      value: null,
      observedAt: minAgoIso(0),
      observedAtLocal: minAgoIso(0),
      source: "squarespace_api",
      tier: "fresh_remote_unbounded",
      isUnbounded: true,
    };
    expect(isStockStableFor("tiebreak", sig, { readings: [] })).toBe(false);
  });
});
