#!/usr/bin/env tsx
/**
 * Phase 4e (finish-line plan v4) — InventorySource ↔ DB CHECK constraint sync guard.
 *
 * Background: When Saturday Workstream 2 (2026-04-18) added `manual_inventory_count`
 * and `cycle_count` to `InventorySource`, the corresponding migration
 * (`20260418000001_phase4b_megaplan_closeout_and_count_session.sql`) extended
 * `warehouse_inventory_activity_source_check` simultaneously. If a future PR
 * widens the union without touching the migration (or vice versa), production
 * inserts will fail at runtime — silent during development if no one writes a
 * row of the new source kind.
 *
 * This script catches that drift at release-gate time:
 *   1. Parse the `InventorySource` discriminated-string union from
 *      `src/lib/shared/types.ts` by lifting the literal strings between the
 *      union's leading `=` and trailing `;`.
 *   2. Walk every migration in `supabase/migrations/*.sql` in name order
 *      (alphanumeric matches deploy order). Track the most recent definition
 *      of `warehouse_inventory_activity_source_check` — drop OR add — so we
 *      end up with the constraint that's live in production today.
 *   3. Compare the two sets. Any drift — TS-only or DB-only — exits non-zero
 *      and prints a remediation message naming the offending values.
 *
 * Wire into release-gate.sh as Section A's "Source-union sync guard".
 *
 * Usage: pnpm tsx scripts/check-source-union-sync.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const TYPES_FILE = join(REPO_ROOT, "src/lib/shared/types.ts");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase/migrations");
const CONSTRAINT_NAME = "warehouse_inventory_activity_source_check";

function parseTsUnion(): Set<string> {
  const text = readFileSync(TYPES_FILE, "utf8");
  const decl = "export type InventorySource";
  const start = text.indexOf(decl);
  if (start < 0) throw new Error(`InventorySource declaration not found in ${TYPES_FILE}`);
  const eq = text.indexOf("=", start);
  const semi = text.indexOf(";", eq);
  if (eq < 0 || semi < 0) throw new Error("InventorySource declaration has no terminating ';'.");
  const body = text.slice(eq + 1, semi);
  const matches = body.match(/"([^"\\]+)"/g) ?? [];
  if (matches.length === 0) throw new Error("InventorySource union has zero string literals.");
  return new Set(matches.map((m) => m.slice(1, -1)));
}

function parseLatestConstraint(): { values: Set<string>; sourceFile: string } | null {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let lastDefinition: { values: Set<string>; sourceFile: string } | null = null;

  for (const file of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (!text.includes(CONSTRAINT_NAME)) continue;

    const addPattern = new RegExp(
      `add\\s+constraint\\s+${CONSTRAINT_NAME}[\\s\\S]*?check\\s*\\(\\s*source\\s+in\\s*\\(([\\s\\S]*?)\\)\\s*\\)`,
      "gi",
    );

    let match: RegExpExecArray | null = null;
    let lastInFile: { body: string; sourceFile: string } | null = null;

    while (true) {
      match = addPattern.exec(text);
      if (match === null) break;
      lastInFile = { body: match[1], sourceFile: file };
    }

    if (lastInFile) {
      const literals = lastInFile.body.match(/'([^'\\]+)'/g) ?? [];
      if (literals.length === 0) {
        throw new Error(`Constraint definition in ${file} has zero string literals.`);
      }
      lastDefinition = {
        values: new Set(literals.map((l) => l.slice(1, -1))),
        sourceFile: file,
      };
    }
  }

  return lastDefinition;
}

function main() {
  const tsUnion = parseTsUnion();
  const constraint = parseLatestConstraint();

  if (!constraint) {
    console.error(`FAIL: no migration defines the ${CONSTRAINT_NAME} constraint.`);
    process.exit(1);
  }

  const tsOnly = Array.from(tsUnion)
    .filter((v) => !constraint.values.has(v))
    .sort();
  const dbOnly = Array.from(constraint.values)
    .filter((v) => !tsUnion.has(v))
    .sort();

  if (tsOnly.length === 0 && dbOnly.length === 0) {
    console.log(
      `OK: InventorySource (${tsUnion.size} values) matches ${CONSTRAINT_NAME} from ${constraint.sourceFile}.`,
    );
    process.exit(0);
  }

  console.error("FAIL: InventorySource ↔ DB CHECK constraint drift detected.");
  console.error(`  TS file:    ${TYPES_FILE}`);
  console.error(`  Migration:  supabase/migrations/${constraint.sourceFile}`);
  if (tsOnly.length > 0) {
    console.error(`  TS-only (extend the migration to add): ${tsOnly.join(", ")}`);
  }
  if (dbOnly.length > 0) {
    console.error(`  DB-only (extend InventorySource to add): ${dbOnly.join(", ")}`);
  }
  process.exit(1);
}

main();
