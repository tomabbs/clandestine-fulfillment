#!/usr/bin/env node
/**
 * Parse Leaving Records Bandcamp merch export (single-column: title, format, price/stock)
 * and write a clean spreadsheet: artist - {work + merch variant}, format, link (empty if not in source).
 *
 * artist_title shape: "Artist - AlbumOrWork TEST PRESSING VINYL" (variant text kept, not dropped).
 *
 * Usage:
 *   node scripts/build-leaving-bandcamp-catalog-spreadsheet.mjs [input.xlsx] [outputPrefix]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function isPriceOrStock(s) {
  const t = String(s).trim();
  if (/^sold out$/i.test(t)) return true;
  return /^\$[\d.,]+\s*USD$/i.test(t);
}

function parseItems(lines) {
  let i = 0;
  if (lines[0] === "Show:") i = 1;
  const items = [];
  while (i < lines.length) {
    const title = lines[i++];
    if (title === undefined || title === "") continue;
    const a = lines[i];
    if (a === undefined) break;
    if (isPriceOrStock(a)) {
      items.push({ rawTitle: title, format: "", priceOrStock: a });
      i++;
      continue;
    }
    const format = a;
    i++;
    const priceOrStock = lines[i];
    i++;
    items.push({ rawTitle: title, format, priceOrStock: priceOrStock ?? "" });
  }
  return items;
}

/**
 * Split "Work title – FORMAT_ARTIST" or "FORMATArtist" tail into work vs artist.
 * Bandcamp exports often concatenate variant + artist without a space.
 */
function extractWorkAndArtist(rawTitle) {
  const t = String(rawTitle).trim();
  const dash = " – ";
  const idx = t.indexOf(dash);
  if (idx === -1) {
    if (/^STICKER SET/i.test(t)) {
      return {
        work: "Sticker set",
        variantAndArtist: t.replace(/^STICKER SET/i, "").trim(),
      };
    }
    if (/^BUMPER STICKER/i.test(t) && t.length > "BUMPER STICKER".length) {
      return {
        work: "Bumper sticker",
        variantAndArtist: t.replace(/^BUMPER STICKER/i, "").trim(),
      };
    }
    if (/^BUMPER STICKER$/i.test(t)) {
      return { work: "Bumper sticker", variantAndArtist: "" };
    }
    return { work: t, variantAndArtist: "" };
  }
  return {
    work: t.slice(0, idx).trim(),
    variantAndArtist: t.slice(idx + dash.length).trim(),
  };
}

/** Longest first — strip from variant+artist blob before remainder = artist. */
const FORMAT_PREFIXES = [
  "AUTOGRAPHED TEST PRESSING VINYL",
  "TEST PRESSING VINYL",
  "TEST PRESSING",
  "DOUBLE CASSETTE",
  "MARBLED CASSETTE",
  "MARBLED VINYL",
  "BLACK 2LP VINYL",
  "CLEAR 2LP VINYL",
  "BLACK VINYL",
  "WHITE VINYL",
  "BLUE VINYL",
  "CLEAR VINYL",
  "RED VINYL",
  "PINK VINYL",
  "SILVER VINYL",
  "DARK CLEAR VINYL",
  "PLANT MUSIC TAPE BUNDLE",
  "PLANT MUSIC VINYL BUNDLE",
  "UNCLEARED 12\" VINYL (HABENERO ORANGE)",
  "VINYL (BUMPER STICKER BUNDLE)",
  "VINYL (BLACK)",
  "VINYL (COLOR)",
  "VINYL (CLEAR)",
  "VINYL (ESCAPE EDITION)",
  "VINYL (MAGENTA)",
  "VINYL (MARBLED SMOKE & BLACK)",
  "VINYL (MARBLED)",
  "VINYL (SMALL DINGS)",
  "VINYL (SMOKE)",
  "CD (Japan Import)",
  "CD (JAPAN)",
  "COMPACT DISC (JAPAN EDITION)",
  "STICKER SET",
  "CASSETTE BUNDLE",
  "CASSETTE",
  "Cassette",
  "RECORD/VINYL",
  "VINYL",
  "EXTRAVINYL",
  "EXTRACASSETTE",
  "TAPE BUNDLE",
  "UNCLEARED CASSETTE",
].sort((a, b) => b.length - a.length);

/**
 * Strip leading format/variant tokens from "VARIANT…Artist" blob; collect each stripped
 * segment for the merch name (e.g. TEST PRESSING VINYL, VINYL).
 */
function parseVariantTail(variantAndArtist) {
  if (!variantAndArtist) {
    return { artist: "", variantParts: [] };
  }

  let s = variantAndArtist.trim();
  const variantParts = [];

  const cdJp = s.match(/^CD \(Japan Import\)(.*)$/i);
  if (cdJp) {
    return {
      variantParts: ["CD (Japan Import)"],
      artist: cdJp[1].trim(),
    };
  }
  const cdJ = s.match(/^CD \(JAPAN\)(.*)$/i);
  if (cdJ) {
    return { variantParts: ["CD (JAPAN)"], artist: cdJ[1].trim() };
  }
  const cdEd = s.match(/^COMPACT DISC \(JAPAN EDITION\)(.*)$/i);
  if (cdEd) {
    return {
      variantParts: ["COMPACT DISC (JAPAN EDITION)"],
      artist: cdEd[1].trim(),
    };
  }

  const parenImport = s.match(/^(.+?\))(\s*[A-Za-z].*)$/);
  if (
    parenImport &&
    /Import|JAPAN|Edition/i.test(parenImport[1]) &&
    !/^CD\s*\(/i.test(s)
  ) {
    return {
      variantParts: [parenImport[1].trim()],
      artist: parenImport[2].trim(),
    };
  }

  for (let guard = 0; guard < 40; guard++) {
    let changed = false;
    for (const p of FORMAT_PREFIXES) {
      if (
        s.length >= p.length &&
        s.slice(0, p.length).toLowerCase() === p.toLowerCase()
      ) {
        variantParts.push(s.slice(0, p.length));
        s = s.slice(p.length).trim();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  const artist = s && /[a-zA-Z]/.test(s) ? s.trim() : "";
  return { artist, variantParts };
}

function artistTitleColumn(rawTitle) {
  const { work, variantAndArtist } = extractWorkAndArtist(rawTitle);
  const { artist, variantParts } = parseVariantTail(variantAndArtist);
  const w = work.replace(/\s+/g, " ").trim();

  if (!artist) {
    return `Leaving Records - ${w}`;
  }

  const a = artist.replace(/\s+/g, " ").trim();
  const merchName = [w, ...variantParts.map((p) => p.replace(/\s+/g, " ").trim())]
    .filter(Boolean)
    .join(" ");

  return `${a} - ${merchName}`;
}

function csvEscape(s) {
  if (s == null || s === undefined) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function main() {
  const day = new Date().toISOString().slice(0, 10);
  const inputPath =
    process.argv[2] ||
    path.join("/Users/tomabbs/Downloads", "Untitled spreadsheet (4).xlsx");
  const outPrefix =
    process.argv[3] ||
    path.join(
      repoRoot,
      "reports",
      `leaving-records-bandcamp-catalog-from-sheet-${day}`,
    );

  if (!fs.existsSync(inputPath)) {
    console.error("Input file not found:", inputPath);
    process.exit(1);
  }

  const wb = XLSX.readFile(inputPath);
  const sheet = wb.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: "" });
  const lines = data.map((r) => r[0]).filter((_, rowIdx) => rowIdx > 0);

  const items = parseItems(lines);

  const rows = [
    [
      "artist_title",
      "format",
      "bandcamp_url",
      "raw_title_from_export",
      "notes",
    ],
  ];

  for (const it of items) {
    const artistTitle = artistTitleColumn(it.rawTitle);
    let format = it.format;
    let note = "";
    if (!format) {
      if (/STICKER/i.test(it.rawTitle)) format = "Sticker";
      else note = "format missing in source column sequence; check raw title";
    }
    rows.push([
      artistTitle,
      format,
      "",
      it.rawTitle,
      note,
    ]);
  }

  const csv =
    rows.map((r) => r.map((c) => csvEscape(c)).join(",")).join("\n") + "\n";
  const csvPath = `${outPrefix}.csv`;
  fs.writeFileSync(csvPath, csv, "utf8");

  const outWb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(outWb, ws, "Leaving catalog");
  const xlsxPath = `${outPrefix}.xlsx`;
  XLSX.writeFile(outWb, xlsxPath);

  const readme = `Leaving Records — Bandcamp catalog (from spreadsheet export)

Source: ${path.basename(inputPath)}
Rows parsed: ${items.length}

Columns:
  artist_title — "Artist - {work name} {variant…}" e.g. Fabiano do Nascimento - Cavejaz TEST PRESSING VINYL (variant tokens from the title, not the separate format row).
  format — Bandcamp format (Vinyl, Cassette, Shirt, …) from the row under the title; stock/price rows ignored.
  bandcamp_url — Empty: the source .xlsx had no links (single column A only). Fill via Sales Report item_url join or manual paste if needed.
  raw_title_from_export — Original cell text for traceability.
  notes — Parser warnings (e.g. missing format row).

Files:
  ${path.basename(csvPath)}
  ${path.basename(xlsxPath)}
`;

  fs.writeFileSync(`${outPrefix}-README.txt`, readme, "utf8");

  console.log("Wrote", csvPath);
  console.log("Wrote", xlsxPath);
  console.log("Items:", items.length);
  console.log(readme);
}

main();
