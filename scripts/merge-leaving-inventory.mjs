#!/usr/bin/env node
/**
 * Merge leaving_inventory_with_links_artist_first (4).xlsx with our Bandcamp
 * merch list (leaving-merch-list.csv) + shipping log data.
 *
 * Matching: For each of the 121 inventory rows, find the ONE best match from
 * the 417 Bandcamp rows by:
 *   1. Base URL match (strip query params from Link)
 *   2. Format compatibility (LP/Vinyl ↔ VINYL, CS ↔ CASSETTE, etc.)
 *   3. Title similarity as tiebreaker
 *
 * Output:
 *   Tab 1 "Matched" — 121 rows, one per inventory item, with best Bandcamp match
 *   Tab 2 "Unmatched" — inventory items where URL matched but format didn't,
 *          or no URL match at all
 *   Tab 3 "All Bandcamp" — full 417 rows + shipped units (unfiltered)
 *
 * Usage:
 *   node scripts/merge-leaving-inventory.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_XLSX = path.join(
  "/Users/tomabbs/Downloads",
  "leaving_inventory_with_links_artist_first (4).xlsx"
);
const MY_CSV = path.join(__dirname, "output", "leaving-merch-list.csv");
const OUT_XLSX = path.join(__dirname, "output", "leaving-inventory-merged.xlsx");

// ── helpers ─────────────────────────────────────────────────────────────────

function stripQuery(url) {
  if (!url) return "";
  try { return new URL(url).origin + new URL(url).pathname; }
  catch { return url.split("?")[0].trim(); }
}

function norm(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Classify a format string into a canonical bucket.
 * Returns: "LP" | "CS" | "CD" | "7in" | "OTHER" | null
 */
function classifyFormat(text) {
  if (!text) return null;
  const t = text.toUpperCase();

  // Test pressing = vinyl, but we explicitly exclude it for matching purposes
  if (/TEST\s*PRESS/i.test(t)) return "TEST_PRESSING";

  if (/\bCASS(ETTE)?\b|\bTAPE\b|\bC80\b/.test(t)) return "CS";
  // Must check CS AFTER cassette, because "CS" also appears in artist names
  // Only match standalone CS at end of string or before punctuation
  if (/\bCS\b/.test(t) && !/\bCS\s+[-–—]/.test(t)) {
    // Make sure it's not part of an artist name by checking position
    // CS at end of string = format
    if (/\bCS\s*$/.test(t) || /\bCS\s*[,(]/.test(t)) return "CS";
  }

  if (/\b7["″']\b|\bSEVEN[\s-]?INCH\b/.test(t)) return "7in";
  if (/\bCD\b|\bCOMPACT\s*DISC\b/.test(t)) return "CD";
  if (/\bVINYL\b|\bLP\b|\b12["″']\b|\b2LP\b|\b2XLP\b|\bLATHE/i.test(t)) return "LP";

  return "OTHER";
}

/**
 * Extract the format from a Matthew Product Title.
 * Look at the END of the title (last word/token) to avoid "Andrew CS" false positives.
 */
function classifyMPT(mpt) {
  if (!mpt) return null;
  const t = mpt.trim();

  // Check last few tokens (format is almost always the last word)
  const lastChunk = t.slice(-30);

  if (/\bCS\s*\)?\s*$/i.test(t)) return "CS";
  if (/\b3CS\b/i.test(t)) return "CS";
  if (/\b2CS\b/i.test(t)) return "CS";
  if (/\bcassette\b/i.test(t)) return "CS";
  if (/\bLP\s*\)?\s*$/i.test(t)) return "LP";
  if (/\b2LP\b/i.test(t)) return "LP";
  if (/\bvinyl\b/i.test(lastChunk)) return "LP";
  if (/\bCD\s*\)?\s*$/i.test(t)) return "CD";
  if (/\b7"\s*$/i.test(t)) return "7in";

  return "OTHER";
}

/**
 * Classify a Bandcamp merch name into the same buckets.
 */
function classifyMerch(merchName) {
  return classifyFormat(merchName);
}

/**
 * Are two format buckets compatible for matching?
 */
function formatsCompatible(mptFmt, merchFmt) {
  if (!mptFmt || !merchFmt) return true; // if we can't classify, allow it
  if (mptFmt === "OTHER" || merchFmt === "OTHER") return true;

  // Test pressings should not match inventory items
  if (merchFmt === "TEST_PRESSING") return false;

  // Direct match
  if (mptFmt === merchFmt) return true;

  return false;
}

/**
 * Simple word overlap score for title matching (0–1).
 */
function titleSimilarity(a, b) {
  const wa = new Set(norm(a).split(/\s+/).filter(w => w.length > 1));
  const wb = new Set(norm(b).split(/\s+/).filter(w => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

/**
 * Parse "Artist - Album – MERCH" from Bandcamp Title column.
 */
function parseBandcampTitle(raw) {
  const t = String(raw ?? "").trim();
  const idx = t.lastIndexOf(" \u2013 ");
  if (idx === -1) return { albumPart: t, merchName: "" };
  return {
    albumPart: t.slice(0, idx).trim(),
    merchName: t.slice(idx + 3).trim(),
  };
}

// ── loaders ──────────────────────────────────────────────────────────────────

function loadMyCsv() {
  const wb = XLSX.readFile(MY_CSV);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}

function loadSourceXlsx() {
  const wb = XLSX.readFile(SOURCE_XLSX);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  return rows.filter((r) => r["Bandcamp Title"] || r["Matthew Product Title"]);
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log("Loading data…");
  const myRows = loadMyCsv();
  const invRows = loadSourceXlsx();
  console.log(`  Bandcamp merch list: ${myRows.length} rows`);
  console.log(`  Inventory sheet:     ${invRows.length} rows`);

  // Build URL index from my rows
  const byUrl = new Map();
  for (const r of myRows) {
    const key = stripQuery(r["Bandcamp URL"]);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(r);
  }

  // Track which my-rows get claimed (prevent double-assignment)
  const claimed = new Set();

  const matchedRows = [];
  const unmatchedRows = [];

  for (const inv of invRows) {
    const mpt = String(inv["Matthew Product Title"] ?? "").trim();
    const bcTitle = String(inv["Bandcamp Title"] ?? "").trim();
    const { merchName: theirMerch } = parseBandcampTitle(bcTitle);
    const invUrl = stripQuery(inv["Link"]);
    const mptFmt = classifyMPT(mpt);

    const candidates = (byUrl.get(invUrl) ?? []).filter((c) => !claimed.has(c["Bandcamp Item ID"]));

    // Classify each candidate and separate test pressings entirely
    const scored = [];
    const wrongFmt = [];

    for (const c of candidates) {
      const merchFmt = classifyMerch(c["Merch Name"]);

      // Skip test pressings entirely — user has no test pressings in inventory
      if (merchFmt === "TEST_PRESSING") continue;

      const fmtOk = formatsCompatible(mptFmt, merchFmt);
      const nameSim = titleSimilarity(theirMerch, c["Merch Name"]);
      const fullSim = titleSimilarity(
        mpt.replace(/\s+(LP|CS|CD|2LP|3CS|7")$/i, ""),
        `${c["Artist"]} - ${c["Album Title"]}`
      );

      if (fmtOk) {
        scored.push({ candidate: c, merchFmt, nameSim, fullSim });
      } else {
        wrongFmt.push({ candidate: c, merchFmt, nameSim, fullSim });
      }
    }

    // Sort compatible candidates by merch name similarity
    scored.sort((a, b) => b.nameSim - a.nameSim || b.fullSim - a.fullSim);

    const best = scored[0] ?? null;

    if (best) {
      claimed.add(best.candidate["Bandcamp Item ID"]);
      matchedRows.push(buildRow(inv, best.candidate, mptFmt, "matched"));
    } else if (wrongFmt.length > 0) {
      // URL matched but only incompatible formats exist (no cassette on a vinyl-only page, etc.)
      const fmtList = wrongFmt.map((w) => `${w.candidate["Merch Name"]} (${w.merchFmt})`).join(", ");
      const note = `URL matched but no ${mptFmt} format on Bandcamp page. Available: ${fmtList}`;
      unmatchedRows.push(buildRow(inv, wrongFmt[0].candidate, mptFmt, note));
    } else if (candidates.length > 0) {
      // All candidates were test pressings
      const note = `URL matched but only test pressings available on Bandcamp page`;
      unmatchedRows.push(buildRow(inv, candidates[0], mptFmt, note));
    } else {
      unmatchedRows.push(buildRow(inv, null, mptFmt, "No matching Bandcamp URL found"));
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`  Matched:   ${matchedRows.length}`);
  console.log(`  Unmatched: ${unmatchedRows.length}`);

  // Build a lookup of matched Bandcamp Item IDs → inventory data
  const matchedByItemId = new Map();
  for (const r of matchedRows) {
    if (r["Bandcamp Item ID"]) matchedByItemId.set(r["Bandcamp Item ID"], r);
  }

  const headers = [
    "Bandcamp SKU", "Artist", "Album Title", "Merch Name",
    "Stock on Bandcamp", "Bandcamp URL", "Bandcamp Item ID",
    "Quantity", "Matthew Product Title", "UPC",
    "Inventory Format", "Merch Format",
  ];

  // Tab 1 — "All Products": every Bandcamp row, with inventory columns filled in where matched
  const allProductRows = myRows.map((my) => {
    const inv = matchedByItemId.get(my["Bandcamp Item ID"]);
    return {
      "Bandcamp SKU":        my["Bandcamp SKU"] ?? "",
      "Artist":              my["Artist"] ?? "",
      "Album Title":         my["Album Title"] ?? "",
      "Merch Name":          my["Merch Name"] ?? "",
      "Stock on Bandcamp":   my["Stock on Bandcamp"] ?? "",
      "Bandcamp URL":        my["Bandcamp URL"] ?? "",
      "Bandcamp Item ID":    my["Bandcamp Item ID"] ?? "",
      "Quantity":            inv ? inv["Quantity"] : "",
      "Matthew Product Title": inv ? inv["Matthew Product Title"] : "",
      "UPC":                 inv ? inv["UPC"] : "",
      "Inventory Format":    inv ? inv["Inventory Format"] : "",
      "Merch Format":        inv ? inv["Merch Format"] : "",
    };
  });

  console.log(`  Tab 1: ${allProductRows.length} total rows (${matchedByItemId.size} with inventory data)`);

  const wb = XLSX.utils.book_new();

  const ws1 = XLSX.utils.json_to_sheet(allProductRows, { header: headers });
  autoSize(ws1, allProductRows, headers);
  XLSX.utils.book_append_sheet(wb, ws1, "All Products");

  // Tab 2 — "Unmatched Inventory": items from the 121 that couldn't be matched
  if (unmatchedRows.length > 0) {
    const unmatchedHeaders = [...headers, "Note"];
    const ws2 = XLSX.utils.json_to_sheet(unmatchedRows, { header: unmatchedHeaders });
    autoSize(ws2, unmatchedRows, unmatchedHeaders);
    XLSX.utils.book_append_sheet(wb, ws2, "Unmatched Inventory");
  }

  XLSX.writeFile(wb, OUT_XLSX);
  console.log(`\nWritten → ${OUT_XLSX}`);
}

function buildRow(inv, bc, mptFmt, note) {
  const merchFmt = bc ? classifyMerch(bc["Merch Name"]) : "";
  return {
    "Bandcamp SKU":       bc?.["Bandcamp SKU"] ?? "",
    "Artist":             bc?.["Artist"] ?? "",
    "Album Title":        bc?.["Album Title"] ?? "",
    "Merch Name":         bc?.["Merch Name"] ?? "",
    "Stock on Bandcamp":  bc?.["Stock on Bandcamp"] ?? "",
    "Bandcamp URL":       bc?.["Bandcamp URL"] ?? stripQuery(inv["Link"]),
    "Bandcamp Item ID":   bc?.["Bandcamp Item ID"] ?? "",
    "Quantity":           inv["Quantity shipped"] ?? "",
    "Matthew Product Title": inv["Matthew Product Title"] ?? "",
    "UPC":                inv["UPC"] ? String(inv["UPC"]) : "",
    "Inventory Format":   mptFmt ?? "",
    "Merch Format":       merchFmt ?? "",
    "Note":               note,
  };
}

function autoSize(ws, rows, headers) {
  ws["!cols"] = headers.map((h) => ({
    wch: Math.min(60, Math.max(h.length + 2,
      ...rows.slice(0, 50).map((r) => String(r[h] ?? "").length)
    )),
  }));
}

main();
