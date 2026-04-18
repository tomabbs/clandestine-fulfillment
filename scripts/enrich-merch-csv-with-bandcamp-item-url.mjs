#!/usr/bin/env node
/**
 * Add bandcamp_item_url to merch+sales CSV by joining merch_api_sku to Sales Report item_url
 * (from *-sales-api-distinct-lines.csv). URLs come only from Bandcamp sales API — no construction.
 *
 * Usage:
 *   node scripts/enrich-merch-csv-with-bandcamp-item-url.mjs [merchCsv] [salesDistinctCsv] [outCsv]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBandcampItemUrlBySku,
  parseCsv,
} from "./bandcamp-sales-item-url.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function csvEscape(s) {
  if (s == null || s === undefined) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function main() {
  const merchIn =
    process.argv[2] ||
    path.join(
      repoRoot,
      "reports",
      "leaving-records-merch-plus-sales-verified-2026-04-14.csv",
    );
  const salesDistinct =
    process.argv[3] ||
    path.join(
      repoRoot,
      "reports",
      "leaving-records-bandcamp-api-only-2026-04-14-sales-api-distinct-lines.csv",
    );
  const merchOut =
    process.argv[4] ||
    path.join(
      repoRoot,
      "reports",
      "leaving-records-merch-plus-sales-verified-2026-04-14.csv",
    );

  const skuToUrl = loadBandcampItemUrlBySku(salesDistinct);
  const text = fs.readFileSync(merchIn, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`Empty or invalid CSV: ${merchIn}`);

  const header = rows[0];
  const col = (name) => header.indexOf(name);

  if (col("merch_api_sku") < 0) {
    throw new Error(`merch_api_sku column missing in ${merchIn}`);
  }

  const existingUrl = col("bandcamp_item_url");
  let outHeader;
  let insertAt;
  if (existingUrl >= 0) {
    outHeader = header;
    insertAt = existingUrl;
  } else {
    const after = col("link_note");
    insertAt = after >= 0 ? after + 1 : header.length;
    outHeader = [
      ...header.slice(0, insertAt),
      "bandcamp_item_url",
      ...header.slice(insertAt),
    ];
  }

  const outRows = [outHeader];

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const rowObj = {};
    for (let c = 0; c < header.length; c++) {
      rowObj[header[c]] = line[c] ?? "";
    }
    const sku = String(rowObj.merch_api_sku ?? "").trim();
    const url = skuToUrl.get(sku) || "";

    if (existingUrl >= 0) {
      const copy = [...line];
      copy[insertAt] = url;
      outRows.push(copy);
    } else {
      const extended = [];
      for (let c = 0; c < header.length; c++) {
        extended.push(line[c] ?? "");
      }
      extended.splice(insertAt, 0, url);
      outRows.push(extended);
    }
  }

  const csv =
    outRows.map((line) => line.map((c) => csvEscape(c)).join(",")).join("\n") +
    "\n";

  fs.writeFileSync(merchOut, csv, "utf8");

  let withUrl = 0;
  for (let r = 1; r < outRows.length; r++) {
    const u = outRows[r][insertAt];
    if (u) withUrl++;
  }

  console.log("Wrote", merchOut);
  console.log(
    `Rows: ${outRows.length - 1} | bandcamp_item_url non-empty: ${withUrl}`,
  );
}

main();
