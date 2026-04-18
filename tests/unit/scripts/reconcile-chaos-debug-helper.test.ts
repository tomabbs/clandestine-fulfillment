/**
 * Phase 5 (finish-line plan v4) reviewer A safety check — the reconcile-chaos
 * Redis bypass helper MUST NOT be exported from any production import path.
 * This test fails CI if a future refactor moves the helper into `src/`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve(__dirname, "../../../scripts/stress/reconcile-chaos.ts");

describe("reconcile-chaos.ts debug-bypass safety contract", () => {
  it("the gateRedisBypass helper is declared with `function` (not exported)", () => {
    const text = readFileSync(SCRIPT_PATH, "utf8");
    expect(text).toMatch(/function gateRedisBypass\(/);
    expect(text).not.toMatch(/export\s+(async\s+)?function\s+gateRedisBypass/);
    expect(text).not.toMatch(/export\s*{[^}]*gateRedisBypass/);
  });

  it("the script enforces both env var AND CLI flag before bypass", () => {
    const text = readFileSync(SCRIPT_PATH, "utf8");
    expect(text).toMatch(/STRESS_HARNESS\s*!==\s*"1"/);
    expect(text).toMatch(/forceFlag/);
  });

  it("the script never imports from `src/` (cannot accidentally re-export)", () => {
    const text = readFileSync(SCRIPT_PATH, "utf8");
    expect(text).not.toMatch(/from\s+["']@\/.*["']/);
    expect(text).not.toMatch(/from\s+["']\.\.\/\.\.\/src\//);
  });
});
