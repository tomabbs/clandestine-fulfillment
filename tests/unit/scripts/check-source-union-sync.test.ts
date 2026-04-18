/**
 * Phase 4e (finish-line plan v4) — proves the source-union sync guard fails
 * on deliberately drifted input. We can't easily intercept the script's
 * filesystem reads from Vitest, so we shell out, write a temporary
 * malformed `types.ts` and `migrations/*.sql` pair to a sandbox dir, and
 * assert the script exits non-zero with the right diagnostic on each side
 * of the drift.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts/check-source-union-sync.ts");

function makeSandbox(): { cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "source-union-sync-test-"));
  mkdirSync(join(cwd, "src/lib/shared"), { recursive: true });
  mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
  return { cwd };
}

function writeTypes(cwd: string, values: string[]) {
  const literals = values.map((v) => `  | "${v}"`).join("\n");
  writeFileSync(
    join(cwd, "src/lib/shared/types.ts"),
    `export type InventorySource =\n${literals};\n`,
  );
}

function writeMigration(cwd: string, name: string, values: string[]) {
  const literals = values.map((v) => `'${v}'`).join(",");
  writeFileSync(
    join(cwd, "supabase/migrations", name),
    `alter table warehouse_inventory_activity\n` +
      `  add constraint warehouse_inventory_activity_source_check\n` +
      `  check (source in (${literals}));\n`,
  );
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

describe("check-source-union-sync drift detection", () => {
  it("passes when TS union and DB CHECK match exactly", () => {
    const { cwd } = makeSandbox();
    const values = ["shopify", "manual"];
    writeTypes(cwd, values);
    writeMigration(cwd, "20260101000000_init.sql", values);

    const result = runGuard(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/OK: InventorySource \(2 values\)/);
  });

  it("fails with TS-only diagnostic when union is wider than DB", () => {
    const { cwd } = makeSandbox();
    writeTypes(cwd, ["shopify", "manual", "new_source_in_ts"]);
    writeMigration(cwd, "20260101000000_init.sql", ["shopify", "manual"]);

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/TS-only.*new_source_in_ts/);
  });

  it("fails with DB-only diagnostic when DB is wider than union", () => {
    const { cwd } = makeSandbox();
    writeTypes(cwd, ["shopify", "manual"]);
    writeMigration(cwd, "20260101000000_init.sql", ["shopify", "manual", "extra_in_db"]);

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/DB-only.*extra_in_db/);
  });

  it("uses the LATEST migration that touches the constraint (later additions win)", () => {
    const { cwd } = makeSandbox();
    writeTypes(cwd, ["shopify", "manual", "added_later"]);
    writeMigration(cwd, "20260101000000_init.sql", ["shopify", "manual"]);
    writeMigration(cwd, "20260102000000_extend.sql", ["shopify", "manual", "added_later"]);

    const result = runGuard(cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/20260102000000_extend.sql/);
  });

  it("fails clearly when no migration defines the constraint", () => {
    const { cwd } = makeSandbox();
    writeTypes(cwd, ["shopify"]);

    const result = runGuard(cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no migration defines/);
  });
});
