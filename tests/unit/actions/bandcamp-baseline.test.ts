import { describe, expect, it } from "vitest";
import * as bandcampBaseline from "@/actions/bandcamp-baseline";

/**
 * Phase 1 — smoke tests for the staff Server Actions surface.
 *
 * Full execution paths are not exercised here because the actions depend
 * on Next request scope (`requireAuth`) and Trigger.dev (`tasks.trigger`),
 * both of which require a runtime that's expensive to mock for a smoke
 * test. The purpose is to guarantee the public API stays exported with
 * the names the admin pages and Phase 1 doc-sync contract reference.
 */

describe("@/actions/bandcamp-baseline (public API)", () => {
  it("exports forceBaselineScan", () => {
    expect(typeof bandcampBaseline.forceBaselineScan).toBe("function");
  });

  it("exports setBandcampPushMode", () => {
    expect(typeof bandcampBaseline.setBandcampPushMode).toBe("function");
  });

  it("exports listBaselineAnomalies", () => {
    expect(typeof bandcampBaseline.listBaselineAnomalies).toBe("function");
  });
});
