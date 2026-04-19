#!/usr/bin/env tsx
/**
 * Master product baseline builder.
 *
 * Inputs (defaults autodetect; override with --bandcamp= / --master=):
 *   - Bandcamp baseline CSV (latest reports/bandcamp-baseline-catalog-*.csv)
 *   - Warehouse Master Inventory Doc xlsx (latest in ~/Downloads)
 *   - Live `bandcamp_connections.band_name` set (Postgres, service-role)
 *
 * Algorithm:
 *   1. Bandcamp baseline rows are accepted as-is and become source of truth for
 *      SKU / format / naming. The 5 SKU-less Egghunt "Vinyl + T-shirt Bundle"
 *      option rows get deterministic SKUs: BUNDLE-EHR-VTSB-{S,M,L,XL,XXL}.
 *   2. For each Master sheet row (decision tree, in order):
 *        a. Normalize SKU (trim + uppercase).
 *        b. SKU present and SKU is in Bandcamp set
 *           -> drop, log to "Dropped — Covered by Bandcamp".
 *        c. SKU present and SKU not in Bandcamp set
 *           -> fuzzy match (artist, title) against Bandcamp.
 *              score >= threshold -> drop, log to "Needs Human Review".
 *              else                -> accept as source=master_sheet.
 *        d. SKU absent and Master Label matches a Bandcamp connection band_name
 *           -> skip entirely, log to "Skipped — Bandcamp Label, No SKU".
 *        e. SKU absent and Label doesn't match a Bandcamp connection
 *           -> fuzzy match against Bandcamp.
 *              score >= threshold -> drop, log to "Needs Human Review".
 *              else                -> accept as source=master_sheet, sku=NULL,
 *                                     sku_status=pending_assignment.
 *
 * Outputs (in reports/):
 *   - master-product-baseline-{ts}.xlsx   (5 sheets: Master List, Needs Human
 *                                          Review, SKU Pending Assignment,
 *                                          Dropped — Covered by Bandcamp,
 *                                          Skipped — Bandcamp Label No SKU)
 *   - master-product-baseline-{ts}.csv    (mirror of Master List)
 *   - master-product-baseline-{ts}.json   (counts + score histogram + label
 *                                          breakdown)
 *
 * Read-only. No DB writes, no Bandcamp writes, no Shopify/SS writes.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const REPORT_DIR = "reports";
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

interface CliArgs {
  bandcampPath: string;
  masterPath: string;
  threshold: number;
}

function autodetectBandcampCsv(): string {
  const dir = REPORT_DIR;
  if (!existsSync(dir)) throw new Error(`reports/ directory not found`);
  const candidates = readdirSync(dir)
    .filter((f) => f.startsWith("bandcamp-baseline-catalog-") && f.endsWith(".csv"))
    .sort();
  if (candidates.length === 0) {
    throw new Error(
      "no bandcamp-baseline-catalog-*.csv found in reports/ — run scripts/build-bandcamp-baseline-catalog.ts first",
    );
  }
  return join(dir, candidates[candidates.length - 1]);
}

function autodetectMasterXlsx(): string {
  const dl = join(homedir(), "Downloads");
  const candidates = [
    "Clandestine Warehouse Master Inventory Doc (2).xlsx",
    "Clandestine Warehouse Master Inventory Doc (1).xlsx",
    "Clandestine Warehouse Master Inventory Doc.xlsx",
  ]
    .map((n) => join(dl, n))
    .filter((p) => existsSync(p));
  if (candidates.length === 0) {
    throw new Error(
      "no 'Clandestine Warehouse Master Inventory Doc*.xlsx' found in ~/Downloads — pass --master=path",
    );
  }
  return candidates[0];
}

function parseArgs(): CliArgs {
  let bandcampPath = "";
  let masterPath = "";
  let threshold = 0.92;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--bandcamp=")) bandcampPath = a.slice("--bandcamp=".length);
    else if (a.startsWith("--master=")) masterPath = a.slice("--master=".length);
    else if (a.startsWith("--threshold=")) threshold = Number.parseFloat(a.slice("--threshold=".length));
  }
  return {
    bandcampPath: bandcampPath || autodetectBandcampCsv(),
    masterPath: masterPath || autodetectMasterXlsx(),
    threshold,
  };
}

// -----------------------------------------------------------------------------
// CSV (minimal, handles RFC-4180 quoting which our writer produces)
// -----------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  let field = "";
  let row: string[] = [];
  let inQuote = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuote = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Normalization helpers
// -----------------------------------------------------------------------------

function normSku(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim().toUpperCase();
  return t.length === 0 ? null : t;
}

function normLabel(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/[\t\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim();
}

function normTextForFuzzy(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ART_TITLE_SEP = /\s*[\u2013\u2014\u2012-]\s+/;

function splitArtistTitleColumn(s: string | null | undefined): { artist: string; title: string } {
  if (!s) return { artist: "", title: "" };
  const txt = String(s).trim();
  const m = txt.split(ART_TITLE_SEP);
  if (m.length >= 2) {
    return { artist: m[0].trim(), title: m.slice(1).join(" - ").trim() };
  }
  return { artist: "", title: txt };
}

// -----------------------------------------------------------------------------
// Fuzzy: bigram Dice coefficient (fast, symmetric, range [0,1])
// -----------------------------------------------------------------------------

function bigramSet(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 2) {
    if (s.length === 1) out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

// -----------------------------------------------------------------------------
// Bandcamp baseline loader
// -----------------------------------------------------------------------------

interface BcRow {
  workspace_id: string;
  connection_band_id: string;
  connection_band_name: string;
  artist: string;
  member_band_subdomain: string;
  package_id: string;
  item_title: string;
  album_title: string;
  merch_name: string;
  option_id: string;
  option_title: string;
  sku: string | null;
  item_type: string;
  format_inferred: string;
  url: string;
  image_url: string;
  price: string;
  currency: string;
  is_set_price: string;
  new_date: string;
  quantity_available_now: string;
  quantity_sold_lifetime_api: string;
  has_options: string;
  origin_quantities_count: string;
  source: string;
  historical_units_sold: string;
  historical_orders: string;
  first_sale_date: string;
  last_sale_date: string;
  // Derived
  __key_artist: string;
  __key_title: string;
  __artist_norm: string;
  __title_norm: string;
  __artist_bg: Set<string>;
  __title_bg: Set<string>;
}

const EGGHUNT_BUNDLE_SKU: Record<string, string> = {
  small: "BUNDLE-EHR-VTSB-S",
  medium: "BUNDLE-EHR-VTSB-M",
  large: "BUNDLE-EHR-VTSB-L",
  "x large": "BUNDLE-EHR-VTSB-XL",
  "xx large": "BUNDLE-EHR-VTSB-XXL",
};

function loadBandcamp(csvPath: string): { rows: BcRow[]; egghuntFills: number } {
  const text = readFileSync(csvPath, "utf-8");
  const grid = parseCsv(text);
  if (grid.length === 0) throw new Error(`empty CSV: ${csvPath}`);
  const headers = grid[0].map((h) => h.trim());
  const rows: BcRow[] = [];
  let egghuntFills = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (r.every((c) => c === "")) continue;
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = (r[j] ?? "").trim();

    let sku: string | null = obj.sku || null;

    // Egghunt "Vinyl + T-shirt Bundle" SKU backfill (the 5 known SKU-less rows).
    if (
      !sku &&
      obj.connection_band_name?.toLowerCase().startsWith("egghunt") &&
      obj.item_title.toLowerCase() === "vinyl + t-shirt bundle"
    ) {
      const optKey = obj.option_title.toLowerCase().trim();
      const fill = EGGHUNT_BUNDLE_SKU[optKey];
      if (fill) {
        sku = fill;
        egghuntFills += 1;
      }
    }

    const artist = obj.artist || obj.connection_band_name || "";
    const itemTitle = obj.item_title || obj.merch_name || "";
    const artistNorm = normTextForFuzzy(artist);
    const titleNorm = normTextForFuzzy(itemTitle);

    rows.push({
      workspace_id: obj.workspace_id,
      connection_band_id: obj.connection_band_id,
      connection_band_name: obj.connection_band_name,
      artist,
      member_band_subdomain: obj.member_band_subdomain,
      package_id: obj.package_id,
      item_title: itemTitle,
      album_title: obj.album_title,
      merch_name: obj.merch_name,
      option_id: obj.option_id,
      option_title: obj.option_title,
      sku,
      item_type: obj.item_type,
      format_inferred: obj.format_inferred,
      url: obj.url,
      image_url: obj.image_url,
      price: obj.price,
      currency: obj.currency,
      is_set_price: obj.is_set_price,
      new_date: obj.new_date,
      quantity_available_now: obj.quantity_available_now,
      quantity_sold_lifetime_api: obj.quantity_sold_lifetime_api,
      has_options: obj.has_options,
      origin_quantities_count: obj.origin_quantities_count,
      source: obj.source,
      historical_units_sold: obj.historical_units_sold,
      historical_orders: obj.historical_orders,
      first_sale_date: obj.first_sale_date,
      last_sale_date: obj.last_sale_date,
      __key_artist: artistNorm,
      __key_title: titleNorm,
      __artist_norm: artistNorm,
      __title_norm: titleNorm,
      __artist_bg: bigramSet(artistNorm),
      __title_bg: bigramSet(titleNorm),
    });
  }
  return { rows, egghuntFills };
}

// -----------------------------------------------------------------------------
// Master sheet loader
// -----------------------------------------------------------------------------

interface MasterRow {
  row_index: number; // 1-based row number in source xlsx (after header)
  fley: string;
  sku: string | null;
  sku_norm: string | null;
  format: string;
  label: string;
  label_norm: string;
  payee: string;
  artist_title_raw: string;
  artist: string;
  title: string;
  artist_norm: string;
  title_norm: string;
  artist_bg: Set<string>;
  title_bg: Set<string>;
  on_hand: number | null;
  damaged: number | null;
  location: string;
  last_updated: string;
  clan_shopify: boolean | null;
  discogs: boolean | null;
  avant_shopify: boolean | null;
  notes: string;
}

function loadMaster(xlsxPath: string): MasterRow[] {
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets["Master"];
  if (!ws) throw new Error(`'Master' sheet not found in ${xlsxPath}`);
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    raw: true,
  });
  if (aoa.length === 0) return [];
  const out: MasterRow[] = [];
  let skippedEmpty = 0;
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r || r.every((c) => c == null || (typeof c === "string" && c.trim() === ""))) continue;
    const fley = (r[0] != null ? String(r[0]).trim() : "");
    const skuRaw = r[1] != null ? String(r[1]).trim() : "";
    const format = r[2] != null ? String(r[2]).trim() : "";
    const label = r[3] != null ? String(r[3]).trim() : "";
    const payee = r[4] != null ? String(r[4]).trim() : "";
    const artistTitleRaw = r[5] != null ? String(r[5]).trim() : "";
    const onHand = typeof r[6] === "number" ? (r[6] as number) : null;
    const damaged = typeof r[7] === "number" ? (r[7] as number) : null;
    const location = r[8] != null ? String(r[8]).trim() : "";
    const lastUpdated = r[9] instanceof Date ? (r[9] as Date).toISOString() : r[9] != null ? String(r[9]) : "";
    const clanShop = typeof r[10] === "boolean" ? (r[10] as boolean) : null;
    const discogs = typeof r[11] === "boolean" ? (r[11] as boolean) : null;
    const avantShop = typeof r[12] === "boolean" ? (r[12] as boolean) : null;
    const notes = r[13] != null ? String(r[13]).trim() : "";

    const { artist, title } = splitArtistTitleColumn(artistTitleRaw);
    const artistNorm = normTextForFuzzy(artist);
    const titleNorm = normTextForFuzzy(title);

    // Skip rows that have NO product identity (no sku, no artist/title, no
    // FLEY, no label). These are sentinel/garbage rows in the Master xlsx
    // (often: a stray date in 'Last Updated' but no actual product). Without
    // this filter they'd all flow into 'SKU Pending Assignment' as ~957
    // empty placeholders.
    if (
      skuRaw.length === 0 &&
      fley.length === 0 &&
      label.length === 0 &&
      artistTitleRaw.length === 0 &&
      payee.length === 0
    ) {
      skippedEmpty += 1;
      continue;
    }

    out.push({
      row_index: i,
      fley,
      sku: skuRaw.length > 0 ? skuRaw : null,
      sku_norm: normSku(skuRaw),
      format,
      label,
      label_norm: normLabel(label),
      payee,
      artist_title_raw: artistTitleRaw,
      artist,
      title,
      artist_norm: artistNorm,
      title_norm: titleNorm,
      artist_bg: bigramSet(artistNorm),
      title_bg: bigramSet(titleNorm),
      on_hand: onHand,
      damaged: damaged,
      location,
      last_updated: lastUpdated,
      clan_shopify: clanShop,
      discogs,
      avant_shopify: avantShop,
      notes,
    });
  }
  if (skippedEmpty > 0) {
    console.log(`[mstr]  skipped ${skippedEmpty} empty/sentinel rows from Master sheet`);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Bandcamp connections (live)
// -----------------------------------------------------------------------------

async function loadBandcampConnectionLabels(supabase: SupabaseClient): Promise<{
  raw: string[];
  norm: Set<string>;
}> {
  const { data, error } = await supabase
    .from("bandcamp_connections")
    .select("band_name, is_active")
    .eq("is_active", true);
  if (error) throw error;
  const raw: string[] = [];
  const norm = new Set<string>();
  for (const r of data ?? []) {
    const name = (r.band_name as string | null) ?? "";
    if (!name) continue;
    raw.push(name);
    const n = normLabel(name);
    if (n) norm.add(n);
    // Also accept common aliases — strip "records", "tapes", etc.
    const bare = n
      .replace(/\b(records|recordings|tapes|tape|music|label|llc|inc)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (bare && bare !== n) norm.add(bare);
  }
  return { raw, norm };
}

// -----------------------------------------------------------------------------
// Fuzzy matcher: find best Bandcamp match for a Master (artist,title)
// -----------------------------------------------------------------------------

interface FuzzyMatch {
  score: number;
  artist_score: number;
  title_score: number;
  bc: BcRow;
}

function bestFuzzyMatch(
  master: MasterRow,
  byArtistFirstChar: Map<string, BcRow[]>,
  bcAll: BcRow[],
  threshold: number,
): FuzzyMatch | null {
  if (master.artist_norm.length === 0 && master.title_norm.length === 0) return null;
  // Prefilter by first char of normalized artist; if artist is empty, fall back
  // to scanning ALL bandcamp rows (rare).
  const firstChar = master.artist_norm.length > 0 ? master.artist_norm[0] : "";
  const candidates: BcRow[] = firstChar ? (byArtistFirstChar.get(firstChar) ?? []) : bcAll;

  let best: FuzzyMatch | null = null;
  // Quick artist gate to skip clearly-different rows.
  const ARTIST_GATE = Math.max(0.5, threshold - 0.30);
  for (const bc of candidates) {
    if (bc.__artist_bg.size === 0 && master.artist_bg.size === 0) {
      // Both artist-less — fall through to title compare only.
    } else if (bc.__artist_bg.size === 0 || master.artist_bg.size === 0) {
      continue;
    }
    const aScore = dice(master.artist_bg, bc.__artist_bg);
    if (aScore < ARTIST_GATE) continue;
    const tScore = dice(master.title_bg, bc.__title_bg);
    const score = (aScore + tScore) / 2;
    if (!best || score > best.score) {
      best = { score, artist_score: aScore, title_score: tScore, bc };
    }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Output row shapes
// -----------------------------------------------------------------------------

interface MasterListRow {
  provenance: "bandcamp" | "master_sheet";
  sku: string | null;
  sku_status: "canonical" | "generated_from_bandcamp_baseline" | "pending_assignment";
  artist: string;
  item_title: string;
  option_title: string | null;
  format: string;
  label: string;
  bandcamp_url: string | null;
  bandcamp_package_id: string | null;
  bandcamp_option_id: string | null;
  bandcamp_member_band_subdomain: string | null;
  bandcamp_quantity_available_now: string | null;
  bandcamp_historical_units_sold: string | null;
  bandcamp_first_sale_date: string | null;
  bandcamp_last_sale_date: string | null;
  master_row_index: number | null;
  master_fley: string | null;
  master_payee: string | null;
  master_clan_shopify: boolean | null;
  master_discogs: boolean | null;
  master_avant_shopify: boolean | null;
  master_on_hand: number | null;
  master_damaged: number | null;
  master_location: string | null;
  master_last_updated: string | null;
  master_notes: string | null;
}

interface NeedsReviewRow {
  master_row_index: number;
  master_sku: string | null;
  master_artist: string;
  master_title: string;
  master_format: string;
  master_label: string;
  master_on_hand: number | null;
  master_location: string;
  match_score: number;
  artist_score: number;
  title_score: number;
  bc_sku: string | null;
  bc_artist: string;
  bc_item_title: string;
  bc_format: string;
  bc_url: string;
  bc_package_id: string;
  bc_option_id: string;
  reason: string;
  proposed_action: string;
}

interface PendingSkuRow {
  master_row_index: number;
  master_artist: string;
  master_title: string;
  master_format: string;
  master_label: string;
  master_on_hand: number | null;
  master_location: string;
  master_clan_shopify: boolean | null;
  master_discogs: boolean | null;
  master_avant_shopify: boolean | null;
  master_notes: string;
}

interface DroppedRow {
  master_row_index: number;
  master_sku: string;
  master_artist: string;
  master_title: string;
  master_format: string;
  master_label: string;
  reason: string;
}

interface SkippedRow {
  master_row_index: number;
  master_artist: string;
  master_title: string;
  master_format: string;
  master_label: string;
  matched_bc_connection: string;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  mkdirSync(REPORT_DIR, { recursive: true });

  console.log("[start] Master product baseline build");
  console.log(`[args]  bandcamp=${args.bandcampPath}`);
  console.log(`[args]  master=  ${args.masterPath}`);
  console.log(`[args]  threshold=${args.threshold} (Dice on bigrams)`);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { rows: bcRows, egghuntFills } = loadBandcamp(args.bandcampPath);
  console.log(`[bc]    rows: ${bcRows.length}  Egghunt SKU fills: ${egghuntFills}`);
  if (egghuntFills !== 5) {
    console.warn(
      `[bc]    WARNING: expected 5 Egghunt bundle SKU fills, got ${egghuntFills} — pattern may have shifted; check 'Vinyl + T-shirt Bundle' option titles`,
    );
  }
  const bcSkus = new Set<string>();
  for (const r of bcRows) {
    const k = normSku(r.sku);
    if (k) bcSkus.add(k);
  }
  console.log(`[bc]    distinct normalized SKUs: ${bcSkus.size}`);

  const masterRows = loadMaster(args.masterPath);
  console.log(`[mstr]  rows: ${masterRows.length}`);

  const { raw: bcConnRaw, norm: bcConnNorm } = await loadBandcampConnectionLabels(supabase);
  console.log(`[conn]  active bandcamp_connections: ${bcConnRaw.length}`);
  console.log(`[conn]  normalized label keys (with aliases): ${bcConnNorm.size}`);

  // Build Bandcamp prefilter index by first char of normalized artist.
  const byArtistFirstChar = new Map<string, BcRow[]>();
  for (const r of bcRows) {
    if (r.__artist_norm.length === 0) continue;
    const c = r.__artist_norm[0];
    let arr = byArtistFirstChar.get(c);
    if (!arr) {
      arr = [];
      byArtistFirstChar.set(c, arr);
    }
    arr.push(r);
  }

  // -------------------------------------------------------------------------
  // Phase 1: emit Master List rows from Bandcamp baseline.
  // -------------------------------------------------------------------------
  const masterList: MasterListRow[] = [];
  for (const r of bcRows) {
    const skuRaw = r.sku ? r.sku.trim() : null;
    let status: MasterListRow["sku_status"] = "canonical";
    if (skuRaw && Object.values(EGGHUNT_BUNDLE_SKU).includes(skuRaw)) {
      status = "generated_from_bandcamp_baseline";
    }
    masterList.push({
      provenance: "bandcamp",
      sku: skuRaw,
      sku_status: status,
      artist: r.artist,
      item_title: r.item_title,
      option_title: r.option_title || null,
      format: r.format_inferred || r.item_type || "",
      label: r.connection_band_name || "",
      bandcamp_url: r.url || null,
      bandcamp_package_id: r.package_id || null,
      bandcamp_option_id: r.option_id || null,
      bandcamp_member_band_subdomain: r.member_band_subdomain || null,
      bandcamp_quantity_available_now: r.quantity_available_now || null,
      bandcamp_historical_units_sold: r.historical_units_sold || null,
      bandcamp_first_sale_date: r.first_sale_date || null,
      bandcamp_last_sale_date: r.last_sale_date || null,
      master_row_index: null,
      master_fley: null,
      master_payee: null,
      master_clan_shopify: null,
      master_discogs: null,
      master_avant_shopify: null,
      master_on_hand: null,
      master_damaged: null,
      master_location: null,
      master_last_updated: null,
      master_notes: null,
    });
  }

  // -------------------------------------------------------------------------
  // Phase 2: walk Master sheet, run decision tree.
  // -------------------------------------------------------------------------
  const needsReview: NeedsReviewRow[] = [];
  const pending: PendingSkuRow[] = [];
  const dropped: DroppedRow[] = [];
  const skipped: SkippedRow[] = [];
  const scoreHistogram = new Map<string, number>(); // 0.05 buckets

  let processed = 0;
  let acceptedFromMaster = 0;
  let droppedSkuMatch = 0;
  let droppedFuzzyMatch = 0;
  let skippedBcLabel = 0;

  const T0 = Date.now();
  for (const m of masterRows) {
    processed += 1;
    if (processed % 200 === 0) {
      const dt = ((Date.now() - T0) / 1000).toFixed(1);
      console.log(`[mstr]  processed ${processed}/${masterRows.length} (${dt}s)`);
    }

    // Step 2a/2b: SKU present and SKU is in Bandcamp set -> drop.
    if (m.sku_norm && bcSkus.has(m.sku_norm)) {
      dropped.push({
        master_row_index: m.row_index,
        master_sku: m.sku ?? "",
        master_artist: m.artist,
        master_title: m.title,
        master_format: m.format,
        master_label: m.label,
        reason: "sku_match: sku exists in Bandcamp baseline",
      });
      droppedSkuMatch += 1;
      continue;
    }

    // Step 2c: SKU present and not in Bandcamp -> fuzzy compare against Bandcamp.
    if (m.sku_norm) {
      const best = bestFuzzyMatch(m, byArtistFirstChar, bcRows, args.threshold);
      const score = best?.score ?? 0;
      const bucket = `${(Math.floor(score * 20) / 20).toFixed(2)}`;
      scoreHistogram.set(bucket, (scoreHistogram.get(bucket) ?? 0) + 1);
      if (best && score >= args.threshold) {
        needsReview.push({
          master_row_index: m.row_index,
          master_sku: m.sku,
          master_artist: m.artist,
          master_title: m.title,
          master_format: m.format,
          master_label: m.label,
          master_on_hand: m.on_hand,
          master_location: m.location,
          match_score: Number(score.toFixed(4)),
          artist_score: Number(best.artist_score.toFixed(4)),
          title_score: Number(best.title_score.toFixed(4)),
          bc_sku: best.bc.sku,
          bc_artist: best.bc.artist,
          bc_item_title: best.bc.item_title,
          bc_format: best.bc.format_inferred,
          bc_url: best.bc.url,
          bc_package_id: best.bc.package_id,
          bc_option_id: best.bc.option_id,
          reason: "fuzzy_match: SKU differs but artist+title match",
          proposed_action: "use_bandcamp",
        });
        droppedFuzzyMatch += 1;
        continue;
      }
      // Accept as master_sheet.
      masterList.push(makeMasterRowFromMaster(m, "canonical"));
      acceptedFromMaster += 1;
      continue;
    }

    // Step 2d: SKU absent and label matches a BC connection -> skip.
    if (!m.sku_norm) {
      const labelMatches = labelMatchesAnyBcConnection(m.label_norm, bcConnNorm);
      if (labelMatches) {
        skipped.push({
          master_row_index: m.row_index,
          master_artist: m.artist,
          master_title: m.title,
          master_format: m.format,
          master_label: m.label,
          matched_bc_connection: labelMatches,
        });
        skippedBcLabel += 1;
        continue;
      }
    }

    // Step 2e: SKU absent and label not BC -> fuzzy compare.
    const best = bestFuzzyMatch(m, byArtistFirstChar, bcRows, args.threshold);
    const score = best?.score ?? 0;
    const bucket = `${(Math.floor(score * 20) / 20).toFixed(2)}`;
    scoreHistogram.set(bucket, (scoreHistogram.get(bucket) ?? 0) + 1);
    if (best && score >= args.threshold) {
      needsReview.push({
        master_row_index: m.row_index,
        master_sku: null,
        master_artist: m.artist,
        master_title: m.title,
        master_format: m.format,
        master_label: m.label,
        master_on_hand: m.on_hand,
        master_location: m.location,
        match_score: Number(score.toFixed(4)),
        artist_score: Number(best.artist_score.toFixed(4)),
        title_score: Number(best.title_score.toFixed(4)),
        bc_sku: best.bc.sku,
        bc_artist: best.bc.artist,
        bc_item_title: best.bc.item_title,
        bc_format: best.bc.format_inferred,
        bc_url: best.bc.url,
        bc_package_id: best.bc.package_id,
        bc_option_id: best.bc.option_id,
        reason: "fuzzy_match (no sku in master): artist+title match",
        proposed_action: "use_bandcamp",
      });
      droppedFuzzyMatch += 1;
      continue;
    }

    // Accept as master_sheet, sku=NULL.
    masterList.push(makeMasterRowFromMaster(m, "pending_assignment"));
    pending.push({
      master_row_index: m.row_index,
      master_artist: m.artist,
      master_title: m.title,
      master_format: m.format,
      master_label: m.label,
      master_on_hand: m.on_hand,
      master_location: m.location,
      master_clan_shopify: m.clan_shopify,
      master_discogs: m.discogs,
      master_avant_shopify: m.avant_shopify,
      master_notes: m.notes,
    });
    acceptedFromMaster += 1;
  }

  // -------------------------------------------------------------------------
  // Sort outputs deterministically.
  // -------------------------------------------------------------------------
  const cmp = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "").toLowerCase().localeCompare((b ?? "").toLowerCase());
  masterList.sort(
    (a, b) =>
      cmp(a.provenance, b.provenance) ||
      cmp(a.label, b.label) ||
      cmp(a.artist, b.artist) ||
      cmp(a.item_title, b.item_title) ||
      cmp(a.option_title, b.option_title) ||
      cmp(a.sku, b.sku),
  );
  needsReview.sort((a, b) => b.match_score - a.match_score);
  pending.sort((a, b) => cmp(a.master_label, b.master_label) || cmp(a.master_artist, b.master_artist));
  dropped.sort((a, b) => cmp(a.master_label, b.master_label) || cmp(a.master_sku, b.master_sku));
  skipped.sort((a, b) => cmp(a.master_label, b.master_label) || cmp(a.master_artist, b.master_artist));

  // -------------------------------------------------------------------------
  // Write outputs.
  // -------------------------------------------------------------------------
  const outBase = join(REPORT_DIR, `master-product-baseline-${TS}`);
  const xlsxPath = `${outBase}.xlsx`;
  const csvPath = `${outBase}.csv`;
  const jsonPath = `${outBase}.json`;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(masterList), "Master List");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(needsReview), "Needs Human Review");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pending), "SKU Pending Assignment");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dropped), "Dropped — Covered by BC");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(skipped), "Skipped — BC Label No SKU");
  XLSX.writeFile(wb, xlsxPath);
  writeCsv(csvPath, masterList);

  // Label coverage breakdown.
  const labelCounts = new Map<string, { accepted: number; dropped_sku: number; dropped_fuzzy: number; skipped_bc_label: number; pending: number }>();
  const bumpLabel = (lbl: string, key: keyof { accepted: number; dropped_sku: number; dropped_fuzzy: number; skipped_bc_label: number; pending: number }) => {
    const k = lbl || "(no label)";
    const cur = labelCounts.get(k) ?? { accepted: 0, dropped_sku: 0, dropped_fuzzy: 0, skipped_bc_label: 0, pending: 0 };
    cur[key] += 1;
    labelCounts.set(k, cur);
  };
  for (const r of dropped) bumpLabel(r.master_label, r.reason.startsWith("sku_match") ? "dropped_sku" : "dropped_fuzzy");
  for (const r of skipped) bumpLabel(r.master_label, "skipped_bc_label");
  for (const r of pending) bumpLabel(r.master_label, "pending");
  for (const m of masterList)
    if (m.provenance === "master_sheet") bumpLabel(m.label, "accepted");

  const labelBreakdown = Array.from(labelCounts.entries())
    .map(([label, v]) => ({ label, ...v, total: v.accepted + v.dropped_sku + v.dropped_fuzzy + v.skipped_bc_label }))
    .sort((a, b) => b.total - a.total);

  const summary = {
    started_at: new Date(TS.replace(/T(\d{2})-(\d{2})-(\d{2}).*$/, "T$1:$2:$3Z")).toISOString(),
    finished_at: new Date().toISOString(),
    inputs: { bandcamp: args.bandcampPath, master: args.masterPath, threshold: args.threshold },
    bandcamp: {
      rows: bcRows.length,
      distinct_skus: bcSkus.size,
      egghunt_bundle_skus_filled: egghuntFills,
    },
    master: { rows: masterRows.length },
    bandcamp_connections: { active: bcConnRaw.length, normalized_keys: bcConnNorm.size, raw: bcConnRaw },
    decision_outcomes: {
      bandcamp_baseline_accepted: bcRows.length,
      master_accepted_with_sku: masterList.filter((r) => r.provenance === "master_sheet" && r.sku_status === "canonical").length,
      master_accepted_pending_sku: pending.length,
      master_dropped_sku_covered_by_bc: droppedSkuMatch,
      master_dropped_fuzzy_match: droppedFuzzyMatch,
      master_skipped_bc_label_no_sku: skippedBcLabel,
      master_total_processed: processed,
      sanity_check_master_sum:
        droppedSkuMatch +
        droppedFuzzyMatch +
        skippedBcLabel +
        acceptedFromMaster, // == processed iff every row was classified
    },
    fuzzy_score_histogram: Array.from(scoreHistogram.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([bucket, count]) => ({ bucket_min: Number(bucket), count })),
    label_breakdown: labelBreakdown,
    files: { xlsx: xlsxPath, csv: csvPath, json: jsonPath },
  };
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  // Banner.
  console.log("");
  console.log("================ DONE ================");
  console.log(`Bandcamp baseline rows accepted:           ${bcRows.length}`);
  console.log(`Master accepted (with sku):                ${summary.decision_outcomes.master_accepted_with_sku}`);
  console.log(`Master accepted (sku pending):             ${pending.length}`);
  console.log(`Master dropped — sku already in Bandcamp:  ${droppedSkuMatch}`);
  console.log(`Master dropped — fuzzy match (review):     ${droppedFuzzyMatch}`);
  console.log(`Master skipped — BC label, no sku:         ${skippedBcLabel}`);
  console.log(`Master total processed:                    ${processed}`);
  console.log("");
  console.log(`Master List rows total:                    ${masterList.length}`);
  console.log(`Needs Human Review rows:                   ${needsReview.length}`);
  console.log("");
  console.log(`xlsx -> ${xlsxPath}`);
  console.log(`csv  -> ${csvPath}`);
  console.log(`json -> ${jsonPath}`);
}

function makeMasterRowFromMaster(
  m: MasterRow,
  status: "canonical" | "pending_assignment",
): MasterListRow {
  return {
    provenance: "master_sheet",
    sku: status === "pending_assignment" ? null : m.sku,
    sku_status: status,
    artist: m.artist || m.artist_title_raw,
    item_title: m.title || "",
    option_title: null,
    format: m.format,
    label: m.label,
    bandcamp_url: null,
    bandcamp_package_id: null,
    bandcamp_option_id: null,
    bandcamp_member_band_subdomain: null,
    bandcamp_quantity_available_now: null,
    bandcamp_historical_units_sold: null,
    bandcamp_first_sale_date: null,
    bandcamp_last_sale_date: null,
    master_row_index: m.row_index,
    master_fley: m.fley || null,
    master_payee: m.payee || null,
    master_clan_shopify: m.clan_shopify,
    master_discogs: m.discogs,
    master_avant_shopify: m.avant_shopify,
    master_on_hand: m.on_hand,
    master_damaged: m.damaged,
    master_location: m.location || null,
    master_last_updated: m.last_updated || null,
    master_notes: m.notes || null,
  };
}

function labelMatchesAnyBcConnection(masterLabelNorm: string, bcConnNorm: Set<string>): string | null {
  if (!masterLabelNorm) return null;
  if (bcConnNorm.has(masterLabelNorm)) return masterLabelNorm;
  // Token-overlap fallback: a Master label like "Northern Spy" should match
  // Bandcamp connection "Northern Spy Records".
  for (const conn of bcConnNorm) {
    if (conn.includes(masterLabelNorm) || masterLabelNorm.includes(conn)) return conn;
  }
  return null;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "boolean" || typeof v === "number" ? String(v) : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(path: string, rows: MasterListRow[]) {
  if (rows.length === 0) {
    writeFileSync(path, "");
    return;
  }
  const headers = Object.keys(rows[0]) as Array<keyof MasterListRow>;
  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  writeFileSync(path, lines.join("\n"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
