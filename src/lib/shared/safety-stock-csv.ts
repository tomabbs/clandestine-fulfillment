/**
 * Phase 5 §9.6 D2 — minimal RFC 4180 CSV parser used by the Safety
 * Stock workspace. Lives outside any `"use server"` file because
 * Next.js 14 forbids non-async exports from server-action modules
 * (verified the hard way in commit f72f752 when build failed on
 * non-async constants in `connection-cutover.ts`).
 *
 * Intentionally NOT a full dialect-detecting CSV library — we control
 * the input format (`sku,safety_stock[,preorder_whitelist]`). Handles:
 *   • double-quoted fields
 *   • embedded commas + newlines inside quoted fields
 *   • doubled-quote escape (`""` → `"`)
 *   • CRLF, LF, and CR line endings
 *   • trailing whitespace + empty trailing lines (filtered out)
 *
 * Doesn't handle: BOM stripping (callers `.replace(/^\uFEFF/, '')`
 * if Excel-exported sheets are an issue), multi-byte separators,
 * or alternative quote characters.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && input[i + 1] === "\n") i += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}
