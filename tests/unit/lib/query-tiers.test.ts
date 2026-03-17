import { describe, expect, it } from "vitest";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

describe("CACHE_TIERS", () => {
  it("REALTIME staleTime < SESSION staleTime < STABLE staleTime", () => {
    expect(CACHE_TIERS.REALTIME.staleTime).toBeLessThan(CACHE_TIERS.SESSION.staleTime);
    expect(CACHE_TIERS.SESSION.staleTime).toBeLessThan(CACHE_TIERS.STABLE.staleTime);
  });

  it("REALTIME has refetchInterval set", () => {
    expect(CACHE_TIERS.REALTIME.refetchInterval).toBeDefined();
    expect(CACHE_TIERS.REALTIME.refetchInterval).toBeGreaterThan(0);
  });

  it("SESSION does not have refetchInterval", () => {
    expect("refetchInterval" in CACHE_TIERS.SESSION).toBe(false);
  });

  it("STABLE does not have refetchInterval", () => {
    expect("refetchInterval" in CACHE_TIERS.STABLE).toBe(false);
  });
});
