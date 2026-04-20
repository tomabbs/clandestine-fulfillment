/**
 * Backfill `warehouse_product_variants.format_name` for variants where it is
 * currently NULL. Uses, in priority order:
 *
 *   1. SKU prefix (LP-, CD-, CS-, SHIRT-, MERCH-, BAG-, BOOK-, POSTER-, …)
 *   2. Bandcamp `bandcamp_product_mappings.api_data.type_name`
 *   3. Parent product title keyword
 *   4. Inventory-master XLSX cross-reference by SKU
 *   5. Shopify productType (queried from warehouse_products.product_type only;
 *      we don't fetch live from Shopify in this pass)
 *
 * READ-ONLY by default. Use `--apply` to perform writes.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-format-name.ts            # dry-run
 *   pnpm tsx scripts/backfill-format-name.ts --apply
 */

import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampTypeNameToFormat } from "@/trigger/lib/format-detection";

config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");

const FILES = [
  "/Users/tomabbs/Downloads/avant 1.xlsx",
  "/Users/tomabbs/Downloads/redeye over.xlsx",
  "/Users/tomabbs/Downloads/gr.xlsx",
  "/Users/tomabbs/Downloads/anacortes.xlsx",
  "/Users/tomabbs/Downloads/Master page.xlsx",
];

const ALLOWED_FORMATS = new Set<string>(["LP", "CD", "Cassette", '7"', "T-Shirt", "Other"]);

function normSku(value: string | null | undefined): string {
  if (!value) return "";
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function canonicalizeSheetFormat(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (t === "lp" || t === "vinyl" || t === '12"' || t === "12 inch") return "LP";
  if (t === "cd" || t === "compact disc") return "CD";
  if (t === "cassette" || t === "tape" || t === "cs") return "Cassette";
  if (t === '7"' || t === "7" || t === "7 inch" || t === "flexi") return '7"';
  if (t === "shirt" || t === "tee" || t === "t-shirt") return "T-Shirt";
  if (
    t === "tote" ||
    t === "patch" ||
    t === "poster" ||
    t === "bag" ||
    t === "book" ||
    t === "merch"
  ) {
    return "Other";
  }
  return null;
}

function readXlsxSkuFormatMap(path: string): Map<string, string> {
  const out = new Map<string, string>();
  const wb = XLSX.readFile(path);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sh, {
    header: 1,
    defval: "",
    raw: false,
  });
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
  if (headerIdx === -1) return out;
  const header = rows[headerIdx].map((c) => String(c ?? "").trim().toLowerCase());
  const skuCol = header.indexOf("sku");
  const fmtCol = header.indexOf("format");
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const sku = normSku(String(r[skuCol] ?? ""));
    if (!sku) continue;
    const f = canonicalizeSheetFormat(String(r[fmtCol] ?? ""));
    if (f && !out.has(sku)) out.set(sku, f);
  }
  return out;
}

async function main() {
  console.log(`[mode] ${APPLY ? "APPLY" : "DRY-RUN"}`);
  const sb = createServiceRoleClient();

  // Pull all null-format variants + parent metadata
  const { data: rows, error } = await sb
    .from("warehouse_product_variants")
    .select(
      "id, sku, title, product_id, warehouse_products!inner(title, vendor, product_type, shopify_product_id)",
    )
    .is("format_name", null);
  if (error) throw error;
  const variants = (rows ?? []) as unknown as Array<{
    id: string;
    sku: string;
    title: string | null;
    product_id: string;
    warehouse_products: {
      title: string | null;
      vendor: string | null;
      product_type: string | null;
      shopify_product_id: string | null;
    } | null;
  }>;
  console.log(`[load] null-format variants: ${variants.length}`);

  // Bandcamp `bandcamp_type_name` lookup by variant_id (Bandcamp API exposes
  // this directly as the merch item's type label, e.g. "CD", "Cassette",
  // "Record/Vinyl", "T-Shirt").
  const variantIds = variants.map((v) => v.id);
  const bandcampMap = new Map<string, string>();
  if (variantIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < variantIds.length; i += CHUNK) {
      const slice = variantIds.slice(i, i + CHUNK);
      const { data: maps } = await sb
        .from("bandcamp_product_mappings")
        .select("variant_id, bandcamp_type_name")
        .in("variant_id", slice);
      for (const m of maps ?? []) {
        if (m.variant_id && m.bandcamp_type_name) {
          bandcampMap.set(m.variant_id, m.bandcamp_type_name);
        }
      }
    }
  }
  console.log(`[load] bandcamp mappings hit: ${bandcampMap.size}`);

  // XLSX SKU → format map
  const xlsxMap = new Map<string, string>();
  for (const f of FILES) {
    for (const [sku, fmt] of readXlsxSkuFormatMap(f)) {
      if (!xlsxMap.has(sku)) xlsxMap.set(sku, fmt);
    }
  }
  console.log(`[load] xlsx sku→format entries: ${xlsxMap.size}`);

  // Format-bearing SKU prefixes (very high confidence — pretty much never
  // wrong). Distinct from "category" prefixes (BOOK-, BAG-, MERCH-, etc.)
  // which are checked AFTER title parse so a "Limited Edition Cassette"
  // book-prefixed SKU lands on Cassette, not Other.
  const FORMAT_PREFIX_RULES: Array<[RegExp, string]> = [
    [/^2XLP-/, "LP"],
    [/^MLP-/, "LP"],
    [/^LP-/, "LP"],
    [/^CD-/, "CD"],
    [/^CS-/, "Cassette"],
    [/^TB-/, "Cassette"],
    [/^7IN-/, '7"'],
    [/^SI-/, '7"'],
    [/^TS-/, "T-Shirt"],
    [/^SHIRT-/, "T-Shirt"],
  ];
  const CATEGORY_PREFIX_RULES: Array<[RegExp, string]> = [
    [/^BOOK-/, "Other"],
    [/^BK-/, "Other"],
    [/^BAG-/, "Other"],
    [/^TOTE-/, "Other"],
    [/^POSTER-/, "Other"],
    [/^PATCH-/, "Other"],
    [/^MERCH-/, "Other"],
    [/^FRAME-/, "Other"],
    [/^EB-/, "Other"],
    [/^MAG-/, "Other"],
  ];

  function titleKeywordFormat(title: string): { fmt: string; matched: string } | null {
    const t = title.toLowerCase();
    if (!t) return null;
    // Order: 7"/cassette before LP to avoid "vinyl" greedy match on "7\" vinyl"
    if (/( 7"|7 ?inch|flexi|lathe)/.test(t)) return { fmt: '7"', matched: "title_7in" };
    if (/(cassette| tape| cs |c\d{2,})/i.test(t)) return { fmt: "Cassette", matched: "title_cassette" };
    if (/(compact disc| cd | cd$)/.test(t)) return { fmt: "CD", matched: "title_cd" };
    if (/(2x ?lp| lp\b|vinyl|12 ?inch|12")/.test(t)) return { fmt: "LP", matched: "title_lp" };
    if (/(t-?shirt|tee\b|hoodie|long-?sleeve|longsleeve|sweatshirt|crewneck|hat\b|cap\b)/.test(t)) {
      return { fmt: "T-Shirt", matched: "title_apparel" };
    }
    if (/(tote|poster|patch|sticker|book|magazine|zine|bag|frame|merch|button|pin)/.test(t)) {
      return { fmt: "Other", matched: "title_merch" };
    }
    return null;
  }

  type Decision = {
    variant_id: string;
    sku: string;
    parent_title: string;
    proposed_format: string | null;
    source: string;
  };
  const decisions: Decision[] = [];
  for (const v of variants) {
    const parentTitle = v.warehouse_products?.title ?? "";
    const sku = v.sku.toUpperCase();
    let f: string | null = null;
    let src = "";

    // 1. Format-bearing SKU prefix (highest confidence)
    for (const [re, fmt] of FORMAT_PREFIX_RULES) {
      if (re.test(sku)) {
        f = fmt;
        src = `sku_prefix:${re.source.replace(/[\\\^$]/g, "")}`;
        break;
      }
    }

    // 2. Parent title keyword (we trust the human-written title over Bandcamp
    //    type_name because LR/multi-option packages mis-stamp type_name)
    if (!f) {
      const tk = titleKeywordFormat(parentTitle);
      if (tk && ALLOWED_FORMATS.has(tk.fmt)) {
        f = tk.fmt;
        src = `parent_title:${tk.matched}`;
      }
    }

    // 3. Bandcamp `bandcamp_type_name`
    if (!f) {
      const tn = bandcampMap.get(v.id);
      const m = bandcampTypeNameToFormat(tn);
      if (m) {
        f = m;
        src = `bandcamp_type:${tn}`;
      }
    }

    // 4. Category SKU prefix → Other
    if (!f) {
      for (const [re, fmt] of CATEGORY_PREFIX_RULES) {
        if (re.test(sku)) {
          f = fmt;
          src = `category_prefix:${re.source.replace(/[\\\^$]/g, "")}`;
          break;
        }
      }
    }

    // 5. XLSX SKU cross-ref
    if (!f) {
      const x = xlsxMap.get(normSku(v.sku));
      if (x) {
        f = x;
        src = "inventory_master_xlsx";
      }
    }

    // 6. Shopify product_type fallback
    if (!f) {
      const pt = (v.warehouse_products?.product_type ?? "").toLowerCase();
      if (pt.includes("vinyl") || pt.includes("lp")) {
        f = "LP";
        src = "shopify_product_type";
      } else if (pt === "cd") {
        f = "CD";
        src = "shopify_product_type";
      } else if (pt === "cassette") {
        f = "Cassette";
        src = "shopify_product_type";
      } else if (pt.includes("apparel") || pt.includes("shirt")) {
        f = "T-Shirt";
        src = "shopify_product_type";
      } else if (pt) {
        f = "Other";
        src = "shopify_product_type_other";
      }
    }

    if (!f) src = "unresolved";
    decisions.push({
      variant_id: v.id,
      sku: v.sku,
      parent_title: parentTitle,
      proposed_format: f,
      source: src,
    });
  }

  const resolvable = decisions.filter((d) => d.proposed_format != null);
  const unresolved = decisions.filter((d) => d.proposed_format == null);

  // Source breakdown
  const bySource = new Map<string, number>();
  for (const d of resolvable) {
    const k = d.source.split(":")[0];
    bySource.set(k, (bySource.get(k) ?? 0) + 1);
  }
  const byFormat = new Map<string, number>();
  for (const d of resolvable)
    byFormat.set(d.proposed_format ?? "", (byFormat.get(d.proposed_format ?? "") ?? 0) + 1);

  console.log(`\n[plan] resolvable: ${resolvable.length}  unresolved: ${unresolved.length}`);
  console.log(`[plan] by source:`);
  for (const [k, c] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.toString().padStart(4)}  ${k}`);
  }
  console.log(`[plan] by format:`);
  for (const [k, c] of [...byFormat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.toString().padStart(4)}  ${k}`);
  }

  // Write CSV plan
  const outDir = join(process.cwd(), "reports", "finish-line", "format-backfill");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const planPath = join(outDir, `format-backfill-plan-${stamp}.csv`);
  const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [["variant_id", "sku", "parent_title", "proposed_format", "source"].join(",")];
  for (const d of decisions) {
    lines.push(
      [
        cell(d.variant_id),
        cell(d.sku),
        cell(d.parent_title),
        cell(d.proposed_format ?? ""),
        cell(d.source),
      ].join(","),
    );
  }
  writeFileSync(planPath, lines.join("\n"), "utf8");
  console.log(`\n[plan] CSV: ${planPath}`);

  if (!APPLY) {
    console.log(`\nDry-run complete. Re-run with --apply to write format_name.`);
    return;
  }

  // -------------------------------------------------------------------------
  // APPLY MODE — batched updates
  // -------------------------------------------------------------------------
  let nUpdated = 0;
  let nFailed = 0;
  // Group by format value to use a single .in() update per group
  const byFmt = new Map<string, string[]>();
  for (const d of resolvable) {
    const arr = byFmt.get(d.proposed_format ?? "") ?? [];
    arr.push(d.variant_id);
    byFmt.set(d.proposed_format ?? "", arr);
  }
  for (const [fmt, ids] of byFmt) {
    if (!fmt) continue;
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { error: upErr, count } = await sb
        .from("warehouse_product_variants")
        .update({ format_name: fmt }, { count: "exact" })
        .in("id", slice);
      if (upErr) {
        console.log(`  -> chunk failed (${slice.length} variants): ${upErr.message}`);
        nFailed += slice.length;
      } else {
        nUpdated += count ?? slice.length;
      }
    }
    console.log(`  [apply] format="${fmt}" → ${ids.length} variants`);
  }

  console.log(`\n[apply] done. updated=${nUpdated} failed=${nFailed}`);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
