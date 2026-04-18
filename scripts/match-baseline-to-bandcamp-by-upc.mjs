#!/usr/bin/env node
/**
 * Join a baseline inventory CSV to the merch+sales verified export by normalized UPC.
 * See reports/leaving-records-baseline-to-bandcamp-by-upc-*-README.txt for rules.
 *
 * Usage:
 *   node scripts/match-baseline-to-bandcamp-by-upc.mjs \
 *     [baselineCsv] [merchVerifiedCsv] [outputPrefix] [salesDistinctCsv]
 *
 * Defaults point at reports/ Leaving Records files.
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

function digitsOnly(s) {
  return String(s ?? "").replace(/\D/g, "");
}

/** Canonical key: digits only, leading zeros stripped (aligns GTIN variants). */
function canonicalUpcKey(raw) {
  const d = digitsOnly(raw);
  if (!d) return "";
  const stripped = d.replace(/^0+/, "");
  return stripped || "0";
}

function csvEscape(s) {
  if (s == null || s === undefined) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const MERCH_COLUMNS = [
  "merch_api_sku",
  "warehouse_sku",
  "mapping_id",
  "package_id",
  "album_title",
  "title",
  "item_type",
  "subdomain",
  "sales_upc_verified",
  "sales_catalog_number_verified",
  "sales_row_count_for_sku",
  "link_confidence",
  "link_note",
  "bandcamp_item_url",
];

const OUT_COLUMNS = [
  "baseline_row_index",
  "baseline_qty",
  "baseline_description",
  "baseline_upc_raw",
  "baseline_upc_normalized",
  "match_status",
  "match_cardinality",
  "qty_shipped_leaving_records",
  ...MERCH_COLUMNS,
  "merch_raw_api_json",
];

function loadMerchByUpc(merchPath) {
  const text = fs.readFileSync(merchPath, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`No data rows in ${merchPath}`);
  const header = rows[0];
  const idx = (name) => header.indexOf(name);
  const need = ["merch_api_sku", "sales_upc_verified"];
  for (const n of need) {
    if (idx(n) < 0) throw new Error(`Missing column ${n} in ${merchPath}`);
  }

  /** @type {Map<string, object[]>} */
  const byKey = new Map();
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const rowObj = {};
    for (let c = 0; c < header.length; c++) {
      rowObj[header[c]] = line[c] ?? "";
    }
    const salesUpc = rowObj.sales_upc_verified;
    const key = canonicalUpcKey(salesUpc);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rowObj);
  }
  return { byKey, header };
}

function parseBaseline(baselinePath) {
  const text = fs.readFileSync(baselinePath, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`No data in ${baselinePath}`);
  const header = rows[0].map((h) => h.trim());
  const iq = header.indexOf("baseline_qty");
  const idesc = header.indexOf("description");
  const iupc = header.indexOf("list_upc");
  const iship = header.indexOf("qty_shipped_leaving_records");
  if (iq < 0 || idesc < 0 || iupc < 0) {
    throw new Error(
      `Expected baseline_qty, description, list_upc in ${baselinePath}`,
    );
  }

  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const qty = line[iq] ?? "";
    const description = line[idesc] ?? "";
    const listUpcRaw = (line[iupc] ?? "").trim();
    const shipped = iship >= 0 ? (line[iship] ?? "") : "";

    const lower = listUpcRaw.toLowerCase();
    const noUpc =
      !listUpcRaw ||
      lower.includes("(none in list)") ||
      lower.includes("none_in_list");

    let normalized = "";
    let matchStatus = "HAS_UPC";
    if (noUpc) {
      matchStatus = "NEEDS_IDENTIFIER";
    } else {
      normalized = canonicalUpcKey(listUpcRaw);
      if (!digitsOnly(listUpcRaw)) {
        matchStatus = "NEEDS_IDENTIFIER";
        normalized = "";
      }
    }

    items.push({
      baseline_row_index: r,
      baseline_qty: qty,
      baseline_description: description,
      baseline_upc_raw: listUpcRaw,
      baseline_upc_normalized: normalized,
      match_status_input: matchStatus,
      qty_shipped_leaving_records: shipped,
    });
  }
  return items;
}

function main() {
  const day = new Date().toISOString().slice(0, 10);
  const baselineDefault = path.join(
    repoRoot,
    "reports",
    "leaving-records-baseline-upc-shipped-20260413.csv",
  );
  const merchDefault = path.join(
    repoRoot,
    "reports",
    "leaving-records-merch-plus-sales-verified-2026-04-14.csv",
  );
  const baselinePath = path.resolve(process.argv[2] || baselineDefault);
  const merchPath = path.resolve(process.argv[3] || merchDefault);
  const outPrefix =
    process.argv[4] ||
    path.join(repoRoot, "reports", `leaving-records-baseline-to-bandcamp-by-upc-${day}`);
  const salesDistinctDefault = path.join(
    repoRoot,
    "reports",
    "leaving-records-bandcamp-api-only-2026-04-14-sales-api-distinct-lines.csv",
  );
  const salesDistinctPath = path.resolve(process.argv[5] || salesDistinctDefault);

  const skuToItemUrl = loadBandcampItemUrlBySku(salesDistinctPath);
  const { byKey } = loadMerchByUpc(merchPath);
  const baselineRows = parseBaseline(baselinePath);

  const outLines = [];
  let countNone = 0;
  let countOne = 0;
  let countMany = 0;
  let countNeedsId = 0;

  for (const b of baselineRows) {
    if (b.match_status_input === "NEEDS_IDENTIFIER") {
      countNeedsId++;
      outLines.push({
        ...emptyMerchRow(),
        baseline_row_index: b.baseline_row_index,
        baseline_qty: b.baseline_qty,
        baseline_description: b.baseline_description,
        baseline_upc_raw: b.baseline_upc_raw,
        baseline_upc_normalized: b.baseline_upc_normalized,
        match_status: "NEEDS_IDENTIFIER",
        match_cardinality: "N_A",
        qty_shipped_leaving_records: b.qty_shipped_leaving_records,
      });
      continue;
    }

    const matches = byKey.get(b.baseline_upc_normalized) || [];
    let cardinality = "NONE";
    if (matches.length === 1) cardinality = "ONE";
    else if (matches.length > 1) cardinality = "MANY";

    if (matches.length === 0) countNone++;
    else if (matches.length === 1) countOne++;
    else countMany++;

    const matchStatus =
      matches.length === 0 ? "NO_BANDCAMP_ROWS_FOR_UPC" : "MATCHED";

    if (matches.length === 0) {
      outLines.push({
        ...emptyMerchRow(),
        baseline_row_index: b.baseline_row_index,
        baseline_qty: b.baseline_qty,
        baseline_description: b.baseline_description,
        baseline_upc_raw: b.baseline_upc_raw,
        baseline_upc_normalized: b.baseline_upc_normalized,
        match_status: matchStatus,
        match_cardinality: cardinality,
        qty_shipped_leaving_records: b.qty_shipped_leaving_records,
      });
      continue;
    }

    for (const m of matches) {
      outLines.push({
        baseline_row_index: b.baseline_row_index,
        baseline_qty: b.baseline_qty,
        baseline_description: b.baseline_description,
        baseline_upc_raw: b.baseline_upc_raw,
        baseline_upc_normalized: b.baseline_upc_normalized,
        match_status: matchStatus,
        match_cardinality: cardinality,
        qty_shipped_leaving_records: b.qty_shipped_leaving_records,
        merch_api_sku: m.merch_api_sku,
        warehouse_sku: m.warehouse_sku,
        mapping_id: m.mapping_id,
        package_id: m.package_id,
        album_title: m.album_title,
        title: m.title,
        item_type: m.item_type,
        subdomain: m.subdomain,
        sales_upc_verified: m.sales_upc_verified,
        sales_catalog_number_verified: m.sales_catalog_number_verified,
        sales_row_count_for_sku: m.sales_row_count_for_sku,
        link_confidence: m.link_confidence,
        link_note: m.link_note,
        bandcamp_item_url:
          skuToItemUrl.get(String(m.merch_api_sku ?? "").trim()) ||
          String(m.bandcamp_item_url ?? "").trim() ||
          "",
        merch_raw_api_json: m.merch_raw_api_json,
      });
    }
  }

  const csv =
    OUT_COLUMNS.join(",") +
    "\n" +
    outLines.map((row) => OUT_COLUMNS.map((c) => csvEscape(row[c])).join(",")).join("\n") +
    "\n";

  const csvPath = `${outPrefix}.csv`;
  fs.writeFileSync(csvPath, csv, "utf8");

  const readme = `Leaving Records — Baseline to Bandcamp (verifiable UPC match)

Source baseline: ${path.basename(baselinePath)}
Source merch+sales: ${path.basename(merchPath)}
Sales distinct (SKU → item_url): ${path.basename(salesDistinctPath)}

bandcamp_item_url:
  - From Sales Report API item_url for the same merch_api_sku (highest occurrence_count if multiple).
  - Empty if that SKU never appeared on sales lines with a URL.

UPC normalization (matching only):
  - Take digits only from baseline list_upc and from merch sales_upc_verified.
  - Strip leading zeros for the lookup key so e.g. 00198704394676 aligns with 198704394676.

Join:
  - Baseline rows with no usable UPC (empty, "(none in list)", or non-numeric) → match_status NEEDS_IDENTIFIER (no Bandcamp join).

  - Otherwise: all merch+sales rows whose canonical UPC key equals the baseline key are attached.
    One label UPC often maps to MANY Bandcamp SKUs (formats/variants); match_cardinality MANY is expected.

  - Rarely, the same UPC can appear on sales lines for different album_title values (catalog quirk).
    When that happens, filter MANY rows by album_title / subdomain vs your baseline description.

Output rows:
  - One row per (baseline line × matching Bandcamp row). Unmatched UPC → one row with empty merch columns.

Summary (${baselineRows.length} baseline lines):
  MATCHED cardinality ONE:  ${countOne}
  MATCHED cardinality MANY: ${countMany}
  NO_BANDCAMP_ROWS_FOR_UPC: ${countNone}
  NEEDS_IDENTIFIER:         ${countNeedsId}

Output file: ${path.basename(csvPath)}
`;

  fs.writeFileSync(`${outPrefix}-README.txt`, readme, "utf8");

  console.log("Wrote", csvPath);
  console.log(readme);
}

function emptyMerchRow() {
  return {
    merch_api_sku: "",
    warehouse_sku: "",
    mapping_id: "",
    package_id: "",
    album_title: "",
    title: "",
    item_type: "",
    subdomain: "",
    sales_upc_verified: "",
    sales_catalog_number_verified: "",
    sales_row_count_for_sku: "",
    link_confidence: "",
    link_note: "",
    bandcamp_item_url: "",
    merch_raw_api_json: "",
  };
}

main();
