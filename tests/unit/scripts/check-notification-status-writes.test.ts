// Slice 2 — CI guard test for scripts/check-notification-status-writes.sh.
//
// Asserts the guard:
//   - Passes against the actual repo (regression test)
//   - Fails (exit 1) when an offending file is added under src/ outside the
//     allowlist (proves the guard would catch a future regression)
//
// We invoke the shell script directly rather than mocking ripgrep so the
// exact pattern matching the script does is what we test.
//
// REQUIRES: ripgrep (`rg`) on PATH. Tests are skipped when rg is missing
// (some sandboxed dev environments / CI matrices ship without it). The CI
// pipeline that runs `pnpm verify:cloud` does have rg installed.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts/check-notification-status-writes.sh");

const RG_AVAILABLE = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const describeIfRg = RG_AVAILABLE ? describe : describe.skip;

function runGuard(cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [SCRIPT], { cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as {
      status?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

describeIfRg("check-notification-status-writes.sh — repo regression", () => {
  it("passes against the live repo (no direct status writes outside the wrapper)", () => {
    const result = runGuard(REPO_ROOT);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/OK: No direct notification status/);
  });
});

describeIfRg("check-notification-status-writes.sh — proves it catches regressions", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "ci-guard-test-"));
    // Mirror the minimum repo structure the script needs to walk.
    mkdirSync(join(sandbox, "src/lib/server"), { recursive: true });
    mkdirSync(join(sandbox, "src/actions"), { recursive: true });
    mkdirSync(join(sandbox, "scripts"), { recursive: true });
    // Copy the script text into the sandbox so it runs there. We can't
    // execute the script in REPO_ROOT against a different src/ — the script
    // uses a relative `src/` path. Easier: copy it.
    const scriptContents = require("node:fs").readFileSync(SCRIPT, "utf8");
    const sandboxScript = join(sandbox, "scripts/check-notification-status-writes.sh");
    writeFileSync(sandboxScript, scriptContents);
    require("node:fs").chmodSync(sandboxScript, 0o755);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function runSandboxGuard() {
    return runGuard(sandbox);
  }

  it("PASSES on a clean sandbox (no offending files)", () => {
    const result = runSandboxGuard();
    expect(result.code).toBe(0);
  });

  it("FAILS when a server action writes notification_sends.status directly", () => {
    writeFileSync(
      join(sandbox, "src/actions/bad-status-write.ts"),
      `
import type { SupabaseClient } from "@supabase/supabase-js";
export async function bad(c: SupabaseClient, id: string) {
  return c.from("notification_sends").update({ status: "sent", error: null }).eq("id", id);
}
`,
    );
    const result = runSandboxGuard();
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Direct notification_sends\.status write/);
  });

  it("FAILS when the call ordering is swapped (.update first, .from later)", () => {
    writeFileSync(
      join(sandbox, "src/actions/bad-swap.ts"),
      `
export async function bad(client: any, id: string) {
  return client.update({ status: "delivered" }).from("notification_sends").eq("id", id);
}
`,
    );
    const result = runSandboxGuard();
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Direct notification_sends\.status write/);
  });

  it("FAILS when raw SQL UPDATE notification_sends SET status appears", () => {
    writeFileSync(
      join(sandbox, "src/actions/raw-sql.ts"),
      `
export async function bad(client: any) {
  return client.rpc("execute_sql", { sql: "UPDATE notification_sends SET status='sent' WHERE id='x'" });
}
`,
    );
    const result = runSandboxGuard();
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Raw SQL UPDATE notification_sends SET status/);
  });

  it("PASSES when the file is inside the allowlist (the wrapper itself can write)", () => {
    writeFileSync(
      join(sandbox, "src/lib/server/notification-status.ts"),
      `
export async function wrapper(c: any, id: string) {
  return c.from("notification_sends").update({ status: "sent" }).eq("id", id);
}
`,
    );
    const result = runSandboxGuard();
    expect(result.code).toBe(0);
  });
});
