#!/usr/bin/env -S npx tsx
/**
 * CI guard: non-async-function exports from `"use server"` modules.
 *
 * Why this guard exists
 * ---------------------
 * Next.js React Server Components validate EVERY export of a file
 * carrying the `"use server"` directive at build time. Only `async
 * function` exports are legal at runtime; constants, synchronous
 * functions, classes, re-exports of values, `export default` of
 * non-async expressions, and `export *` are all rejected with:
 *
 *     Error: A "use server" file can only export async functions,
 *            found object.
 *     Failed to collect page data for <route>
 *
 * (see https://nextjs.org/docs/messages/invalid-use-server-value)
 *
 * TypeScript's own compiler and Biome do NOT know about this
 * contract — `pnpm check` and `pnpm typecheck` both pass on files
 * that will later blow up `next build`. The only pre-existing
 * signal is the final `pnpm build` step in CI, which is slow (~90s
 * in CI, longer locally), requires the full placeholder env, and
 * fails with a stacktrace that points at compiled `.next/server/*`
 * chunks rather than the offending source line.
 *
 * This guard runs in ~200ms and points at the exact source line.
 *
 * Type exports are always allowed — TypeScript erases them at
 * compile time and they never reach the runtime where Next.js
 * validates exports.
 *
 * History: this guard was added after fix commit `fee350c`
 * (2026-04-26), which cleaned up three pre-existing violations
 * (`src/actions/sku-identity-matches.ts`,
 * `src/actions/sku-autonomous-canary.ts`, and
 * `src/actions/support.ts` — the last of which had been a latent
 * bug on `main` since 2026-03-20 and only started breaking the
 * build once the Phase 6 admin SKU-auto route graph forced Next
 * to inspect those modules during page-data collection).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

interface Violation {
  file: string;
  line: number;
  detail: string;
}

const SRC_DIR = path.resolve(process.cwd(), "src");
const EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * Walk `src/` and collect every `.ts` / `.tsx` file path. We
 * deliberately scan the whole tree rather than only
 * `src/actions/` because Next.js supports `"use server"` at the
 * top of any module (including `src/lib/server/*` helpers and
 * inline action files inside route segments), and a future
 * refactor that moves a Server Action outside `src/actions/`
 * shouldn't silently lose this check.
 */
function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, acc);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * A file "has the use server directive" iff its first top-level
 * statement is a bare string-literal expression equal to
 * `"use server"`. We deliberately do NOT treat a mid-file or
 * nested `"use server"` (e.g. inside a function — which marks
 * that single function, not the module) as a module-level
 * directive.
 */
function hasUseServerDirective(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  if (!first || !ts.isExpressionStatement(first)) return false;
  const expr = first.expression;
  if (!ts.isStringLiteral(expr)) return false;
  return expr.text === "use server";
}

function getModifiers(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasExportModifier(node: ts.Node): boolean {
  return getModifiers(node).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isAsync(node: ts.Node): boolean {
  return getModifiers(node).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return line + 1;
}

/**
 * Classify every top-level statement and emit violations for
 * anything that Next.js RSC would reject.
 *
 * Allowed at the runtime boundary (no violation emitted):
 *   - `export async function ...`
 *   - `export default async function ...`
 *   - `export type ...` / `export interface ...`
 *   - `export type { ... } from "..."`
 *   - `export { type Foo }` (individually type-only specifier)
 *
 * Forbidden (violation emitted):
 *   - `export const | let | var ...`
 *   - `export function ...` without `async`
 *   - `export default function ...` without `async`
 *   - `export default <expr>` for any other expression
 *   - `export class ...`
 *   - `export enum ...` (regular or `const enum` — both emit JS)
 *   - `export namespace ...` / `export module ...`
 *   - `export { foo }` re-exports (without `type` prefix)
 *   - `export * from "..."`
 */
function findViolations(sf: ts.SourceFile): Violation[] {
  const violations: Violation[] = [];

  for (const stmt of sf.statements) {
    // `export { ... }` and `export * from "..."`
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;

      if (!stmt.exportClause) {
        violations.push({
          file: sf.fileName,
          line: lineOf(sf, stmt),
          detail: "`export *` re-export is not allowed (must be async function)",
        });
        continue;
      }

      if (ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          if (spec.isTypeOnly) continue;
          violations.push({
            file: sf.fileName,
            line: lineOf(sf, spec),
            detail: `\`export { ${spec.name.text} }\` — value re-export is not allowed (prefix with \`type\` or move to a non-\"use server\" module)`,
          });
        }
      } else if (ts.isNamespaceExport(stmt.exportClause)) {
        violations.push({
          file: sf.fileName,
          line: lineOf(sf, stmt),
          detail: "`export * as NS` re-export is not allowed",
        });
      }
      continue;
    }

    // `export default <expr>` / `export = <expr>`
    if (ts.isExportAssignment(stmt)) {
      const expr = stmt.expression;
      const isAsyncFn =
        (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) &&
        expr.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (!isAsyncFn) {
        violations.push({
          file: sf.fileName,
          line: lineOf(sf, stmt),
          detail: "`export default` of a non-async expression is not allowed",
        });
      }
      continue;
    }

    // `export function ...`
    if (ts.isFunctionDeclaration(stmt)) {
      if (!hasExportModifier(stmt)) continue;
      if (!isAsync(stmt)) {
        const name = stmt.name?.text ?? "<anonymous>";
        violations.push({
          file: sf.fileName,
          line: lineOf(sf, stmt),
          detail: `\`export function ${name}\` — missing \`async\` (every exported function in a \"use server\" module must be async)`,
        });
      }
      continue;
    }

    // `export const | let | var ...`
    if (ts.isVariableStatement(stmt)) {
      if (!hasExportModifier(stmt)) continue;
      const names = stmt.declarationList.declarations
        .map((d) => (ts.isIdentifier(d.name) ? d.name.text : "<pattern>"))
        .join(", ");
      const keyword =
        // biome-ignore lint/suspicious/noBitwiseOperators: reading TS node flags requires bitwise comparison, same pattern used across the TS compiler API
        (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
          ? "const"
          : // biome-ignore lint/suspicious/noBitwiseOperators: reading TS node flags requires bitwise comparison, same pattern used across the TS compiler API
            (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0
            ? "let"
            : "var";
      violations.push({
        file: sf.fileName,
        line: lineOf(sf, stmt),
        detail: `\`export ${keyword} ${names}\` — non-function exports are not allowed from \"use server\" modules (move to a non-\"use server\" module)`,
      });
      continue;
    }

    // `export class ...`
    if (ts.isClassDeclaration(stmt) && hasExportModifier(stmt)) {
      const name = stmt.name?.text ?? "<anonymous>";
      violations.push({
        file: sf.fileName,
        line: lineOf(sf, stmt),
        detail: `\`export class ${name}\` is not allowed`,
      });
      continue;
    }

    // `export enum ...` (both regular and `const enum` emit JS)
    if (ts.isEnumDeclaration(stmt) && hasExportModifier(stmt)) {
      violations.push({
        file: sf.fileName,
        line: lineOf(sf, stmt),
        detail: `\`export enum ${stmt.name.text}\` is not allowed`,
      });
      continue;
    }

    // `export namespace ...` / `export module ...`
    if (ts.isModuleDeclaration(stmt) && hasExportModifier(stmt)) {
      const name = ts.isIdentifier(stmt.name) ? stmt.name.text : stmt.name.text;
      violations.push({
        file: sf.fileName,
        line: lineOf(sf, stmt),
        detail: `\`export namespace ${name}\` is not allowed`,
      });
      continue;
    }

    // `export type ...` and `export interface ...` are always allowed
    // (TypeScript erases them).
  }

  return violations;
}

function main(): void {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`FAIL: src/ not found at ${SRC_DIR}`);
    process.exit(1);
  }

  const files = listSourceFiles(SRC_DIR);
  const violations: Violation[] = [];
  let serverModuleCount = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if (!hasUseServerDirective(sf)) continue;
    serverModuleCount++;
    violations.push(...findViolations(sf));
  }

  if (violations.length > 0) {
    console.error('FAIL: Non-async-function exports found in "use server" modules.');
    console.error("Next.js RSC rejects these at build time. See:");
    console.error("  https://nextjs.org/docs/messages/invalid-use-server-value");
    console.error("");
    for (const v of violations) {
      const rel = path.relative(process.cwd(), v.file);
      console.error(`  ${rel}:${v.line}  ${v.detail}`);
    }
    process.exit(1);
  }

  console.log(
    `OK: ${serverModuleCount} "use server" modules export only async functions + types.`,
  );
}

main();
