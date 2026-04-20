/**
 * ShipStation product-import exporter — shared between:
 *   - CLI:     `scripts/export-shipstation-import.ts`
 *   - Trigger: `src/trigger/tasks/shipstation-export.ts`
 *   - Action:  via the Trigger task (Server Actions never call this directly
 *              because the work easily exceeds 30s — Rule #41).
 *
 * Builds a 30-column CSV + XLSX matching ShipStation's product-import
 * template. Only `SKU` and `Name` are required by ShipStation; the other
 * 28 columns are best-effort populated from existing DB data.
 *
 * Two modes:
 *   - mode: 'full'         → every variant
 *   - mode: 'incremental'  → variants where `created_at > sinceTs` (NEW only;
 *                            does NOT pick up edits to existing variants).
 *
 * Returns the file bytes in-memory plus a coverage summary. Callers decide
 * where to write — disk for the CLI, Supabase Storage for the Trigger task.
 */

import * as XLSX from "xlsx";
import type { createServiceRoleClient } from "@/lib/server/supabase-server";

type Sb = ReturnType<typeof createServiceRoleClient>;

const IN_CHUNK = 200;

export const SHIPSTATION_COLUMNS = [
  "SKU",
  "Name",
  "Description",
  "Fulfillment Barcode",
  "Warehouse Location",
  "Weight",
  "Length",
  "Width",
  "Height",
  "Category",
  "Tag 1",
  "Tag 2",
  "Tag 3",
  "Tag 4",
  "Tag 5",
  "Customs Description",
  "Customs Value",
  "Customs Tariff No",
  "Customs Manufacturer Identification Code",
  "Customs Country",
  "Thumbnail Url",
  "UPC",
  "Fill SKU",
  "Parent SKU",
  "Use Product Name",
  "Active",
  "Is Returnable",
  "Track inventory",
  "Packaging Requirements",
  "Package Preference",
] as const;

export type ShipstationColumn = (typeof SHIPSTATION_COLUMNS)[number];
export type ShipstationRow = Record<ShipstationColumn, string>;

export interface BuildShipstationExportOptions {
  supabase: Sb;
  /**
   * When set, only variants with `warehouse_product_variants.created_at >
   * sinceTs` are included. Use the previous run's `data_max_ts` to chain
   * incremental exports.
   */
  sinceTs?: string | null;
}

export interface ShipstationExportResult {
  rows: ShipstationRow[];
  csv: string;
  xlsx: Uint8Array;
  summary: {
    mode: "full" | "incremental";
    since_ts: string | null;
    /** max(created_at) of the variants included — basis for the next incremental run. */
    data_max_ts: string | null;
    total_variants_loaded: number;
    rows_written: number;
    duplicates_skipped: number;
    coverage: Record<string, number>;
    duplicate_skus: Array<{
      sku: string;
      keptVariantId: string;
      skippedVariantId: string;
      keptProductId: string;
      skippedProductId: string;
      note: string;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/**
 * Strip BOM (U+FEFF) and zero-width characters that have been observed in
 * imported SKUs from spreadsheets. ShipStation treats these as part of the
 * SKU and would silently create separate products — always strip before
 * comparing or writing.
 */
// Use alternation rather than a character class — `noMisleadingCharacterClass`
// flags U+200D (ZWJ) inside a class because it composes emoji sequences. We
// only ever want to strip these single code points, so alternation is correct.
const ZERO_WIDTH_RE = /\uFEFF|\u200B|\u200C|\u200D|\u2060/g;

function cleanSku(s: string): string {
  return s.replace(ZERO_WIDTH_RE, "").trim();
}

function weightOz(weight: number | null, unit: string | null): string {
  if (weight == null || Number.isNaN(weight) || weight === 0) return "";
  const u = (unit ?? "lb").toLowerCase();
  let oz = weight;
  if (u === "lb" || u === "lbs" || u === "pound" || u === "pounds") oz = weight * 16;
  else if (u === "g" || u === "gram" || u === "grams") oz = weight * 0.035274;
  else if (u === "kg" || u === "kilogram" || u === "kilograms") oz = weight * 35.274;
  return (Math.round(oz * 100) / 100).toString();
}

function customsDescriptionForFormat(format: string | null, productType: string | null): string {
  const f = (format ?? "").toLowerCase();
  if (f === "lp") return "Vinyl LP record";
  if (f === '7"') return "7-inch vinyl record";
  if (f === "cd") return "Compact disc (CD)";
  if (f === "cassette") return "Cassette tape";
  if (f === "t-shirt") return "T-shirt apparel";
  const t = (productType ?? "").toLowerCase();
  if (t.includes("book") || t.includes("zine")) return "Printed book";
  if (t.includes("poster") || t.includes("print")) return "Printed poster";
  if (t.includes("bag") || t.includes("tote")) return "Tote bag / canvas bag";
  if (t.includes("apparel") || t.includes("hat") || t.includes("hoodie")) return "Apparel item";
  return "Music merchandise";
}

function pickUpc(bandcampUpc: string | null, barcode: string | null): string {
  const isCode = (s: string | null) => !!s && /^\d{12,14}$/.test(s.trim());
  if (isCode(bandcampUpc)) return bandcampUpc!.trim();
  if (isCode(barcode)) return barcode!.trim();
  return "";
}

function splitArtistTitle(
  rawTitle: string,
  vendor: string | null,
): { artist: string; title: string } {
  const t = rawTitle.trim();
  for (const sep of [" - ", " — ", " – "]) {
    const idx = t.indexOf(sep);
    if (idx > 0 && idx < t.length - sep.length) {
      const left = t.slice(0, idx).trim();
      const right = t.slice(idx + sep.length).trim();
      if (left && right) return { artist: left, title: right };
    }
  }
  return { artist: vendor?.trim() ?? "", title: t };
}

function csvCell(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function csvLine(values: string[]): string {
  return values.map(csvCell).join(",");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type VariantRow = {
  id: string;
  sku: string;
  title: string | null;
  barcode: string | null;
  weight: number | null;
  weight_unit: string | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  cost: number | null;
  price: number | null;
  option1_value: string | null;
  format_name: string | null;
  bandcamp_option_title: string | null;
  hs_tariff_code: string | null;
  is_preorder: boolean | null;
  created_at: string | null;
  warehouse_products: {
    id: string;
    title: string;
    vendor: string | null;
    product_type: string | null;
    status: string | null;
    bandcamp_upc: string | null;
    org_id: string | null;
    organizations: { id: string; name: string } | null;
  } | null;
};

export async function buildShipstationExport(
  opts: BuildShipstationExportOptions,
): Promise<ShipstationExportResult> {
  const { supabase, sinceTs = null } = opts;
  const mode: "full" | "incremental" = sinceTs ? "incremental" : "full";

  // ----- 1. Variants joined to product + org -----
  const variants: VariantRow[] = [];
  const PAGE = 1000;
  let from = 0;
  let last = PAGE;
  while (last === PAGE) {
    let q = supabase
      .from("warehouse_product_variants")
      .select(
        `
        id, sku, title, barcode, weight, weight_unit, length_in, width_in, height_in,
        cost, price, option1_value, format_name, bandcamp_option_title,
        hs_tariff_code, is_preorder, created_at,
        warehouse_products(
          id, title, vendor, product_type, status, bandcamp_upc, org_id,
          organizations(id, name)
        )
      `,
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (sinceTs) q = q.gt("created_at", sinceTs);
    const { data, error } = await q;
    if (error) throw new Error(`variants query: ${error.message}`);
    const batch = (data ?? []) as unknown as VariantRow[];
    variants.push(...batch);
    last = batch.length;
    from += PAGE;
  }

  // ----- 2. Locations per variant -----
  const variantIds = variants.map((v) => v.id);
  type VarLoc = {
    variant_id: string;
    quantity: number;
    warehouse_locations: { name: string } | null;
  };
  const locsByVariant = new Map<string, string[]>();
  for (let i = 0; i < variantIds.length; i += IN_CHUNK) {
    const chunk = variantIds.slice(i, i + IN_CHUNK);
    if (chunk.length === 0) continue;
    const { data, error } = await supabase
      .from("warehouse_variant_locations")
      .select("variant_id, quantity, warehouse_locations(name)")
      .in("variant_id", chunk);
    if (error) throw new Error(`variant_locations query: ${error.message}`);
    for (const r of (data ?? []) as unknown as VarLoc[]) {
      const name = r.warehouse_locations?.name;
      if (!name) continue;
      const arr = locsByVariant.get(r.variant_id) ?? [];
      arr.push(name);
      locsByVariant.set(r.variant_id, arr);
    }
  }

  // ----- 3. Bandcamp mapping for image fallback + provenance tagging -----
  type Mapping = {
    variant_id: string;
    bandcamp_image_url: string | null;
    bandcamp_art_url: string | null;
  };
  const mappingByVariant = new Map<string, Mapping>();
  for (let i = 0; i < variantIds.length; i += IN_CHUNK) {
    const chunk = variantIds.slice(i, i + IN_CHUNK);
    if (chunk.length === 0) continue;
    const { data, error } = await supabase
      .from("bandcamp_product_mappings")
      .select("variant_id, bandcamp_image_url, bandcamp_art_url")
      .in("variant_id", chunk);
    if (error) throw new Error(`mappings query: ${error.message}`);
    for (const m of (data ?? []) as Mapping[]) mappingByVariant.set(m.variant_id, m);
  }

  // ----- 4. First image per product (lowest position) -----
  const productIds = Array.from(
    new Set(variants.map((v) => v.warehouse_products?.id).filter(Boolean) as string[]),
  );
  type ImgRow = { product_id: string; src: string; position: number | null };
  const firstImgByProduct = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += IN_CHUNK) {
    const chunk = productIds.slice(i, i + IN_CHUNK);
    if (chunk.length === 0) continue;
    const { data, error } = await supabase
      .from("warehouse_product_images")
      .select("product_id, src, position")
      .in("product_id", chunk)
      .order("position", { ascending: true, nullsFirst: false });
    if (error) throw new Error(`images query: ${error.message}`);
    for (const r of (data ?? []) as ImgRow[]) {
      if (!firstImgByProduct.has(r.product_id) && r.src) {
        firstImgByProduct.set(r.product_id, r.src);
      }
    }
  }

  // ----- 5. Build rows -----
  const rows: ShipstationRow[] = [];
  const skuSeen = new Map<string, { variantId: string; productId: string }>();
  const dupes: ShipstationExportResult["summary"]["duplicate_skus"] = [];
  let dataMaxTs: string | null = null;

  const coverage: Record<string, number> = {
    sku: 0,
    name: 0,
    description: 0,
    barcode: 0,
    location: 0,
    weight: 0,
    dimensions_full: 0,
    dimensions_partial: 0,
    category: 0,
    tag_format: 0,
    tag_label: 0,
    tag_vendor: 0,
    customs_description: 0,
    customs_value: 0,
    customs_tariff: 0,
    thumbnail: 0,
    upc: 0,
    active_yes: 0,
    active_no: 0,
  };

  for (const v of variants) {
    const p = v.warehouse_products;
    if (!p) continue;
    const rawSku = v.sku ?? "";
    const sku = cleanSku(rawSku);
    if (!sku) continue;

    const prev = skuSeen.get(sku);
    if (prev) {
      const hadInvisibles = rawSku !== rawSku.replace(ZERO_WIDTH_RE, "");
      dupes.push({
        sku,
        keptVariantId: prev.variantId,
        skippedVariantId: v.id,
        keptProductId: prev.productId,
        skippedProductId: p.id,
        note: hadInvisibles
          ? "skipped variant SKU contained zero-width characters (likely BOM from spreadsheet import)"
          : "true duplicate SKU across two warehouse_products rows",
      });
      continue;
    }
    skuSeen.set(sku, { variantId: v.id, productId: p.id });

    if (v.created_at && (!dataMaxTs || v.created_at > dataMaxTs)) dataMaxTs = v.created_at;

    coverage.sku++;

    const split = splitArtistTitle(p.title, p.vendor);
    const variantSuffix =
      v.bandcamp_option_title?.trim() ||
      v.option1_value?.trim() ||
      (v.title && v.title !== "Default Title" ? v.title.trim() : "");
    const formatSuffix = v.format_name && v.format_name !== "Other" ? ` (${v.format_name})` : "";
    const nameRaw = normalizeName(
      [
        split.artist,
        split.title || p.title,
        variantSuffix && !split.title.includes(variantSuffix) ? `- ${variantSuffix}` : "",
      ]
        .filter(Boolean)
        .join(" - "),
    );
    const name = truncate(`${nameRaw}${formatSuffix}`, 200);
    if (name) coverage.name++;

    const description = truncate(
      [p.title, variantSuffix, v.format_name].filter(Boolean).join(" — "),
      500,
    );
    if (description) coverage.description++;

    const barcode = (v.barcode ?? "").trim();
    if (barcode) coverage.barcode++;

    const locs = locsByVariant.get(v.id) ?? [];
    const location = locs.join("; ");
    if (location) coverage.location++;

    const weightStr = weightOz(v.weight, v.weight_unit);
    if (weightStr) coverage.weight++;

    const len = v.length_in != null ? v.length_in.toString() : "";
    const wid = v.width_in != null ? v.width_in.toString() : "";
    const hgt = v.height_in != null ? v.height_in.toString() : "";
    const dimSet = [len, wid, hgt].filter(Boolean).length;
    if (dimSet === 3) coverage.dimensions_full++;
    else if (dimSet > 0) coverage.dimensions_partial++;

    const category = p.product_type?.trim() || v.format_name || "";
    if (category) coverage.category++;

    const tag1 = v.format_name ?? "";
    const tag2 = p.organizations?.name ?? "";
    const tag3 = p.vendor ?? "";
    const isBandcamp = mappingByVariant.has(v.id);
    const tag4 = isBandcamp ? "bandcamp" : "shopify";
    const tag5 = v.is_preorder ? "preorder" : p.status === "draft" ? "draft" : "";
    if (tag1) coverage.tag_format++;
    if (tag2) coverage.tag_label++;
    if (tag3) coverage.tag_vendor++;

    const customsDescription = customsDescriptionForFormat(v.format_name, p.product_type);
    if (customsDescription) coverage.customs_description++;
    const customsValue =
      v.cost != null
        ? Number(v.cost).toFixed(2)
        : v.price != null
          ? Number(v.price).toFixed(2)
          : "";
    if (customsValue) coverage.customs_value++;
    const customsTariff = (v.hs_tariff_code ?? "").trim();
    if (customsTariff) coverage.customs_tariff++;

    const mapping = mappingByVariant.get(v.id);
    const thumbnail =
      firstImgByProduct.get(p.id) ?? mapping?.bandcamp_art_url ?? mapping?.bandcamp_image_url ?? "";
    if (thumbnail) coverage.thumbnail++;

    const upc = pickUpc(p.bandcamp_upc, v.barcode);
    if (upc) coverage.upc++;

    // ShipStation boolean columns must be the literal strings "true" / "false"
    // (NOT "Yes"/"No" — that triggers per-row "column is type: boolean" warnings
    // on every import and the value silently defaults to false).
    const activeBool = p.status === "active";
    const active = activeBool ? "true" : "false";
    if (activeBool) coverage.active_yes++;
    else coverage.active_no++;

    rows.push({
      SKU: sku,
      Name: name || sku,
      Description: description,
      "Fulfillment Barcode": barcode,
      "Warehouse Location": location,
      Weight: weightStr,
      Length: len,
      Width: wid,
      Height: hgt,
      Category: category,
      "Tag 1": tag1,
      "Tag 2": tag2,
      "Tag 3": tag3,
      "Tag 4": tag4,
      "Tag 5": tag5,
      "Customs Description": customsDescription,
      "Customs Value": customsValue,
      "Customs Tariff No": customsTariff,
      "Customs Manufacturer Identification Code": "",
      "Customs Country": "US",
      "Thumbnail Url": thumbnail,
      UPC: upc,
      "Fill SKU": "",
      "Parent SKU": "",
      "Use Product Name": "true",
      Active: active,
      "Is Returnable": "true",
      "Track inventory": "true", // Rule #20 — ShipStation v2 is inventory truth.
      "Packaging Requirements": "",
      "Package Preference": "",
    });
  }

  // ----- 6. Render CSV + XLSX -----
  const csvLines = [csvLine([...SHIPSTATION_COLUMNS])];
  for (const r of rows) {
    csvLines.push(csvLine(SHIPSTATION_COLUMNS.map((c) => r[c] ?? "")));
  }
  const csv = csvLines.join("\n") + "\n";

  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...SHIPSTATION_COLUMNS] });
  sheet["!cols"] = [
    { wch: 22 },
    { wch: 56 },
    { wch: 56 },
    { wch: 18 },
    { wch: 22 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 16 },
    { wch: 12 },
    { wch: 24 },
    { wch: 18 },
    { wch: 10 },
    { wch: 10 },
    { wch: 28 },
    { wch: 10 },
    { wch: 12 },
    { wch: 14 },
    { wch: 8 },
    { wch: 56 },
    { wch: 14 },
    { wch: 10 },
    { wch: 12 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
    { wch: 14 },
    { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, sheet, "ShipStation Import");
  const xlsx = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array;

  return {
    rows,
    csv,
    xlsx,
    summary: {
      mode,
      since_ts: sinceTs,
      data_max_ts: dataMaxTs,
      total_variants_loaded: variants.length,
      rows_written: rows.length,
      duplicates_skipped: dupes.length,
      coverage,
      duplicate_skus: dupes,
    },
  };
}
