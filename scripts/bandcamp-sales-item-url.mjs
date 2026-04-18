/**
 * Build SKU → Bandcamp item_url from the sales_report distinct-lines export.
 * When a SKU appears with multiple URLs, keep the row with highest occurrence_count_in_sales_table.
 */

import fs from "node:fs";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (c === "\r") continue;
    field += c;
  }
  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
    rows.push(row);
  }
  return rows;
}

/**
 * @param {string} salesDistinctCsvPath
 * @returns {Map<string, string>}
 */
export function loadBandcampItemUrlBySku(salesDistinctCsvPath) {
  const text = fs.readFileSync(salesDistinctCsvPath, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) return new Map();

  const header = rows[0];
  const iSku = header.indexOf("sku");
  const iUrl = header.indexOf("item_url");
  const iOcc = header.indexOf("occurrence_count_in_sales_table");
  if (iSku < 0 || iUrl < 0) {
    throw new Error(
      `Expected sku and item_url columns in ${salesDistinctCsvPath}`,
    );
  }

  /** @type {Map<string, { url: string; occ: number }>} */
  const best = new Map();

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    const sku = String(line[iSku] ?? "").trim();
    const url = String(line[iUrl] ?? "").trim();
    if (!sku || !url) continue;
    const occ =
      iOcc >= 0 ? Number.parseInt(String(line[iOcc] ?? "0"), 10) || 0 : 0;
    const prev = best.get(sku);
    if (!prev || occ > prev.occ) {
      best.set(sku, { url, occ });
    }
  }

  return new Map([...best.entries()].map(([k, v]) => [k, v.url]));
}
