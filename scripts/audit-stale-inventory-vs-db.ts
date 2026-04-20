import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as XLSX from "xlsx";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

/**
 * Read-only audit: cross-reference 5 stale paper-trail inventory XLSX
 * documents against `warehouse_product_variants` + `warehouse_products`
 * by SKU and (when SKU misses) by Artist - Title fuzzy match.
 *
 * NEVER writes to the DB. NEVER imports inventory levels. Output is
 * three artifacts per file under reports/finish-line/:
 *   - {file}-rows.csv     : every row + match status
 *   - {file}-summary.json : per-file counts + samples
 * And a top-level aggregate summary.
 */

type FileSpec = {
  path: string;
  /** Override default column heuristics if needed. */
  skuCol?: string;
  artistTitleCol?: string;
  formatCol?: string;
  labelCol?: string;
};

const FILES: FileSpec[] = [
  { path: "/Users/tomabbs/Downloads/avant 1.xlsx" },
  { path: "/Users/tomabbs/Downloads/redeye over.xlsx" },
  { path: "/Users/tomabbs/Downloads/gr.xlsx" },
  { path: "/Users/tomabbs/Downloads/anacortes.xlsx" },
  { path: "/Users/tomabbs/Downloads/Master page.xlsx" },
];

function normSku(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

/** Strip noisy bits and lowercase for fuzzy comparison. */
function normTitle(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim();
}

/** First N tokens of a title — used as a containment test against full DB titles. */
function titleHead(value: string, tokens = 4): string {
  return normTitle(value).split(" ").slice(0, tokens).join(" ");
}

type DbVariant = {
  id: string;
  sku: string;
  product_id: string;
  product_title: string | null;
  format_name: string | null;
  org_id: string | null;
  vendor: string | null;
  shopify_product_id: string | null;
};

async function loadDb() {
  const sb = createServiceRoleClient();
  const variants = new Map<string, DbVariant>();
  const titleIndex = new Map<string, DbVariant[]>(); // titleHead → matching variants
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select(
        "id, sku, product_id, format_name, warehouse_products!inner(title, org_id, vendor, shopify_product_id)",
      )
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data as unknown as Array<{
      id: string;
      sku: string;
      product_id: string;
      format_name: string | null;
      warehouse_products: {
        title: string | null;
        org_id: string | null;
        vendor: string | null;
        shopify_product_id: string | null;
      } | null;
    }>) {
      const v: DbVariant = {
        id: row.id,
        sku: row.sku,
        product_id: row.product_id,
        product_title: row.warehouse_products?.title ?? null,
        format_name: row.format_name,
        org_id: row.warehouse_products?.org_id ?? null,
        vendor: row.warehouse_products?.vendor ?? null,
        shopify_product_id: row.warehouse_products?.shopify_product_id ?? null,
      };
      const ns = normSku(v.sku);
      if (ns) variants.set(ns, v);
      const head = titleHead(v.product_title ?? "");
      if (head.length >= 6) {
        const list = titleIndex.get(head) ?? [];
        list.push(v);
        titleIndex.set(head, list);
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return { variants, titleIndex };
}

type RowExtract = {
  rowIdx: number;
  rawSku: string;
  normSku: string;
  format: string;
  label: string;
  artistTitle: string;
};

/**
 * Find the header row, then locate column indices by header name. Some files
 * (avant, Master page) have an extra leading "Catalog #" / "FLEY" column —
 * header detection handles both.
 */
function extractRowsFromSheet(sh: XLSX.WorkSheet): RowExtract[] {
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sh, {
    header: 1,
    defval: "",
    raw: false,
  });
  if (rows.length === 0) return [];

  // Find header row: the first row whose cells include "SKU" and "Format".
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const cells = r.map((c) => String(c ?? "").trim().toLowerCase());
    if (cells.includes("sku") && cells.includes("format")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = rows[headerIdx].map((c) => String(c ?? "").trim().toLowerCase());
  const skuCol = header.indexOf("sku");
  const formatCol = header.indexOf("format");
  const labelCol = header.indexOf("label");
  const artistTitleCol = header.findIndex((h) => h.startsWith("artist") && h.includes("title"));

  const out: RowExtract[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const rawSku = String(r[skuCol] ?? "").trim();
    const format = String(r[formatCol] ?? "").trim();
    const label = labelCol >= 0 ? String(r[labelCol] ?? "").trim() : "";
    const artistTitle = artistTitleCol >= 0 ? String(r[artistTitleCol] ?? "").trim() : "";

    // Skip empty rows and totals/blank padding.
    if (!rawSku && !artistTitle && !format) continue;

    out.push({
      rowIdx: i,
      rawSku,
      normSku: normSku(rawSku),
      format,
      label,
      artistTitle,
    });
  }
  return out;
}

type Match = {
  status:
    | "sku_match"
    | "sku_match_format_mismatch"
    | "sku_match_title_mismatch"
    | "no_sku_title_match"
    | "no_sku_no_match"
    | "missing_sku_no_title"
    | "no_match";
  variant?: DbVariant;
  notes?: string;
};

function compareRow(r: RowExtract, db: Awaited<ReturnType<typeof loadDb>>): Match {
  if (!r.normSku) {
    if (!r.artistTitle) return { status: "missing_sku_no_title" };
    // Try fuzzy title-only
    const head = titleHead(r.artistTitle);
    if (head.length < 6) return { status: "no_sku_no_match", notes: "title too short" };
    const candidates = db.titleIndex.get(head) ?? [];
    if (candidates.length === 0) return { status: "no_sku_no_match" };
    return {
      status: "no_sku_title_match",
      variant: candidates[0],
      notes: `${candidates.length} candidates`,
    };
  }

  const v = db.variants.get(r.normSku);
  if (!v) return { status: "no_match" };

  // Title containment check (forgiving): row's title head must appear within DB title or vice versa.
  const rowHead = titleHead(r.artistTitle, 3);
  const dbTitleNorm = normTitle(v.product_title);
  const titleAligned =
    rowHead.length === 0 || dbTitleNorm.includes(rowHead) || normTitle(r.artistTitle).includes(titleHead(v.product_title ?? "", 3));

  // Format check: if both sides have a format, compare loosely.
  const rowFmt = r.format.trim().toLowerCase();
  const dbFmt = (v.format_name ?? "").trim().toLowerCase();
  const formatAligned =
    rowFmt.length === 0 ||
    dbFmt.length === 0 ||
    dbFmt.includes(rowFmt) ||
    rowFmt.includes(dbFmt);

  if (!titleAligned) return { status: "sku_match_title_mismatch", variant: v };
  if (!formatAligned) return { status: "sku_match_format_mismatch", variant: v };
  return { status: "sku_match", variant: v };
}

async function main() {
  console.log("[load] DB variants + title index …");
  const db = await loadDb();
  console.log(
    `[loaded] db_variants_indexed_by_sku=${db.variants.size} db_title_buckets=${db.titleIndex.size}`,
  );

  const outDir = join(process.cwd(), "reports", "finish-line", "stale-inventory");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const aggregate: Record<string, Record<string, number>> = {};

  for (const f of FILES) {
    console.log(`\n[file] ${f.path}`);
    const wb = XLSX.readFile(f.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = extractRowsFromSheet(sheet);
    console.log(`  rows extracted: ${rows.length}`);

    const buckets: Record<Match["status"], number> = {
      sku_match: 0,
      sku_match_format_mismatch: 0,
      sku_match_title_mismatch: 0,
      no_sku_title_match: 0,
      no_sku_no_match: 0,
      missing_sku_no_title: 0,
      no_match: 0,
    };

    type CsvRow = RowExtract & {
      match_status: Match["status"];
      db_variant_id: string;
      db_sku: string;
      db_product_title: string;
      db_format_name: string;
      db_vendor: string;
      db_org_id: string;
      db_shopify_product_id: string;
      notes: string;
    };
    const csvRows: CsvRow[] = [];

    for (const r of rows) {
      const m = compareRow(r, db);
      buckets[m.status] = (buckets[m.status] ?? 0) + 1;
      csvRows.push({
        ...r,
        match_status: m.status,
        db_variant_id: m.variant?.id ?? "",
        db_sku: m.variant?.sku ?? "",
        db_product_title: m.variant?.product_title ?? "",
        db_format_name: m.variant?.format_name ?? "",
        db_vendor: m.variant?.vendor ?? "",
        db_org_id: m.variant?.org_id ?? "",
        db_shopify_product_id: m.variant?.shopify_product_id ?? "",
        notes: m.notes ?? "",
      });
    }

    const fname = basename(f.path).replace(/[^a-z0-9.-]+/gi, "_");
    const csvPath = join(outDir, `${fname}-rows-${stamp}.csv`);
    const sumPath = join(outDir, `${fname}-summary-${stamp}.json`);

    const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const header = [
      "row_idx",
      "raw_sku",
      "norm_sku",
      "format",
      "label",
      "artist_title",
      "match_status",
      "db_variant_id",
      "db_sku",
      "db_product_title",
      "db_format_name",
      "db_vendor",
      "db_org_id",
      "db_shopify_product_id",
      "notes",
    ].join(",");
    const lines = [header];
    for (const r of csvRows) {
      lines.push(
        [
          r.rowIdx,
          cell(r.rawSku),
          cell(r.normSku),
          cell(r.format),
          cell(r.label),
          cell(r.artistTitle),
          cell(r.match_status),
          cell(r.db_variant_id),
          cell(r.db_sku),
          cell(r.db_product_title),
          cell(r.db_format_name),
          cell(r.db_vendor),
          cell(r.db_org_id),
          cell(r.db_shopify_product_id),
          cell(r.notes),
        ].join(","),
      );
    }
    writeFileSync(csvPath, lines.join("\n"), "utf8");

    // Sample of misses for the JSON summary (so the user can spot-check).
    const misses = csvRows
      .filter((r) => r.match_status === "no_match")
      .slice(0, 12)
      .map((r) => ({
        row_idx: r.rowIdx,
        sku: r.rawSku,
        format: r.format,
        label: r.label,
        artist_title: r.artistTitle,
      }));
    const skuMatchTitleMismatch = csvRows
      .filter((r) => r.match_status === "sku_match_title_mismatch")
      .slice(0, 8)
      .map((r) => ({
        sku: r.rawSku,
        sheet_title: r.artistTitle,
        db_title: r.db_product_title,
      }));
    const noSkuMatched = csvRows
      .filter((r) => r.match_status === "no_sku_title_match")
      .slice(0, 8)
      .map((r) => ({
        title: r.artistTitle,
        db_sku: r.db_sku,
        db_title: r.db_product_title,
        notes: r.notes,
      }));
    const summary = {
      file: f.path,
      total_rows: rows.length,
      buckets,
      samples: {
        no_match: misses,
        sku_match_title_mismatch: skuMatchTitleMismatch,
        no_sku_title_match: noSkuMatched,
      },
    };
    writeFileSync(sumPath, JSON.stringify(summary, null, 2));
    console.log(`  buckets: ${JSON.stringify(buckets)}`);
    console.log(`  csv: ${csvPath}`);

    aggregate[basename(f.path)] = buckets;
  }

  // Aggregate roll-up
  const roll: Record<string, number> = {};
  for (const file of Object.keys(aggregate)) {
    for (const [k, v] of Object.entries(aggregate[file])) {
      roll[k] = (roll[k] ?? 0) + v;
    }
  }
  const aggPath = join(outDir, `_aggregate-${stamp}.json`);
  writeFileSync(
    aggPath,
    JSON.stringify({ per_file: aggregate, total: roll }, null, 2),
  );

  console.log(`\n=== AGGREGATE (all 5 files combined) ===`);
  console.log(JSON.stringify(roll, null, 2));
  console.log(`\nAggregate written: ${aggPath}`);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
