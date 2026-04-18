import { describe, expect, it } from "vitest";
import { DEFAULT_MUTEX_TTL_SEC, SAFE_RELEASE_LUA } from "@/trigger/lib/redis-mutex";

/**
 * Phase 0.5 contract tests for the per-resource Redis mutex helper.
 *
 * Network-touching tests live in the live-environment matrix; these are
 * source-level invariants that must NOT regress without an explicit
 * decision to reopen plan §7.1.10.
 */

describe("Redis mutex contract (plan §7.1.10 + Patch D1)", () => {
  it("default TTL is 120s — covers worst-case ShipStation v1 Retry-After (60s) + GET + PUT + verify", () => {
    expect(DEFAULT_MUTEX_TTL_SEC).toBe(120);
  });

  it("safe-release Lua compares stored value to caller's token before DEL", () => {
    // The script body is the structural contract that prevents a stale
    // owner from releasing the next holder's lock. Asserting the shape
    // explicitly so we'd catch a refactor that "simplified" it back to
    // an unsafe `redis.call('DEL', KEYS[1])`.
    expect(SAFE_RELEASE_LUA).toMatch(/redis\.call\('GET',\s*KEYS\[1\]\)\s*==\s*ARGV\[1\]/);
    expect(SAFE_RELEASE_LUA).toMatch(/redis\.call\('DEL',\s*KEYS\[1\]\)/);
  });

  it("safe-release Lua returns 0 (not nil) on token mismatch so caller can detect lost ownership", () => {
    expect(SAFE_RELEASE_LUA).toMatch(/return 0/);
  });
});
