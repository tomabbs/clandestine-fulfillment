/**
 * Companion test for `scripts/check-use-server-exports.ts` — the
 * CI guard that catches the `Next.js build` failure class
 *
 *     Error: A "use server" file can only export async functions,
 *            found object.
 *
 * before it reaches `next build`. See the script header for the
 * full motivation + history.
 *
 * We can't easily intercept the guard's filesystem reads from
 * Vitest, so we shell out to `npx tsx`, write fake source trees
 * to a tmpdir, point the script at that tmpdir via `cwd`, and
 * assert on exit code + stderr for each violation class and each
 * allowed pattern.
 *
 * This mirrors the pattern used by
 * `tests/unit/scripts/check-source-union-sync.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts/check-use-server-exports.ts");

function makeSandbox(): { cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "check-use-server-exports-test-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  return { cwd };
}

function writeFile(cwd: string, relPath: string, body: string): void {
  const full = join(cwd, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function runGuard(cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", SCRIPT], { cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

describe("check-use-server-exports guard", () => {
  it("passes on a clean tree with an async-function-only server action", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/ok.ts",
      `"use server";

export async function doThing(): Promise<number> {
  return 1;
}

export type DoThingResult = { value: number };
export interface DoThingInput { id: string }
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/OK: 1 "use server" modules/);
  });

  it('ignores files without a top-level "use server" directive', () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/lib/shared/utils.ts",
      `// Plain module — may legally export anything.
export const THE_ANSWER = 42;
export function helper() { return "ok"; }
export class Helper {}
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/OK: 0 "use server" modules/);
  });

  it('flags `export const` from a "use server" module', () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-const.ts",
      `"use server";

export const FORBIDDEN = 1;

export async function ok(): Promise<number> { return 1; }
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/`export const FORBIDDEN`/);
    expect(result.stderr).toMatch(/src\/actions\/bad-const\.ts:3/);
  });

  it("flags a non-async `export function`", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-sync-fn.ts",
      `"use server";

export function syncHelper(): number { return 1; }
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/`export function syncHelper` — missing `async`/);
  });

  it("flags `export { foo }` value re-exports", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-reexport.ts",
      `"use server";

export { somethingElse } from "./other";
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/`export \{ somethingElse \}`/);
    expect(result.stderr).toMatch(/value re-export is not allowed/);
  });

  it("allows `export type { Foo }` re-exports", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/ok-type-reexport.ts",
      `"use server";

export type { SomeType } from "./other";

export async function ok(): Promise<number> { return 1; }
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(0);
  });

  it('flags `export *` re-exports from "use server"', () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-star.ts",
      `"use server";

export * from "./other";
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/`export \*` re-export is not allowed/);
  });

  it("flags `export class`", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-class.ts",
      `"use server";

export class MyClass {}
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/`export class MyClass`/);
  });

  it("flags `export enum`", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-enum.ts",
      `"use server";

export enum Color { Red, Green, Blue }
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/`export enum Color`/);
  });

  it("flags `export default` of a non-async expression", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-default.ts",
      `"use server";

export default { handler: 1 };
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/`export default` of a non-async expression/);
  });

  it("allows `export default` of an async arrow function", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/ok-default-async.ts",
      `"use server";

export default async (x: number): Promise<number> => x + 1;
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(0);
  });

  it("reports multiple violations with distinct line numbers in one file", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/bad-multi.ts",
      `"use server";

export const A = 1;
export const B = 2;

export async function ok(): Promise<number> { return 1; }

export function sync() {}
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/src\/actions\/bad-multi\.ts:3/);
    expect(result.stderr).toMatch(/src\/actions\/bad-multi\.ts:4/);
    expect(result.stderr).toMatch(/src\/actions\/bad-multi\.ts:8/);
  });

  it('does NOT flag a "use server" that is not the first top-level statement', () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/actions/in-function.ts",
      `export const HELPER = 1;

export async function action() {
  "use server";
  return 1;
}
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(0);
  });

  it("scans deeply-nested subdirectories under src/", () => {
    const { cwd } = makeSandbox();
    writeFile(
      cwd,
      "src/app/admin/some/feature/page-actions.ts",
      `"use server";

export const BAD_NESTED = 1;
`,
    );

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/src\/app\/admin\/some\/feature\/page-actions\.ts:3.*BAD_NESTED/);
  });
});
