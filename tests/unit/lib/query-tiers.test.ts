import { describe, expect, it } from "vitest";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

describe("CACHE_TIERS", () => {
  it("REALTIME staleTime < SESSION staleTime < STABLE staleTime", () => {
    expect(CACHE_TIERS.REALTIME.staleTime).toBeLessThan(CACHE_TIERS.SESSION.staleTime);
    expect(CACHE_TIERS.SESSION.staleTime).toBeLessThan(CACHE_TIERS.STABLE.staleTime);
  });

  it("REALTIME gcTime < SESSION gcTime < STABLE gcTime", () => {
    expect(CACHE_TIERS.REALTIME.gcTime).toBeLessThan(CACHE_TIERS.SESSION.gcTime);
    expect(CACHE_TIERS.SESSION.gcTime).toBeLessThan(CACHE_TIERS.STABLE.gcTime);
  });

  it("REALTIME: staleTime 30s, gcTime 5min", () => {
    expect(CACHE_TIERS.REALTIME.staleTime).toBe(30_000);
    expect(CACHE_TIERS.REALTIME.gcTime).toBe(5 * 60_000);
  });

  it("SESSION: staleTime 5min, gcTime 30min", () => {
    expect(CACHE_TIERS.SESSION.staleTime).toBe(5 * 60_000);
    expect(CACHE_TIERS.SESSION.gcTime).toBe(30 * 60_000);
  });

  it("STABLE: staleTime 30min, gcTime 2hr", () => {
    expect(CACHE_TIERS.STABLE.staleTime).toBe(30 * 60_000);
    expect(CACHE_TIERS.STABLE.gcTime).toBe(2 * 60 * 60_000);
  });

  it("gcTime is always greater than staleTime for each tier", () => {
    for (const tier of Object.values(CACHE_TIERS)) {
      expect(tier.gcTime).toBeGreaterThan(tier.staleTime);
    }
  });
});
