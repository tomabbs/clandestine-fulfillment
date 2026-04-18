#!/usr/bin/env node
/**
 * Add baseline_qty and baseline_description to the Bandcamp catalog CSV by fuzzy title match
 * (no UPC). Compares normalized tokens + coverage of significant words from the baseline line.
 *
 * Usage:
 *   node scripts/enrich-catalog-with-baseline-by-title.mjs [catalogCsv] [baselineCsv] [outPrefix]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { parseCsv } from "./bandcamp-sales-item-url.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "in",
  "on",
  "at",
  "to",
  "of",
  "lp",
  "2lp",
  "3cs",
  "2cs",
  "cs",
  "ep",
  "cd",
  "vinyl",
  "cassette",
  "record",
]);

function normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[–—\-_/]/g, " ")
    .replace(/[''`´˶°]/g, "")
    .replace(/\(no upc[^)]*\)/gi, " ")
    .replace(/\(require assembly\)/gi, " ")
    .replace(/\b\d{12,14}\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  const n = normalizeForMatch(s);
  const parts = n.split(/\s+/).filter((w) => w.length >= 2);
  return parts.filter((w) => !STOP.has(w));
}

function tokenSet(str) {
  return new Set(tokens(str));
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter++;
  }
  const u = a.size + b.size - inter;
  return u === 0 ? 0 : inter / u;
}

/** Fraction of baseline significant tokens (len>3) that appear as substrings in catalog haystack. */
function coverage(haystackNorm, baselineDesc) {
  const raw = tokens(baselineDesc);
  const sig = raw.filter((w) => w.length > 3);
  if (sig.length === 0) {
    const t = raw.filter((w) => w.length > 2);
    if (t.length === 0) return 0;
    let hit = 0;
    for (const w of t) {
      if (haystackNorm.includes(w)) hit++;
    }
    return hit / t.length;
  }
  let hit = 0;
  for (const w of sig) {
    if (haystackNorm.includes(w)) hit++;
  }
  return hit / sig.length;
}

function missingDistinctivePenalty(haystackNorm, baselineDesc) {
  const longs = tokens(baselineDesc).filter((w) => w.length >= 5);
  if (longs.length === 0) return 1;
  let miss = 0;
  for (const w of longs) {
    if (!haystackNorm.includes(w)) miss++;
  }
  return Math.max(0.2, 1 - 0.14 * miss);
}

function combinedScore(catalogHaystack, baselineDesc) {
  const h = normalizeForMatch(catalogHaystack);
  const A = tokenSet(catalogHaystack);
  const B = tokenSet(baselineDesc);
  const jac = jaccard(A, B);
  const cov = coverage(h, baselineDesc);
  const sub =
    h.includes(normalizeForMatch(baselineDesc)) ||
    normalizeForMatch(baselineDesc).includes(h)
      ? 0.12
      : 0;
  const base = Math.min(1, 0.28 * jac + 0.6 * cov + sub);
  return base * missingDistinctivePenalty(h, baselineDesc);
}

function loadBaseline(baselinePath) {
  const text = fs.readFileSync(baselinePath, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`Empty baseline: ${baselinePath}`);
  const header = rows[0].map((h) => h.trim());
  const iq = header.indexOf("baseline_qty");
  const id = header.indexOf("description");
  if (iq < 0 || id < 0) {
    throw new Error("baseline CSV needs baseline_qty and description columns");
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const qty = String(line[iq] ?? "").trim();
    const desc = String(line[id] ?? "").trim();
    if (!desc) continue;
    out.push({ baseline_qty: qty, baseline_description: desc });
  }
  const byKey = new Map();
  for (const row of out) {
    const k = normalizeForMatch(row.baseline_description);
    if (!byKey.has(k)) byKey.set(k, row);
  }
  return [...byKey.values()];
}

function formatHintMultiplier(baselineDesc, catalogFormat, artistTitle) {
  const b = baselineDesc.toLowerCase();
  const f = (catalogFormat || "").toLowerCase();
  const t = (artistTitle || "").toLowerCase();
  const baselineLooksLp =
    /\b(lp|2lp|vinyl)\b/.test(b) || /\bvinyl\b/.test(b);
  const baselineLooksCs =
    /\b(cs|cassette|3cs)\b/.test(b) || b.includes("cassette");
  const catalogLooksVinyl =
    /vinyl|record/.test(f) || /\bvinyl\b/.test(t) || /\blp\b/.test(t);
  const catalogLooksTape =
    f.includes("cassette") || /\bcassette\b/.test(t) || /\bcs\b/.test(t);

  let m = 1;
  if (catalogLooksVinyl && baselineLooksCs && !baselineLooksLp) m *= 0.42;
  if (catalogLooksTape && baselineLooksLp && !baselineLooksCs) m *= 0.42;
  if (catalogLooksVinyl && baselineLooksLp) m *= 1.06;
  if (catalogLooksTape && baselineLooksCs) m *= 1.06;
  return m;
}

function findBestBaseline(catalogHaystack, baselines, catalogFormat, artistTitle) {
  const scored = baselines.map((b) => ({
    ...b,
    score:
      combinedScore(catalogHaystack, b.baseline_description) *
      formatHintMultiplier(b.baseline_description, catalogFormat, artistTitle),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1]?.score ?? 0;

  if (!best) {
    return { status: "NONE", baseline_qty: "", baseline_description: "", score: 0 };
  }
  const MIN = 0.33;
  const GAP = 0.055;
  if (best.score < MIN) {
    return {
      status: "NONE",
      baseline_qty: "",
      baseline_description: "",
      score: best.score,
    };
  }
  if (second >= best.score - GAP && second >= MIN * 0.82) {
    return {
      status: "AMBIGUOUS",
      baseline_qty: best.baseline_qty,
      baseline_description: best.baseline_description,
      score: best.score,
    };
  }
  return {
    status: "MATCHED",
    baseline_qty: best.baseline_qty,
    baseline_description: best.baseline_description,
    score: best.score,
  };
}

function csvEscape(s) {
  if (s == null || s === undefined) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function main() {
  const day = new Date().toISOString().slice(0, 10);
  const catalogPath = path.resolve(
    process.argv[2] ||
      path.join(
        repoRoot,
        "reports",
        "leaving-records-bandcamp-catalog-from-sheet-2026-04-14.csv",
      ),
  );
  const baselinePath = path.resolve(
    process.argv[3] ||
      path.join(
        repoRoot,
        "reports",
        "leaving-records-baseline-upc-shipped-20260413.csv",
      ),
  );
  const outPrefix =
    process.argv[4] ||
    path.join(
      repoRoot,
      "reports",
      `leaving-records-bandcamp-catalog-with-baseline-${day}`,
    );

  const baselines = loadBaseline(baselinePath);
  const catalogText = fs.readFileSync(catalogPath, "utf8");
  const rows = parseCsv(catalogText);
  if (rows.length < 2) throw new Error(`Empty catalog: ${catalogPath}`);
  const header = rows[0];
  const idx = (name) => header.indexOf(name);
  const iArtist = idx("artist_title");
  const iRaw = idx("raw_title_from_export");
  const iFormat = idx("format");
  if (iArtist < 0 || iRaw < 0) {
    throw new Error("catalog needs artist_title and raw_title_from_export");
  }

  const extraCols = [
    "baseline_qty",
    "baseline_description",
    "baseline_match_score",
    "baseline_match_status",
  ];
  const outHeader = [...header.filter((h) => !extraCols.includes(h)), ...extraCols];

  const outRows = [outHeader];
  let matched = 0;
  let none = 0;
  let amb = 0;

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const artistTitle = line[iArtist] ?? "";
    const raw = line[iRaw] ?? "";
    const fmt = iFormat >= 0 ? line[iFormat] ?? "" : "";
    const haystack = `${artistTitle} ${raw}`;
    const result = findBestBaseline(haystack, baselines, fmt, artistTitle);

    const rowObj = {};
    for (let c = 0; c < header.length; c++) {
      if (!extraCols.includes(header[c])) rowObj[header[c]] = line[c] ?? "";
    }

    if (result.status === "MATCHED") matched++;
    else if (result.status === "AMBIGUOUS") amb++;
    else none++;

    const newLine = outHeader.map((h) => {
      if (h === "baseline_qty") return result.baseline_qty;
      if (h === "baseline_description") return result.baseline_description;
      if (h === "baseline_match_score")
        return result.score ? result.score.toFixed(3) : "";
      if (h === "baseline_match_status") return result.status;
      return rowObj[h] ?? "";
    });
    outRows.push(newLine);
  }

  const csv =
    outRows.map((line) => line.map((c) => csvEscape(c)).join(",")).join("\n") + "\n";
  const csvPath = `${outPrefix}.csv`;
  fs.writeFileSync(csvPath, csv, "utf8");

  const outWb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(outRows);
  XLSX.utils.book_append_sheet(outWb, ws, "Catalog + baseline");
  const xlsxPath = `${outPrefix}.xlsx`;
  XLSX.writeFile(outWb, xlsxPath);

  const readme = `Catalog + baseline (title match only)

Catalog: ${path.basename(catalogPath)}
Baseline: ${path.basename(baselinePath)}

New columns:
  baseline_qty — from baseline spreadsheet row when title match is strong enough.
  baseline_description — label baseline line (for reconciliation).
  baseline_match_score — 0–1 combined token/coverage score.
  baseline_match_status — MATCHED | NONE | AMBIGUOUS (two baselines scored similarly).

Matching does not use UPC. LP/CS hints use the catalog format column + title text to separate LP vs cassette baseline lines for the same album. Verify AMBIGUOUS and NONE rows manually.

Summary:
  MATCHED:    ${matched}
  NONE:       ${none}
  AMBIGUOUS:  ${amb}

Files: ${path.basename(csvPath)}, ${path.basename(xlsxPath)}
`;

  fs.writeFileSync(`${outPrefix}-README.txt`, readme, "utf8");

  console.log(readme);
}

main();
