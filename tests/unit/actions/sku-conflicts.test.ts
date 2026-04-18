import { describe, expect, it } from "vitest";

/**
 * Phase 0.5 — Server Action smoke tests for `src/actions/sku-conflicts.ts`.
 *
 * These are intentionally narrow: the actions are thin wrappers around
 * Supabase queries and `tasks.trigger()`, both of which are already
 * exercised by their own contract tests elsewhere. The value here is
 * Rule #6 (every Server Action file MUST have a companion .test.ts file)
 * and a tripwire on the public surface — if a future refactor renames
 * an exported action, this test file fails fast.
 */

describe("sku-conflicts Server Actions surface", () => {
  it("exports the expected action names", async () => {
    const mod = await import("@/actions/sku-conflicts");
    expect(typeof mod.listSkuConflicts).toBe("function");
    expect(typeof mod.getSkuConflict).toBe("function");
    expect(typeof mod.applyAliasResolution).toBe("function");
    expect(typeof mod.ignoreSkuConflict).toBe("function");
    expect(typeof mod.listClientSkuMismatches).toBe("function");
    expect(typeof mod.suggestCanonicalSku).toBe("function");
  });
});
