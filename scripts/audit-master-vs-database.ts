#!/usr/bin/env tsx
/**
 * Master-vs-Database conflict audit (read-only).
 *
 * Joins the Master List from `scripts/build-master-product-baseline.ts`
 * against `warehouse_product_variants` (joined to `warehouse_products`) and
 * classifies every row into one of:
 *
 *   - ok                      Exact SKU match + matching artist/title/format.
 *   - conflict_metadata_drift Exact SKU match, but artist / title / format
 *                             differs (one output row per drifting field).
 *   - conflict_sku_collision  Fuzzy artist+title hit on a DB variant whose SKU
 *                             differs from the Master SKU. The Master baseline
 *                             says SKU should be X, the DB has Y.
 *   - missing_in_db           Master row with no matching DB variant by SKU
 *                             and no fuzzy hit.
 *   - db_only                 DB variant whose SKU never appeared in any
 *                             Master row (orphans / archived candidates —
 *                             surfaced for operator review only, NOT deleted).
 *
 * Output: reports/db-vs-master-conflicts-{ts}.xlsx with one tab per class
 *         plus a "Summary" tab. Pure read — no DB / external writes.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const REPORT_DIR = "reports";
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE_SIZE = 1000;

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

interface CliArgs {
  masterPath: string;
  threshold: number;
}

function autodetectMasterBaselineXlsx(): string {
  if (!existsSync(REPORT_DIR)) throw new Error("reports/ not found");
  const files = readdirSync(REPORT_DIR)
    .filter((f) => f.startsWith("master-product-baseline-") && f.endsWith(".xlsx"))
    .sort();
  if (files.length === 0) {
    throw new Error(
      "no master-product-baseline-*.xlsx in reports/ — run scripts/build-master-product-baseline.ts first",
    );
  }
  return join(REPORT_DIR, files[files.length - 1]);
}

function parseArgs(): CliArgs {
  let masterPath = "";
  let threshold = 0.92;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--master=")) masterPath = a.slice("--master=".length);
    else if (a.startsWith("--threshold=")) threshold = Number.parseFloat(a.slice("--threshold=".length));
  }
  return { masterPath: masterPath || autodetectMasterBaselineXlsx(), threshold };
}

// -----------------------------------------------------------------------------
// Normalization (must match build-master-product-baseline.ts)
// -----------------------------------------------------------------------------

function normSku(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim().toUpperCase();
  return t.length === 0 ? null : t;
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

function normFormat(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().trim();
}

// Categorize a metadata drift so the user can see at a glance whether it's a
// known convention difference (DB stores label-as-vendor, denormalized titles)
// or a real divergence worth fixing.
function classifyArtistDrift(masterArtist: string, dbVendor: string, masterLabel: string): string {
  const a = normTextForFuzzy(masterArtist);
  const v = normTextForFuzzy(dbVendor);
  const l = normTextForFuzzy(masterLabel);
  if (!a && !v) return "both_empty";
  if (!a) return "master_artist_empty";
  if (!v) return "db_vendor_empty";
  if (a === v) return "match_after_normalize";
  if (l && (v === l || v.includes(l) || l.includes(v))) {
    return "expected: db_vendor_is_label_name (BC/Shopify convention)";
  }
  return "real_artist_drift";
}

function classifyTitleDrift(masterTitle: string, dbProductTitle: string, masterArtist: string): string {
  const m = normTextForFuzzy(masterTitle);
  const d = normTextForFuzzy(dbProductTitle);
  const a = normTextForFuzzy(masterArtist);
  if (!m && !d) return "both_empty";
  if (!m) return "master_title_empty";
  if (!d) return "db_title_empty";
  if (m === d) return "match_after_normalize";
  if (m && d.includes(m)) {
    if (a && d.includes(a)) {
      return "expected: db_title_is_denormalized (Artist - Title - Format)";
    }
    return "expected: db_title_contains_master_title";
  }
  if (d && m.includes(d)) return "master_title_is_superset_of_db";
  return "real_title_drift";
}

function classifyFormatDrift(masterFormat: string, dbFormat: string): string {
  const m = normFormat(masterFormat);
  const d = normFormat(dbFormat);
  if (!m && !d) return "both_empty";
  if (!m) return "master_format_empty";
  if (!d) return "db_format_empty";
  // Common BC item_type fallback that's effectively "unknown"
  if (d === "merch") return "db_format_unspecified (product_type=merch)";
  // Trivial synonyms
  const synonyms: Record<string, Set<string>> = {
    shirt: new Set(["shirt", "t-shirt", "tshirt", "tee"]),
    cassette: new Set(["cassette", "cs", "tape"]),
    lp: new Set(["lp", "vinyl", "12", "12 in", "record"]),
    cd: new Set(["cd"]),
    seven_inch: new Set(["7\"", "7", "7in", "7 in", "single"]),
  };
  for (const set of Object.values(synonyms)) {
    if (set.has(m) && set.has(d)) return "synonym_match";
  }
  return "real_format_drift";
}

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
// Master List loader (output of build-master-product-baseline.ts)
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
  master_row_index: number | null;
  // (other master_* fields omitted — not used by audit)
  // Derived:
  __sku_norm: string | null;
  __artist_norm: string;
  __title_norm: string;
  __format_norm: string;
  __artist_bg: Set<string>;
  __title_bg: Set<string>;
}

function loadMasterList(xlsxPath: string): MasterListRow[] {
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets["Master List"];
  if (!ws) throw new Error(`'Master List' sheet not found in ${xlsxPath}`);
  const records: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  const out: MasterListRow[] = [];
  for (const r of records) {
    const sku = r.sku == null ? null : String(r.sku);
    const artist = r.artist == null ? "" : String(r.artist);
    const item_title = r.item_title == null ? "" : String(r.item_title);
    const format = r.format == null ? "" : String(r.format);
    const artistNorm = normTextForFuzzy(artist);
    const titleNorm = normTextForFuzzy(item_title);
    out.push({
      provenance: r.provenance as MasterListRow["provenance"],
      sku,
      sku_status: r.sku_status as MasterListRow["sku_status"],
      artist,
      item_title,
      option_title: r.option_title == null ? null : String(r.option_title),
      format,
      label: r.label == null ? "" : String(r.label),
      bandcamp_url: r.bandcamp_url == null ? null : String(r.bandcamp_url),
      bandcamp_package_id: r.bandcamp_package_id == null ? null : String(r.bandcamp_package_id),
      bandcamp_option_id: r.bandcamp_option_id == null ? null : String(r.bandcamp_option_id),
      master_row_index: typeof r.master_row_index === "number" ? r.master_row_index : null,
      __sku_norm: normSku(sku),
      __artist_norm: artistNorm,
      __title_norm: titleNorm,
      __format_norm: normFormat(format),
      __artist_bg: bigramSet(artistNorm),
      __title_bg: bigramSet(titleNorm),
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// DB loader: variants joined to products
// -----------------------------------------------------------------------------

interface DbVariantRow {
  variant_id: string;
  product_id: string;
  workspace_id: string;
  sku: string | null;
  format_name: string | null;
  variant_title: string | null;
  option1_name: string | null;
  option1_value: string | null;
  bandcamp_url: string | null;
  product_title: string | null;
  product_vendor: string | null;
  product_type: string | null;
  product_status: string | null;
  // Derived:
  __sku_norm: string | null;
  __artist_norm: string;
  __title_norm: string;
  __format_norm: string;
  __artist_bg: Set<string>;
  __title_bg: Set<string>;
}

async function pageAll<T>(
  fetcher: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await fetcher(from, to);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

interface RawVariantRow {
  id: string;
  product_id: string;
  workspace_id: string;
  sku: string | null;
  format_name: string | null;
  title: string | null;
  option1_name: string | null;
  option1_value: string | null;
  bandcamp_url: string | null;
}

interface RawProductRow {
  id: string;
  title: string | null;
  vendor: string | null;
  product_type: string | null;
  status: string | null;
}

async function loadDbVariants(supabase: SupabaseClient, workspaceId: string): Promise<DbVariantRow[]> {
  const variants = await pageAll<RawVariantRow>((from, to) =>
    supabase
      .from("warehouse_product_variants")
      .select("id, product_id, workspace_id, sku, format_name, title, option1_name, option1_value, bandcamp_url")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const productIds = Array.from(new Set(variants.map((v) => v.product_id)));
  const productById = new Map<string, RawProductRow>();
  // PostgREST encodes IN-list values into the URL query string. With UUID
  // values (~37 chars each + URL escapes) a chunk of 200 fits comfortably
  // under the 16KB header limit; 500 blew past it.
  const CHUNK = 200;
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const chunk = productIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("warehouse_products")
      .select("id, title, vendor, product_type, status")
      .in("id", chunk);
    if (error) throw error;
    for (const p of (data ?? []) as RawProductRow[]) productById.set(p.id, p);
  }
  return variants.map((v) => {
    const p = productById.get(v.product_id);
    const artist = p?.vendor ?? "";
    const productTitle = p?.title ?? "";
    const fmt = v.format_name ?? p?.product_type ?? "";
    const artistNorm = normTextForFuzzy(artist);
    const titleNorm = normTextForFuzzy(productTitle);
    return {
      variant_id: v.id,
      product_id: v.product_id,
      workspace_id: v.workspace_id,
      sku: v.sku,
      format_name: v.format_name,
      variant_title: v.title,
      option1_name: v.option1_name,
      option1_value: v.option1_value,
      bandcamp_url: v.bandcamp_url,
      product_title: productTitle,
      product_vendor: artist,
      product_type: p?.product_type ?? null,
      product_status: p?.status ?? null,
      __sku_norm: normSku(v.sku),
      __artist_norm: artistNorm,
      __title_norm: titleNorm,
      __format_norm: normFormat(fmt),
      __artist_bg: bigramSet(artistNorm),
      __title_bg: bigramSet(titleNorm),
    };
  });
}

// -----------------------------------------------------------------------------
// Output row shapes
// -----------------------------------------------------------------------------

interface OkRow {
  sku: string;
  artist: string;
  item_title: string;
  format: string;
  label: string;
  provenance: string;
  db_variant_id: string;
  db_product_id: string;
}

interface DriftRow {
  sku: string;
  field: "artist" | "title" | "format";
  master_value: string;
  db_value: string;
  drift_note: string;
  master_label: string;
  master_provenance: string;
  master_artist: string;
  master_item_title: string;
  db_variant_id: string;
  db_product_id: string;
  db_variant_title: string | null;
  db_product_status: string | null;
}

interface CollisionRow {
  master_sku: string | null;
  master_provenance: string;
  master_artist: string;
  master_item_title: string;
  master_format: string;
  master_label: string;
  master_bandcamp_url: string | null;
  match_score: number;
  artist_score: number;
  title_score: number;
  db_sku: string | null;
  db_variant_id: string;
  db_product_id: string;
  db_artist: string | null;
  db_product_title: string;
  db_format: string;
  db_product_status: string | null;
  recommended_action: string;
}

interface MissingRow {
  sku: string | null;
  sku_status: string;
  provenance: string;
  artist: string;
  item_title: string;
  option_title: string | null;
  format: string;
  label: string;
  bandcamp_url: string | null;
  bandcamp_package_id: string | null;
  bandcamp_option_id: string | null;
}

interface DbOnlyRow {
  db_sku: string | null;
  db_variant_id: string;
  db_product_id: string;
  db_artist: string | null;
  db_product_title: string;
  db_variant_title: string | null;
  db_format: string;
  db_product_status: string | null;
  db_bandcamp_url: string | null;
  notes: string;
}

// -----------------------------------------------------------------------------
// Fuzzy matcher (DB side): find best DB variant for a Master row
// -----------------------------------------------------------------------------

interface FuzzyMatch {
  score: number;
  artist_score: number;
  title_score: number;
  db: DbVariantRow;
}

function bestDbFuzzyMatch(
  m: MasterListRow,
  byArtistFirstChar: Map<string, DbVariantRow[]>,
  dbAll: DbVariantRow[],
  threshold: number,
): FuzzyMatch | null {
  if (m.__artist_norm.length === 0 && m.__title_norm.length === 0) return null;
  const firstChar = m.__artist_norm.length > 0 ? m.__artist_norm[0] : "";
  const candidates: DbVariantRow[] = firstChar ? (byArtistFirstChar.get(firstChar) ?? []) : dbAll;
  const ARTIST_GATE = Math.max(0.5, threshold - 0.3);
  let best: FuzzyMatch | null = null;
  for (const db of candidates) {
    if (db.__artist_bg.size === 0 || m.__artist_bg.size === 0) continue;
    const aScore = dice(m.__artist_bg, db.__artist_bg);
    if (aScore < ARTIST_GATE) continue;
    const tScore = dice(m.__title_bg, db.__title_bg);
    const score = (aScore + tScore) / 2;
    if (!best || score > best.score) best = { score, artist_score: aScore, title_score: tScore, db };
  }
  return best;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  mkdirSync(REPORT_DIR, { recursive: true });

  console.log("[start] Master-vs-Database audit");
  console.log(`[args]  master=    ${args.masterPath}`);
  console.log(`[args]  threshold= ${args.threshold} (Dice on bigrams)`);

  const supabase: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: ws, error: wsErr } = await supabase
    .from("workspaces")
    .select("id, name, slug")
    .limit(1)
    .single();
  if (wsErr || !ws) throw new Error(`no workspace found: ${wsErr?.message ?? "empty"}`);
  console.log(`[ws]    workspace=${ws.name} (${ws.id})`);

  const masterRows = loadMasterList(args.masterPath);
  console.log(`[mstr]  master list rows: ${masterRows.length}`);
  const masterWithSku = masterRows.filter((r) => r.__sku_norm);
  const masterNoSku = masterRows.filter((r) => !r.__sku_norm);
  console.log(`[mstr]    with sku:    ${masterWithSku.length}`);
  console.log(`[mstr]    without sku: ${masterNoSku.length}`);

  console.log("[db]    loading variants + products (paginated)...");
  const dbVariants = await loadDbVariants(supabase, ws.id);
  console.log(`[db]    variants: ${dbVariants.length}`);
  const dbBySku = new Map<string, DbVariantRow[]>();
  for (const v of dbVariants) {
    const k = v.__sku_norm;
    if (!k) continue;
    let arr = dbBySku.get(k);
    if (!arr) {
      arr = [];
      dbBySku.set(k, arr);
    }
    arr.push(v);
  }
  console.log(`[db]    distinct normalized SKUs: ${dbBySku.size}`);
  const dbByArtistFirstChar = new Map<string, DbVariantRow[]>();
  for (const v of dbVariants) {
    if (v.__artist_norm.length === 0) continue;
    const c = v.__artist_norm[0];
    let arr = dbByArtistFirstChar.get(c);
    if (!arr) {
      arr = [];
      dbByArtistFirstChar.set(c, arr);
    }
    arr.push(v);
  }

  // -------------------------------------------------------------------------
  // Walk Master List → classify
  // -------------------------------------------------------------------------
  const ok: OkRow[] = [];
  const drift: DriftRow[] = [];
  const collision: CollisionRow[] = [];
  const missing: MissingRow[] = [];
  const matchedDbVariantIds = new Set<string>();

  // Track per-master classification for sanity totals
  let classifiedOk = 0;
  let classifiedDrift = 0;
  let classifiedCollision = 0;
  let classifiedMissing = 0;

  let processed = 0;
  const T0 = Date.now();
  for (const m of masterRows) {
    processed += 1;
    if (processed % 500 === 0) {
      const dt = ((Date.now() - T0) / 1000).toFixed(1);
      console.log(`[walk]  processed ${processed}/${masterRows.length} (${dt}s)`);
    }

    if (m.__sku_norm) {
      const dbHits = dbBySku.get(m.__sku_norm);
      if (dbHits && dbHits.length > 0) {
        // Mark all matched DB variants under this SKU as accounted for.
        for (const v of dbHits) matchedDbVariantIds.add(v.variant_id);
        // Compare against the FIRST hit (workspace_id+sku is UNIQUE so this is
        // virtually always 1 row; defensive code in case of bad data).
        const v = dbHits[0];
        let drifts = 0;
        if (m.__artist_norm !== v.__artist_norm && m.__artist_norm.length > 0) {
          drift.push({
            sku: m.sku as string,
            field: "artist",
            master_value: m.artist,
            db_value: v.product_vendor ?? "",
            drift_note: classifyArtistDrift(m.artist, v.product_vendor ?? "", m.label),
            master_label: m.label,
            master_provenance: m.provenance,
            master_artist: m.artist,
            master_item_title: m.item_title,
            db_variant_id: v.variant_id,
            db_product_id: v.product_id,
            db_variant_title: v.variant_title,
            db_product_status: v.product_status,
          });
          drifts += 1;
        }
        if (m.__title_norm !== v.__title_norm && m.__title_norm.length > 0) {
          drift.push({
            sku: m.sku as string,
            field: "title",
            master_value: m.item_title,
            db_value: v.product_title ?? "",
            drift_note: classifyTitleDrift(m.item_title, v.product_title ?? "", m.artist),
            master_label: m.label,
            master_provenance: m.provenance,
            master_artist: m.artist,
            master_item_title: m.item_title,
            db_variant_id: v.variant_id,
            db_product_id: v.product_id,
            db_variant_title: v.variant_title,
            db_product_status: v.product_status,
          });
          drifts += 1;
        }
        if (m.__format_norm !== v.__format_norm && m.__format_norm.length > 0) {
          drift.push({
            sku: m.sku as string,
            field: "format",
            master_value: m.format,
            db_value: (v.format_name ?? v.product_type) ?? "",
            drift_note: classifyFormatDrift(m.format, (v.format_name ?? v.product_type) ?? ""),
            master_label: m.label,
            master_provenance: m.provenance,
            master_artist: m.artist,
            master_item_title: m.item_title,
            db_variant_id: v.variant_id,
            db_product_id: v.product_id,
            db_variant_title: v.variant_title,
            db_product_status: v.product_status,
          });
          drifts += 1;
        }
        if (drifts === 0) {
          ok.push({
            sku: m.sku as string,
            artist: m.artist,
            item_title: m.item_title,
            format: m.format,
            label: m.label,
            provenance: m.provenance,
            db_variant_id: v.variant_id,
            db_product_id: v.product_id,
          });
          classifiedOk += 1;
        } else {
          classifiedDrift += 1;
        }
        continue;
      }

      // SKU not in DB → either sku_collision (fuzzy hit on different DB SKU)
      // or missing_in_db (no fuzzy hit either).
      const best = bestDbFuzzyMatch(m, dbByArtistFirstChar, dbVariants, args.threshold);
      if (best && best.score >= args.threshold && best.db.__sku_norm !== m.__sku_norm) {
        collision.push({
          master_sku: m.sku,
          master_provenance: m.provenance,
          master_artist: m.artist,
          master_item_title: m.item_title,
          master_format: m.format,
          master_label: m.label,
          master_bandcamp_url: m.bandcamp_url,
          match_score: Number(best.score.toFixed(4)),
          artist_score: Number(best.artist_score.toFixed(4)),
          title_score: Number(best.title_score.toFixed(4)),
          db_sku: best.db.sku,
          db_variant_id: best.db.variant_id,
          db_product_id: best.db.product_id,
          db_artist: best.db.product_vendor,
          db_product_title: best.db.product_title ?? "",
          db_format: (best.db.format_name ?? best.db.product_type) ?? "",
          db_product_status: best.db.product_status,
          recommended_action:
            m.provenance === "bandcamp"
              ? "rewrite_db_sku_to_master (Bandcamp baseline is canonical)"
              : "review (Master sheet is canonical only when not in Bandcamp)",
        });
        matchedDbVariantIds.add(best.db.variant_id);
        classifiedCollision += 1;
        continue;
      }

      missing.push({
        sku: m.sku,
        sku_status: m.sku_status,
        provenance: m.provenance,
        artist: m.artist,
        item_title: m.item_title,
        option_title: m.option_title,
        format: m.format,
        label: m.label,
        bandcamp_url: m.bandcamp_url,
        bandcamp_package_id: m.bandcamp_package_id,
        bandcamp_option_id: m.bandcamp_option_id,
      });
      classifiedMissing += 1;
      continue;
    }

    // Master row without SKU (pending_assignment) — fuzzy compare only.
    const best = bestDbFuzzyMatch(m, dbByArtistFirstChar, dbVariants, args.threshold);
    if (best && best.score >= args.threshold) {
      collision.push({
        master_sku: null,
        master_provenance: m.provenance,
        master_artist: m.artist,
        master_item_title: m.item_title,
        master_format: m.format,
        master_label: m.label,
        master_bandcamp_url: m.bandcamp_url,
        match_score: Number(best.score.toFixed(4)),
        artist_score: Number(best.artist_score.toFixed(4)),
        title_score: Number(best.title_score.toFixed(4)),
        db_sku: best.db.sku,
        db_variant_id: best.db.variant_id,
        db_product_id: best.db.product_id,
        db_artist: best.db.product_vendor,
        db_product_title: best.db.product_title ?? "",
        db_format: (best.db.format_name ?? best.db.product_type) ?? "",
        db_product_status: best.db.product_status,
        recommended_action:
          "use_db_sku_for_master_pending (DB has SKU, Master pending — adopt DB SKU into Master baseline)",
      });
      matchedDbVariantIds.add(best.db.variant_id);
      classifiedCollision += 1;
      continue;
    }

    missing.push({
      sku: null,
      sku_status: m.sku_status,
      provenance: m.provenance,
      artist: m.artist,
      item_title: m.item_title,
      option_title: m.option_title,
      format: m.format,
      label: m.label,
      bandcamp_url: m.bandcamp_url,
      bandcamp_package_id: m.bandcamp_package_id,
      bandcamp_option_id: m.bandcamp_option_id,
    });
    classifiedMissing += 1;
  }

  // -------------------------------------------------------------------------
  // db_only: every DB variant whose variant_id is not in matchedDbVariantIds
  // -------------------------------------------------------------------------
  const dbOnly: DbOnlyRow[] = [];
  for (const v of dbVariants) {
    if (matchedDbVariantIds.has(v.variant_id)) continue;
    dbOnly.push({
      db_sku: v.sku,
      db_variant_id: v.variant_id,
      db_product_id: v.product_id,
      db_artist: v.product_vendor,
      db_product_title: v.product_title ?? "",
      db_variant_title: v.variant_title,
      db_format: (v.format_name ?? v.product_type) ?? "",
      db_product_status: v.product_status,
      db_bandcamp_url: v.bandcamp_url,
      notes:
        v.__sku_norm == null
          ? "db_variant has NULL/empty SKU"
          : "db sku not present in Master List and no fuzzy match",
    });
  }

  // -------------------------------------------------------------------------
  // Sort outputs deterministically
  // -------------------------------------------------------------------------
  const cmp = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "").toLowerCase().localeCompare((b ?? "").toLowerCase());
  ok.sort((a, b) => cmp(a.label, b.label) || cmp(a.sku, b.sku));
  drift.sort((a, b) => cmp(a.field, b.field) || cmp(a.sku, b.sku));
  collision.sort((a, b) => b.match_score - a.match_score);
  missing.sort((a, b) => cmp(a.label, b.label) || cmp(a.artist, b.artist) || cmp(a.item_title, b.item_title));
  dbOnly.sort((a, b) => cmp(a.db_artist, b.db_artist) || cmp(a.db_sku, b.db_sku));

  // -------------------------------------------------------------------------
  // Write XLSX
  // -------------------------------------------------------------------------
  const xlsxPath = join(REPORT_DIR, `db-vs-master-conflicts-${TS}.xlsx`);
  const wb = XLSX.utils.book_new();

  const summaryRows = [
    { metric: "master_list_rows_total", count: masterRows.length },
    { metric: "  master_with_sku", count: masterWithSku.length },
    { metric: "  master_without_sku", count: masterNoSku.length },
    { metric: "db_variants_total", count: dbVariants.length },
    { metric: "db_distinct_normalized_skus", count: dbBySku.size },
    { metric: "", count: "" },
    { metric: "ok (sku match + clean)", count: ok.length },
    { metric: "conflict_metadata_drift (rows = #drifting fields)", count: drift.length },
    { metric: "  master rows with at least one drift", count: classifiedDrift },
    { metric: "conflict_sku_collision", count: collision.length },
    { metric: "missing_in_db", count: missing.length },
    { metric: "db_only (orphan / archived candidates)", count: dbOnly.length },
    { metric: "", count: "" },
    { metric: "[sanity] master_classified_total", count: classifiedOk + classifiedDrift + classifiedCollision + classifiedMissing },
    { metric: "[sanity] master_list_rows_total", count: masterRows.length },
    {
      metric: "[sanity] reconciles?",
      count:
        classifiedOk + classifiedDrift + classifiedCollision + classifiedMissing === masterRows.length
          ? "YES"
          : "NO — investigate",
    },
    { metric: "", count: "" },
    { metric: "threshold (fuzzy)", count: args.threshold },
    { metric: "ts", count: TS },
    { metric: "master_baseline_xlsx", count: args.masterPath },
    { metric: "workspace_id", count: ws.id },
    { metric: "workspace_name", count: ws.name },
  ];

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ok), "ok");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(drift), "conflict_metadata_drift");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(collision), "conflict_sku_collision");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(missing), "missing_in_db");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dbOnly), "db_only");
  XLSX.writeFile(wb, xlsxPath);

  console.log("");
  console.log("================ DONE ================");
  console.log(`Master list rows                 : ${masterRows.length}`);
  console.log(`DB variants                      : ${dbVariants.length}`);
  console.log("");
  console.log(`ok                               : ${ok.length}`);
  console.log(`conflict_metadata_drift (rows)   : ${drift.length}  (master rows w/ drift: ${classifiedDrift})`);
  console.log(`conflict_sku_collision           : ${collision.length}`);
  console.log(`missing_in_db                    : ${missing.length}`);
  console.log(`db_only                          : ${dbOnly.length}`);
  console.log("");
  console.log(
    `Sanity: ok+drift+collision+missing = ${classifiedOk + classifiedDrift + classifiedCollision + classifiedMissing} (must equal master ${masterRows.length})`,
  );
  console.log("");
  console.log(`xlsx -> ${xlsxPath}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
