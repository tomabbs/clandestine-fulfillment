/**
 * Import the inventory-master "no_match" SKUs (115 items) into the database
 * AND the Clandestine Shopify store as DRAFT products.
 *
 * READ-ONLY by default. Use `--apply` to perform writes.
 *
 * Usage:
 *   pnpm tsx scripts/import-missing-skus.ts            # dry-run (default)
 *   pnpm tsx scripts/import-missing-skus.ts --apply    # execute writes
 *   pnpm tsx scripts/import-missing-skus.ts --apply --limit 5
 *
 * Inventory levels are NEVER imported. Only SKU + product metadata + format.
 */

import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  fetchProductVariantsByProductId,
  productArchive,
  productSetCreate,
} from "@/lib/clients/shopify-client";
import { buildShopifyVariantInput } from "@/lib/clients/shopify-variant-input";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { classifyProduct, type ProductCategory } from "@/lib/shared/product-categories";
import { detectFormat } from "@/trigger/lib/format-detection";

config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const CREATE_ORGS = process.argv.includes("--create-orgs");
const limitArgIdx = process.argv.indexOf("--limit");
const LIMIT = limitArgIdx >= 0 ? Number.parseInt(process.argv[limitArgIdx + 1], 10) : null;

const FILES = [
  "/Users/tomabbs/Downloads/avant 1.xlsx",
  "/Users/tomabbs/Downloads/redeye over.xlsx",
  "/Users/tomabbs/Downloads/gr.xlsx",
  "/Users/tomabbs/Downloads/anacortes.xlsx",
  "/Users/tomabbs/Downloads/Master page.xlsx",
];

const PROVENANCE_TAG = "import:inventory-master:2026-04-20";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RawRow = {
  source_file: string;
  rowIdx: number;
  rawSku: string;
  normSku: string;
  format: string;
  label: string;
  artistTitle: string;
};

type Group = {
  groupKey: string;
  /** True for shirt-prefixed SKUs that share the prefix and have size-suffixes. */
  isMultiSize: boolean;
  rows: RawRow[];
  /** Computed: parent product title (size suffixes stripped). */
  productTitle: string;
  /** Format key: LP / CD / Cassette / 7" / T-Shirt / Other. */
  format: string;
  /** ProductCategory for weight defaults. */
  category: ProductCategory;
  /** Vendor display name (resolved from existing DB or label). */
  vendor: string;
  /** Resolved org_id, or null if unresolvable. */
  org_id: string | null;
  /** Resolution method (for audit). */
  org_method: string;
  /** Reason it was skipped, if any. */
  skipReason?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normSku(value: string | null | undefined): string {
  if (!value) return "";
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function normLabel(value: string | null | undefined): string {
  if (!value) return "";
  return String(value).trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
}

const SIZE_TOKENS = new Set([
  "XXS",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "XXL",
  "XXXL",
  "WS",
  "WM",
  "WL",
  "WXL",
]);

/** Returns [groupKey, sizeToken] if the SKU's last token is a size, else null. */
function splitSizeSuffix(sku: string): { groupKey: string; size: string } | null {
  const tokens = sku.split("-");
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1];
  if (!SIZE_TOKENS.has(last)) return null;
  return { groupKey: tokens.slice(0, -1).join("-"), size: last };
}

/** Strip a trailing " - <Size>" from the artist-title for the parent title. */
function stripSizeSuffixFromTitle(title: string): string {
  return title.replace(
    /\s*[-–—]\s*(extra small|extra extra small|extra large|extra extra large|small|medium|large|x[- ]?small|x[- ]?large|xx[- ]?large|xxs|xs|s|m|l|xl|xxl|xxxl|w?s|w?m|w?l|w?xl)\s*$/i,
    "",
  );
}

function readXlsx(path: string): RawRow[] {
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
  if (headerIdx === -1) return [];
  const header = rows[headerIdx].map((c) => String(c ?? "").trim().toLowerCase());
  const skuCol = header.indexOf("sku");
  const formatCol = header.indexOf("format");
  const labelCol = header.indexOf("label");
  const artistTitleCol = header.findIndex((h) => h.startsWith("artist") && h.includes("title"));
  const out: RawRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const rawSku = String(r[skuCol] ?? "").trim();
    const format = String(r[formatCol] ?? "").trim();
    const label = labelCol >= 0 ? String(r[labelCol] ?? "").trim() : "";
    const artistTitle = artistTitleCol >= 0 ? String(r[artistTitleCol] ?? "").trim() : "";
    if (!rawSku && !artistTitle && !format) continue;
    out.push({
      source_file: path.split("/").pop() ?? path,
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

/** Format a sheet's free-text format string into our canonical format_name. */
function canonicalizeSheetFormat(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (t === "lp" || t === "vinyl" || t === "12\"" || t === "12 inch") return "LP";
  if (t === "cd" || t === "compact disc") return "CD";
  if (t === "cassette" || t === "tape" || t === "cs") return "Cassette";
  if (t === "7\"" || t === "7" || t === "7 inch" || t === "flexi") return '7"';
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

const FORMAT_TO_PRODUCT_TYPE: Record<string, string> = {
  LP: "Vinyl",
  CD: "CD",
  Cassette: "Cassette",
  '7"': '7" Single',
  "T-Shirt": "Apparel",
  Other: "Merch",
};

const FORMAT_TO_CATEGORY: Record<string, ProductCategory> = {
  LP: "vinyl",
  CD: "cd",
  Cassette: "cassette",
  '7"': "vinyl",
  "T-Shirt": "apparel",
  Other: "merch",
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[mode] ${APPLY ? "APPLY (will write to DB + Shopify)" : "DRY-RUN"}`);
  if (LIMIT) console.log(`[limit] processing first ${LIMIT} groups`);

  // Step 1: read all five XLSX, collect ONLY the rows that the prior audit
  // classified as no_match. Easiest cross-reference is by SKU presence in DB:
  // if a row's SKU isn't already in warehouse_product_variants, it's a no_match.
  const sb = createServiceRoleClient();

  // Load entire SKU set from DB for O(1) presence checks.
  const dbSkus = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("sku")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      const ns = normSku(r.sku);
      if (ns) dbSkus.add(ns);
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[load] db SKU index: ${dbSkus.size} variants`);

  // Aggregate raw rows.
  const allRows: RawRow[] = [];
  for (const f of FILES) {
    const rows = readXlsx(f);
    allRows.push(...rows);
  }
  console.log(`[load] xlsx rows: ${allRows.length}`);

  // Filter to no_match only (SKU present, not in DB).
  let candidates = allRows.filter((r) => r.normSku && !dbSkus.has(r.normSku));
  console.log(`[filter] candidates with SKU + not in DB: ${candidates.length}`);

  // Junk filters.
  const skipReasons: Array<{ row: RawRow; reason: string }> = [];
  candidates = candidates.filter((r) => {
    if (r.normSku.length < 4) {
      skipReasons.push({ row: r, reason: "sku_too_short" });
      return false;
    }
    if (r.normSku === "TOTE" || r.label.trim() === "??" || r.label.trim() === "?") {
      skipReasons.push({ row: r, reason: "junk_row" });
      return false;
    }
    if (r.artistTitle.trim() === "?") {
      skipReasons.push({ row: r, reason: "no_artist_title" });
      return false;
    }
    return true;
  });

  // Detect duplicate SKUs across rows (same SKU appears more than once with
  // different titles → ambiguous, skip both).
  const skuToRows = new Map<string, RawRow[]>();
  for (const r of candidates) {
    const arr = skuToRows.get(r.normSku) ?? [];
    arr.push(r);
    skuToRows.set(r.normSku, arr);
  }
  const ambiguousSkus = new Set<string>();
  for (const [sku, arr] of skuToRows) {
    if (arr.length > 1) {
      // Allow if all titles are identical.
      const titles = new Set(arr.map((r) => r.artistTitle.trim().toLowerCase()));
      if (titles.size > 1) {
        ambiguousSkus.add(sku);
        for (const r of arr) skipReasons.push({ row: r, reason: "duplicate_sku_in_source" });
      }
    }
  }
  candidates = candidates.filter((r) => !ambiguousSkus.has(r.normSku));

  // Dedupe identical rows by sku (keep first).
  const seen = new Set<string>();
  candidates = candidates.filter((r) => {
    if (seen.has(r.normSku)) return false;
    seen.add(r.normSku);
    return true;
  });
  console.log(`[filter] after junk + dedup: ${candidates.length}`);

  // Step 2: build org/vendor lookup from existing warehouse_products. Uses the
  // org with the most products under that vendor (handles duplicate-org rows).
  const { data: vendorRows } = await sb
    .from("warehouse_products")
    .select("vendor, org_id")
    .not("vendor", "is", null);
  const vendorOrgCount = new Map<string, Map<string, number>>(); // normLabel(vendor) → org_id → count
  const vendorDisplay = new Map<string, string>(); // normLabel(vendor) → display vendor
  for (const r of vendorRows ?? []) {
    const v = String(r.vendor ?? "").trim();
    if (!v || !r.org_id) continue;
    const key = normLabel(v);
    if (!vendorDisplay.has(key)) vendorDisplay.set(key, v);
    const sub = vendorOrgCount.get(key) ?? new Map();
    sub.set(r.org_id, (sub.get(r.org_id) ?? 0) + 1);
    vendorOrgCount.set(key, sub);
  }

  const { data: orgRows } = await sb.from("organizations").select("id, name, slug");
  const orgByName = new Map<string, { id: string; name: string }>();
  for (const o of orgRows ?? []) {
    if (o.name) orgByName.set(normLabel(o.name), { id: o.id, name: o.name });
  }

  function resolveOrg(label: string): { org_id: string | null; method: string; vendor: string } {
    const k = normLabel(label);
    if (!k) return { org_id: null, method: "no_label", vendor: label };

    // 1. existing vendor → most common org
    const sub = vendorOrgCount.get(k);
    if (sub && sub.size > 0) {
      const [topOrgId] = [...sub.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        org_id: topOrgId,
        method: "vendor_match",
        vendor: vendorDisplay.get(k) ?? label,
      };
    }
    // 2. exact org name match
    const exact = orgByName.get(k);
    if (exact) return { org_id: exact.id, method: "org_exact_name", vendor: exact.name };
    // 3. fuzzy: a single org whose normalized name *contains* the label or vice versa
    const fuzzy: Array<{ id: string; name: string }> = [];
    for (const [n, o] of orgByName) {
      if (n.includes(k) || k.includes(n)) fuzzy.push(o);
    }
    if (fuzzy.length === 1) {
      return { org_id: fuzzy[0].id, method: "org_fuzzy_unique", vendor: fuzzy[0].name };
    }
    // 4. composite labels like "Northern Spy/Fish of Milk" → try the first segment
    if (label.includes("/")) {
      return resolveOrg(label.split("/")[0]);
    }
    return { org_id: null, method: "unresolved", vendor: label };
  }

  // Step 3: group rows. Multi-size shirt clusters share a prefix; otherwise
  // each row is its own group.
  const shirtGroups = new Map<string, RawRow[]>(); // groupKey → rows (size-bearing)
  const standalone: RawRow[] = [];
  for (const r of candidates) {
    if (!r.normSku.startsWith("SHIRT-")) {
      standalone.push(r);
      continue;
    }
    const sz = splitSizeSuffix(r.normSku);
    if (!sz) {
      standalone.push(r);
      continue;
    }
    const arr = shirtGroups.get(sz.groupKey) ?? [];
    arr.push(r);
    shirtGroups.set(sz.groupKey, arr);
  }
  // Singletons in the shirt map become standalone (still SHIRT-format though)
  for (const [k, arr] of [...shirtGroups]) {
    if (arr.length < 2) {
      shirtGroups.delete(k);
      standalone.push(...arr);
    }
  }
  console.log(
    `[group] shirt multi-size groups: ${shirtGroups.size}, standalone rows: ${standalone.length}`,
  );

  // Build group objects.
  const groups: Group[] = [];

  function buildGroupCommon(rows: RawRow[], groupKey: string, isMulti: boolean): Group {
    const first = rows[0];
    const { org_id, method, vendor } = resolveOrg(first.label);
    // Title: for multi-size, common base; otherwise raw.
    let baseTitle = isMulti
      ? stripSizeSuffixFromTitle(first.artistTitle).trim()
      : first.artistTitle.trim();
    // Fallback: empty title → derive from SKU + label so the draft is not nameless.
    if (baseTitle.length < 3) {
      baseTitle = first.label.trim().length > 0
        ? `${first.label.trim()} — ${first.normSku}`
        : first.normSku;
    }

    // Format priority: sheet hint → SKU prefix detect → title detect.
    let fmt =
      canonicalizeSheetFormat(first.format) ??
      detectFormat({ sku: first.normSku, name: baseTitle }).formatKey;
    if (fmt === "unknown" || !["LP", "CD", "Cassette", '7"', "T-Shirt", "Other"].includes(fmt)) {
      // Last resort: classifyProduct for category → format mapping
      const cat = classifyProduct(null, null, baseTitle);
      fmt =
        cat === "vinyl"
          ? "LP"
          : cat === "cd"
            ? "CD"
            : cat === "cassette"
              ? "Cassette"
              : cat === "apparel"
                ? "T-Shirt"
                : "Other";
    }
    const cat = FORMAT_TO_CATEGORY[fmt] ?? "merch";
    const productType = FORMAT_TO_PRODUCT_TYPE[fmt] ?? "Merch";

    return {
      groupKey,
      isMultiSize: isMulti,
      rows,
      productTitle: baseTitle.length > 0 ? baseTitle : groupKey,
      format: fmt,
      category: cat,
      vendor,
      org_id,
      org_method: method,
      skipReason: org_id ? undefined : "org_unresolved",
    };
    // productType is used at Shopify call site; not stored on the group object
    // because TS already infers it from the format mapping.
  }

  for (const [groupKey, rows] of shirtGroups) {
    groups.push(buildGroupCommon(rows, groupKey, true));
  }
  for (const r of standalone) {
    groups.push(buildGroupCommon([r], r.normSku, false));
  }

  console.log(`[group] total groups: ${groups.length}`);
  const groupsToWrite = groups.filter((g) => !g.skipReason);
  const groupsSkipped = groups.filter((g) => g.skipReason);
  console.log(`[group] writable: ${groupsToWrite.length}, skipped: ${groupsSkipped.length}`);

  // Output dry-run plans + skip reasons regardless of mode.
  const outDir = join(process.cwd(), "reports", "finish-line", "import-plans");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const planCsvPath = join(outDir, `import-plan-${stamp}.csv`);
  const skipCsvPath = join(outDir, `import-skipped-${stamp}.csv`);
  const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;

  const planLines: string[] = [
    [
      "group_key",
      "is_multi_size",
      "n_variants",
      "product_title",
      "format",
      "category",
      "vendor",
      "org_id",
      "org_method",
      "skus",
      "source_files",
    ].join(","),
  ];
  for (const g of groupsToWrite) {
    planLines.push(
      [
        cell(g.groupKey),
        g.isMultiSize ? "true" : "false",
        g.rows.length,
        cell(g.productTitle),
        cell(g.format),
        cell(g.category),
        cell(g.vendor),
        cell(g.org_id),
        cell(g.org_method),
        cell(g.rows.map((r) => r.normSku).join("|")),
        cell([...new Set(g.rows.map((r) => r.source_file))].join("|")),
      ].join(","),
    );
  }
  writeFileSync(planCsvPath, planLines.join("\n"), "utf8");

  const skipLines: string[] = [
    ["group_key", "n_rows", "label", "vendor", "skus", "reason", "source_files"].join(","),
  ];
  for (const g of groupsSkipped) {
    skipLines.push(
      [
        cell(g.groupKey),
        g.rows.length,
        cell(g.rows[0]?.label ?? ""),
        cell(g.vendor),
        cell(g.rows.map((r) => r.normSku).join("|")),
        cell(g.skipReason ?? ""),
        cell([...new Set(g.rows.map((r) => r.source_file))].join("|")),
      ].join(","),
    );
  }
  for (const s of skipReasons) {
    skipLines.push(
      [
        cell(s.row.normSku),
        1,
        cell(s.row.label),
        "",
        cell(s.row.normSku),
        cell(s.reason),
        cell(s.row.source_file),
      ].join(","),
    );
  }
  writeFileSync(skipCsvPath, skipLines.join("\n"), "utf8");

  console.log(`\n[plan] writable group breakdown by format:`);
  const byFmt = new Map<string, number>();
  for (const g of groupsToWrite) byFmt.set(g.format, (byFmt.get(g.format) ?? 0) + 1);
  for (const [k, c] of [...byFmt.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.toString().padStart(4)}  ${k}`);
  }
  console.log(`\n[plan] CSV: ${planCsvPath}`);
  console.log(`[plan] SKIP CSV: ${skipCsvPath}`);

  if (!APPLY) {
    console.log(`\nDry-run complete. Re-run with --apply to perform writes.`);
    return;
  }

  // -------------------------------------------------------------------------
  // APPLY MODE
  // -------------------------------------------------------------------------
  const { data: workspaceRow } = await sb.from("workspaces").select("id").limit(1).single();
  const workspaceId = workspaceRow?.id;
  if (!workspaceId) throw new Error("no workspace found");

  // Auto-create orgs for unresolved labels if --create-orgs is set.
  if (CREATE_ORGS) {
    const labelsNeedingOrg = new Set<string>();
    for (const g of groupsSkipped) {
      if (g.skipReason === "org_unresolved" && g.rows[0]?.label?.trim()) {
        labelsNeedingOrg.add(g.rows[0].label.trim());
      }
    }
    for (const label of labelsNeedingOrg) {
      const slug = normLabel(label).replace(/\s+/g, "-").slice(0, 60);
      const { data: existing } = await sb
        .from("organizations")
        .select("id, name")
        .eq("workspace_id", workspaceId)
        .eq("slug", slug)
        .maybeSingle();
      let newOrgId: string;
      if (existing) {
        newOrgId = existing.id;
        console.log(`[create-orgs] reused existing org for "${label}" (slug=${slug})`);
      } else {
        const { data: newOrg, error: orgErr } = await sb
          .from("organizations")
          .insert({
            workspace_id: workspaceId,
            name: label,
            slug,
            onboarding_state: { source: "imported_from_inventory_master_2026_04_20" },
          })
          .select("id")
          .single();
        if (orgErr || !newOrg) {
          console.log(`[create-orgs] FAILED for "${label}": ${orgErr?.message ?? "unknown"}`);
          continue;
        }
        newOrgId = newOrg.id;
        console.log(`[create-orgs] created org "${label}" id=${newOrgId} slug=${slug}`);
      }
      // Re-attach all groups for this label.
      for (const g of groupsSkipped) {
        if (g.skipReason === "org_unresolved" && g.rows[0]?.label?.trim() === label) {
          g.org_id = newOrgId;
          g.org_method = "auto_created";
          g.skipReason = undefined;
          g.vendor = label;
          groupsToWrite.push(g);
        }
      }
    }
    console.log(`[create-orgs] groupsToWrite now: ${groupsToWrite.length}`);
  }

  let nProducts = 0;
  let nVariants = 0;
  let nShopifyDrafts = 0;
  let nFailed = 0;
  const failures: Array<{ groupKey: string; error: string }> = [];

  const toProcess = LIMIT ? groupsToWrite.slice(0, LIMIT) : groupsToWrite;
  console.log(`\n[apply] processing ${toProcess.length} groups …`);

  for (const g of toProcess) {
    try {
      console.log(
        `[apply] ${g.groupKey}  fmt=${g.format}  variants=${g.rows.length}  vendor="${g.vendor}"`,
      );

      // 3a. Final pre-flight collision check (race-safe) — skip if any SKU now exists.
      const skus = g.rows.map((r) => r.normSku);
      const { data: collisions } = await sb
        .from("warehouse_product_variants")
        .select("sku")
        .eq("workspace_id", workspaceId)
        .in("sku", skus);
      if (collisions && collisions.length > 0) {
        console.log(`  -> skip: pre-flight collision: ${collisions.map((c) => c.sku).join(",")}`);
        continue;
      }

      // 3b. Insert warehouse_products
      if (!g.org_id) throw new Error("no org_id");
      const productType = FORMAT_TO_PRODUCT_TYPE[g.format] ?? "Merch";
      const { data: prodRow, error: prodErr } = await sb
        .from("warehouse_products")
        .insert({
          workspace_id: workspaceId,
          org_id: g.org_id,
          title: `${g.productTitle}${g.format !== "Other" ? ` ${g.format}` : ""}`.trim(),
          vendor: g.vendor,
          product_type: productType,
          status: "draft",
          tags: ["imported_from_inventory_master"],
        })
        .select("id")
        .single();
      if (prodErr || !prodRow) throw prodErr ?? new Error("product insert returned no row");
      nProducts++;

      // 3c. Insert variants (one per row)
      const variantInserts = g.rows.map((r) => {
        const sz = g.isMultiSize ? splitSizeSuffix(r.normSku) : null;
        const optionName = g.isMultiSize ? "Size" : "Title";
        const optionValue = sz?.size ?? "Default Title";
        return {
          product_id: prodRow.id,
          workspace_id: workspaceId,
          sku: r.normSku,
          title: optionValue,
          option1_name: optionName,
          option1_value: optionValue,
          format_name: g.format,
        };
      });
      const { data: variantRows, error: varErr } = await sb
        .from("warehouse_product_variants")
        .insert(variantInserts)
        .select("id, sku");
      if (varErr || !variantRows) throw varErr ?? new Error("variant insert returned no rows");
      nVariants += variantRows.length;

      // 3d. Shopify productSetCreate (DRAFT)
      const shopifyVariants = variantInserts.map((v) =>
        buildShopifyVariantInput({
          sku: v.sku,
          category: g.category,
          ...(g.isMultiSize ? { optionName: "Size", optionValue: v.option1_value } : {}),
        }),
      );
      const productOptions = g.isMultiSize
        ? [
            {
              name: "Size",
              values: variantInserts.map((v) => ({ name: v.option1_value })),
            },
          ]
        : [{ name: "Title", values: [{ name: "Default Title" }] }];

      let shopifyProductId: string;
      try {
        shopifyProductId = await productSetCreate({
          title: `${g.productTitle}${g.format !== "Other" ? ` ${g.format}` : ""}`.trim(),
          status: "DRAFT",
          vendor: g.vendor,
          productType,
          tags: [PROVENANCE_TAG],
          productOptions,
          variants: shopifyVariants,
        });
        nShopifyDrafts++;
      } catch (shopErr) {
        // Roll back DB rows so re-runs are idempotent (no orphan DB without Shopify draft).
        await sb.from("warehouse_product_variants").delete().eq("product_id", prodRow.id);
        await sb.from("warehouse_products").delete().eq("id", prodRow.id);
        throw new Error(`productSetCreate failed (DB rolled back): ${String(shopErr)}`);
      }

      // 3e. Backfill shopify IDs.
      try {
        const shopifyVars = await fetchProductVariantsByProductId(shopifyProductId);
        const bySku = new Map<string, { id: string; inventoryItemId: string | null }>();
        for (const sv of shopifyVars) {
          if (sv.sku) bySku.set(sv.sku, { id: sv.id, inventoryItemId: sv.inventoryItemId });
        }
        for (const v of variantRows) {
          const m = bySku.get(v.sku);
          if (m) {
            await sb
              .from("warehouse_product_variants")
              .update({
                shopify_variant_id: m.id,
                shopify_inventory_item_id: m.inventoryItemId,
              })
              .eq("id", v.id);
          }
        }
        await sb
          .from("warehouse_products")
          .update({
            shopify_product_id: shopifyProductId,
            synced_at: new Date().toISOString(),
          })
          .eq("id", prodRow.id);
      } catch (bfErr) {
        console.log(`  -> shopify ID backfill failed: ${String(bfErr)} — archiving Shopify product`);
        await productArchive(shopifyProductId).catch(() => {});
        nFailed++;
        failures.push({ groupKey: g.groupKey, error: `backfill_failed: ${String(bfErr)}` });
        continue;
      }
    } catch (err) {
      nFailed++;
      failures.push({ groupKey: g.groupKey, error: String(err) });
      console.log(`  -> FAILED: ${String(err)}`);
    }
  }

  console.log(`\n[apply] done`);
  console.log(`  products=${nProducts}  variants=${nVariants}  shopify_drafts=${nShopifyDrafts}`);
  console.log(`  failed=${nFailed}`);
  if (failures.length > 0) {
    const failPath = join(outDir, `import-failures-${stamp}.json`);
    writeFileSync(failPath, JSON.stringify(failures, null, 2));
    console.log(`  failures: ${failPath}`);
  }
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
