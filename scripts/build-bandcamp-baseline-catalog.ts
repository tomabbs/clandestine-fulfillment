#!/usr/bin/env tsx
/**
 * Bandcamp baseline catalog spreadsheet — pulled DIRECTLY from the Bandcamp
 * API (merch + lifetime sales backfill). NO joins to the Clandestine database
 * for the catalog rows themselves; we only use the database to enumerate which
 * `bandcamp_connections` (parent band_ids) we have OAuth access to and to
 * resolve the workspace token.
 *
 * Output is the unpolluted Bandcamp truth so you can compare it against
 * Postgres / ShipStation / Shopify after the fact.
 *
 * Per band, we call:
 *   1. getMyBands(token)        → resolves member-band names for label accounts
 *   2. getMerchDetails(band_id) → currently-listed merch (item-level + per-option SKUs)
 *   3. getOrders({ bandId, startTime: 2000-01-01 }) → lifetime sales backfill,
 *      so we can surface SKUs that have ever sold even if they are no longer
 *      listed (item_url, item_name, option, sku).
 *
 * Output (in `reports/`):
 *   - `bandcamp-baseline-catalog-{ts}.xlsx` with three sheets:
 *       "Catalog (live)"     — one row per merch item OR option SKU
 *       "Sales (lifetime)"   — one row per sale_item_id from get_orders
 *       "Bands"              — connection summary + counts
 *   - `bandcamp-baseline-catalog-{ts}.csv`  — mirror of the Catalog sheet
 *   - `bandcamp-baseline-catalog-{ts}.json` — run summary + per-band counts
 *
 * Required columns (per user request):
 *   sku (live on Bandcamp now), artist, title, format, merch_name, link
 * Plus everything else useful the API returns.
 *
 * Usage:
 *   npx tsx scripts/build-bandcamp-baseline-catalog.ts [--workspace=<uuid>]
 *
 * Read-only (no DB writes). Honors no kill switches; safe to run while
 * `inventory_sync_paused=true` because we never call Bandcamp from a write
 * path here.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import {
  getMerchDetails,
  getMyBands,
  getOrders,
  refreshBandcampToken,
  type BandcampBand,
  type BandcampMerchItem,
  type BandcampOrderItem,
} from "@/lib/clients/bandcamp";

const supabase: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const REPORT_DIR = "reports";
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

interface CliArgs {
  workspaceId: string | null;
}

function parseArgs(): CliArgs {
  const out: CliArgs = { workspaceId: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--workspace=")) out.workspaceId = a.split("=")[1] ?? null;
  }
  return out;
}

function normalizeSku(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Pure-Bandcamp format heuristic. Does NOT consult the DB `warehouse_format_rules`
 * table — we want this script to stay independent of database catalog tagging.
 * Returns one of: LP, 7", 10", 12", CD, Cassette, Shirt, Hoodie, Hat, Patch,
 * Print, Poster, Bundle, Book, Zine, Sticker, Pin, Tote, Mug, Other, or Unknown.
 *
 * Strategy: scan title + sku + item_type + option text. Patterns are ordered
 * by specificity (most specific first wins).
 */
function inferFormat(
  title: string | null | undefined,
  sku: string | null | undefined,
  itemType: string | null | undefined,
  optionTitle: string | null | undefined,
): string {
  const hay = [title ?? "", sku ?? "", itemType ?? "", optionTitle ?? ""]
    .join(" ")
    .toLowerCase();
  if (!hay.trim()) return "Unknown";

  // Vinyl format size first — these are the highest-value categorizations.
  if (/\b7["”]\b|\b7\s?inch\b|\b7"\b|\b7-?inch\b|\bep\s+7\b/.test(hay)) return '7"';
  if (/\b10["”]\b|\b10\s?inch\b|\b10"\b|\b10-?inch\b/.test(hay)) return '10"';
  if (/\b12["”]\b|\b12\s?inch\b|\b12"\b|\b12-?inch\b/.test(hay)) return '12"';
  if (/\blp\b|\bdouble lp\b|\b2xlp\b|\b2x lp\b|\bvinyl\b|\bgatefold\b|\b33\s?rpm\b/.test(hay))
    return "LP";

  if (/\bcassette\b|\bcasset\b|\btape\b|\bk7\b|\bmc\b/.test(hay)) return "Cassette";
  if (/\bcd\b|\bcompact disc\b|\bdigipak\b|\bdigipack\b/.test(hay)) return "CD";
  if (/\bdvd\b|\bblu-?ray\b|\bvhs\b/.test(hay)) return "Video";

  if (/\bhood(ie|y)\b|\bsweatshirt\b|\bcrewneck\b|\bjumper\b/.test(hay)) return "Hoodie";
  if (/\b(t-?)shirt\b|\btshirt\b|\bjersey\b|\btank\b|\blongsleeve\b|\blong sleeve\b/.test(hay))
    return "Shirt";
  if (/\bhat\b|\bcap\b|\bbeanie\b|\btoque\b|\btoboggan\b/.test(hay)) return "Hat";
  if (/\bpatch\b|\bembroidered\b/.test(hay)) return "Patch";
  if (/\bpin\b|\benamel pin\b|\bbutton\b/.test(hay)) return "Pin";
  if (/\bsticker\b|\bdecal\b/.test(hay)) return "Sticker";
  if (/\btote\b|\bbag\b|\bbackpack\b/.test(hay)) return "Tote";
  if (/\bmug\b|\bglass\b|\bcup\b|\bbottle\b|\bkoozie\b/.test(hay)) return "Drinkware";
  if (/\bposter\b|\bprint\b|\blithograph\b|\bsilkscreen\b/.test(hay)) return "Print";
  if (/\bbook\b|\bzine\b|\bnovel\b|\bcomic\b/.test(hay)) return "Book";
  if (/\bbundle\b|\bbox set\b|\bpackage deal\b/.test(hay)) return "Bundle";

  // Bandcamp item_type as last-resort signal.
  if (itemType) {
    const t = itemType.toLowerCase();
    if (t.includes("album")) return "Digital Album";
    if (t.includes("track")) return "Digital Track";
    if (t.includes("merch") || t.includes("package")) return "Merch";
  }
  return "Unknown";
}

/**
 * Bandcamp merch URL — prefer the item's own `url`, else build
 * https://{subdomain}.bandcamp.com/merch/{slug?} … but we usually don't have
 * a slug, so when url is missing we just emit the storefront. Item-detail
 * URLs that the API returns are absolute.
 */
function bandcampUrl(item: BandcampMerchItem): string | null {
  if (item.url) {
    if (item.url.startsWith("http")) return item.url;
    if (item.url.startsWith("//")) return `https:${item.url}`;
    if (item.subdomain) return `https://${item.subdomain}.bandcamp.com${item.url}`;
    return null;
  }
  if (item.subdomain) return `https://${item.subdomain}.bandcamp.com/merch`;
  return null;
}

interface CatalogRow {
  workspace_id: string;
  connection_band_id: number;
  connection_band_name: string | null;
  artist: string | null;
  member_band_id: number | null;
  member_band_subdomain: string | null;
  package_id: number;
  item_title: string;
  album_title: string | null;
  merch_name: string;
  option_id: number | null;
  option_title: string | null;
  sku: string | null;
  item_type: string | null;
  format_inferred: string;
  url: string | null;
  image_url: string | null;
  price: number | null;
  currency: string | null;
  is_set_price: boolean | null;
  new_date: string | null;
  quantity_available_now: number | null;
  quantity_sold_lifetime_api: number | null;
  has_options: boolean;
  origin_quantities_count: number;
  source: "merch_listing" | "merch_listing_option" | "historical_only";
  historical_units_sold: number;
  historical_orders: number;
  first_sale_date: string | null;
  last_sale_date: string | null;
}

interface SalesRow {
  workspace_id: string;
  connection_band_id: number;
  connection_band_name: string | null;
  sale_item_id: number;
  payment_id: number;
  order_date: string | null;
  artist: string | null;
  item_name: string | null;
  option: string | null;
  sku: string | null;
  quantity: number | null;
  sub_total: number | null;
  shipping: number | null;
  currency: string | null;
  buyer_country: string | null;
  ship_date: string | null;
  payment_state: string | null;
  item_url: string | null;
}

interface BandSummaryRow {
  workspace_id: string;
  connection_band_id: number;
  connection_band_name: string | null;
  member_bands_count: number;
  merch_items: number;
  merch_options: number;
  catalog_rows_emitted: number;
  catalog_rows_with_sku: number;
  sales_rows_emitted: number;
  sales_distinct_skus: number;
  sales_skus_not_in_live_catalog: number;
  errors: string[];
}

async function loadActiveConnections(workspaceId: string | null): Promise<
  Array<{
    workspace_id: string;
    band_id: number;
    band_name: string | null;
  }>
> {
  let q = supabase
    .from("bandcamp_connections")
    .select("workspace_id, band_id, band_name, is_active")
    .eq("is_active", true);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => ({
    workspace_id: r.workspace_id as string,
    band_id: Number(r.band_id),
    band_name: (r.band_name as string | null) ?? null,
  }));
}

async function buildArtistLookup(token: string): Promise<Map<number, string>> {
  const lookup = new Map<number, string>();
  let bands: BandcampBand[] = [];
  try {
    bands = await getMyBands(token);
  } catch (err) {
    console.error(
      `[bands] getMyBands failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return lookup;
  }
  for (const b of bands) {
    lookup.set(b.band_id, b.name);
    for (const mb of b.member_bands ?? []) {
      lookup.set(mb.band_id, mb.name);
    }
  }
  return lookup;
}

async function processBand(
  workspaceId: string,
  bandId: number,
  bandName: string | null,
  token: string,
  artistLookup: Map<number, string>,
  catalog: CatalogRow[],
  sales: SalesRow[],
): Promise<BandSummaryRow> {
  const summary: BandSummaryRow = {
    workspace_id: workspaceId,
    connection_band_id: bandId,
    connection_band_name: bandName,
    member_bands_count: 0,
    merch_items: 0,
    merch_options: 0,
    catalog_rows_emitted: 0,
    catalog_rows_with_sku: 0,
    sales_rows_emitted: 0,
    sales_distinct_skus: 0,
    sales_skus_not_in_live_catalog: 0,
    errors: [],
  };

  // --- Live merch ---
  let items: BandcampMerchItem[] = [];
  try {
    items = await getMerchDetails(bandId, token);
  } catch (err) {
    const msg = `getMerchDetails failed: ${err instanceof Error ? err.message : "unknown"}`;
    console.error(`[bc band=${bandId}] ${msg}`);
    summary.errors.push(msg);
  }
  summary.merch_items = items.length;

  const liveSkus = new Set<string>();
  const itemByPackageId = new Map<number, BandcampMerchItem>();

  for (const it of items) {
    itemByPackageId.set(it.package_id, it);
    const memberBandId = it.member_band_id ?? null;
    const artist =
      (memberBandId != null ? artistLookup.get(memberBandId) : null) ??
      bandName ??
      artistLookup.get(bandId) ??
      null;
    const url = bandcampUrl(it);
    const baseSku = normalizeSku(it.sku);
    const itemFormat = inferFormat(it.title, it.sku, it.item_type, null);

    // Always emit one row per item (with item-level SKU when present, else null
    // so the catalog still lists products that only have per-option SKUs).
    catalog.push({
      workspace_id: workspaceId,
      connection_band_id: bandId,
      connection_band_name: bandName,
      artist,
      member_band_id: memberBandId,
      member_band_subdomain: it.subdomain ?? null,
      package_id: it.package_id,
      item_title: it.title,
      album_title: it.album_title ?? null,
      merch_name: it.title,
      option_id: null,
      option_title: null,
      sku: baseSku,
      item_type: it.item_type ?? null,
      format_inferred: itemFormat,
      url,
      image_url: it.image_url ?? null,
      price: it.price ?? null,
      currency: it.currency ?? null,
      is_set_price:
        typeof it.is_set_price === "boolean"
          ? it.is_set_price
          : typeof it.is_set_price === "number"
            ? it.is_set_price === 1
            : null,
      new_date: it.new_date ?? null,
      quantity_available_now: it.quantity_available ?? null,
      quantity_sold_lifetime_api: it.quantity_sold ?? null,
      has_options: (it.options ?? []).length > 0,
      origin_quantities_count: (it.origin_quantities ?? []).length,
      source: "merch_listing",
      historical_units_sold: 0,
      historical_orders: 0,
      first_sale_date: null,
      last_sale_date: null,
    });
    summary.catalog_rows_emitted += 1;
    if (baseSku) {
      summary.catalog_rows_with_sku += 1;
      liveSkus.add(baseSku);
    }

    for (const opt of it.options ?? []) {
      summary.merch_options += 1;
      const optSku = normalizeSku(opt.sku);
      catalog.push({
        workspace_id: workspaceId,
        connection_band_id: bandId,
        connection_band_name: bandName,
        artist,
        member_band_id: memberBandId,
        member_band_subdomain: it.subdomain ?? null,
        package_id: it.package_id,
        item_title: it.title,
        album_title: it.album_title ?? null,
        merch_name: opt.title ? `${it.title} — ${opt.title}` : it.title,
        option_id: opt.option_id,
        option_title: opt.title ?? null,
        sku: optSku,
        item_type: it.item_type ?? null,
        format_inferred: inferFormat(it.title, optSku, it.item_type, opt.title),
        url,
        image_url: it.image_url ?? null,
        price: it.price ?? null,
        currency: it.currency ?? null,
        is_set_price:
          typeof it.is_set_price === "boolean"
            ? it.is_set_price
            : typeof it.is_set_price === "number"
              ? it.is_set_price === 1
              : null,
        new_date: it.new_date ?? null,
        quantity_available_now: opt.quantity_available ?? null,
        quantity_sold_lifetime_api: opt.quantity_sold ?? null,
        has_options: true,
        origin_quantities_count: (it.origin_quantities ?? []).length,
        source: "merch_listing_option",
        historical_units_sold: 0,
        historical_orders: 0,
        first_sale_date: null,
        last_sale_date: null,
      });
      summary.catalog_rows_emitted += 1;
      if (optSku) {
        summary.catalog_rows_with_sku += 1;
        liveSkus.add(optSku);
      }
    }
  }

  // --- Lifetime sales backfill ---
  let orders: BandcampOrderItem[] = [];
  try {
    orders = await getOrders({ bandId, startTime: "2000-01-01 00:00:00" }, token);
  } catch (err) {
    const msg = `getOrders failed: ${err instanceof Error ? err.message : "unknown"}`;
    console.error(`[bc band=${bandId}] ${msg}`);
    summary.errors.push(msg);
  }
  summary.sales_rows_emitted = orders.length;

  // Aggregations per SKU for catalog enrichment + historical-only emission.
  interface SkuAgg {
    units: number;
    orders: number;
    firstDate: string | null;
    lastDate: string | null;
    sample: BandcampOrderItem;
  }
  const aggBySku = new Map<string, SkuAgg>();
  const aggByItemUrl = new Map<string, SkuAgg>();
  const distinctSkus = new Set<string>();

  for (const o of orders) {
    sales.push({
      workspace_id: workspaceId,
      connection_band_id: bandId,
      connection_band_name: bandName,
      sale_item_id: o.sale_item_id,
      payment_id: o.payment_id,
      order_date: o.order_date ?? null,
      artist: o.artist ?? null,
      item_name: o.item_name ?? null,
      option: o.option ?? null,
      sku: normalizeSku(o.sku),
      quantity: o.quantity ?? null,
      sub_total: o.sub_total ?? null,
      shipping: o.shipping ?? null,
      currency: o.currency ?? null,
      buyer_country: o.ship_to_country_code ?? o.ship_to_country ?? null,
      ship_date: o.ship_date ?? null,
      payment_state: o.payment_state ?? null,
      item_url: o.item_url ?? null,
    });

    const sku = normalizeSku(o.sku);
    const qty = o.quantity ?? 0;
    const date = o.order_date ?? null;

    const apply = (agg: SkuAgg) => {
      agg.units += qty;
      agg.orders += 1;
      if (date) {
        if (!agg.firstDate || date < agg.firstDate) agg.firstDate = date;
        if (!agg.lastDate || date > agg.lastDate) agg.lastDate = date;
      }
    };

    if (sku) {
      distinctSkus.add(sku);
      const ex = aggBySku.get(sku);
      if (ex) apply(ex);
      else aggBySku.set(sku, { units: qty, orders: 1, firstDate: date, lastDate: date, sample: o });
    }
    if (o.item_url) {
      const ex = aggByItemUrl.get(o.item_url);
      if (ex) apply(ex);
      else
        aggByItemUrl.set(o.item_url, {
          units: qty,
          orders: 1,
          firstDate: date,
          lastDate: date,
          sample: o,
        });
    }
  }
  summary.sales_distinct_skus = distinctSkus.size;

  // Enrich existing catalog rows with historical aggregates by SKU.
  for (const row of catalog) {
    if (row.connection_band_id !== bandId) continue;
    if (!row.sku) continue;
    const agg = aggBySku.get(row.sku);
    if (!agg) continue;
    row.historical_units_sold = agg.units;
    row.historical_orders = agg.orders;
    row.first_sale_date = agg.firstDate;
    row.last_sale_date = agg.lastDate;
  }

  // Emit historical-only rows: SKUs that have ever sold for this band but are
  // not present in the live merch listing.
  for (const [sku, agg] of Array.from(aggBySku.entries())) {
    if (liveSkus.has(sku)) continue;
    summary.sales_skus_not_in_live_catalog += 1;
    const o = agg.sample;
    catalog.push({
      workspace_id: workspaceId,
      connection_band_id: bandId,
      connection_band_name: bandName,
      artist: o.artist ?? bandName ?? null,
      member_band_id: null,
      member_band_subdomain: null,
      package_id: 0,
      item_title: o.item_name ?? "(historical sale only)",
      album_title: null,
      merch_name: o.option ? `${o.item_name ?? ""} — ${o.option}` : (o.item_name ?? ""),
      option_id: null,
      option_title: o.option ?? null,
      sku,
      item_type: null,
      format_inferred: inferFormat(o.item_name, sku, null, o.option),
      url: o.item_url ?? null,
      image_url: null,
      price: null,
      currency: o.currency ?? null,
      is_set_price: null,
      new_date: null,
      quantity_available_now: null,
      quantity_sold_lifetime_api: null,
      has_options: false,
      origin_quantities_count: 0,
      source: "historical_only",
      historical_units_sold: agg.units,
      historical_orders: agg.orders,
      first_sale_date: agg.firstDate,
      last_sale_date: agg.lastDate,
    });
    summary.catalog_rows_emitted += 1;
    summary.catalog_rows_with_sku += 1;
  }

  return summary;
}

function writeXlsx(
  outPath: string,
  catalog: CatalogRow[],
  sales: SalesRow[],
  bands: BandSummaryRow[],
) {
  const wb = XLSX.utils.book_new();
  const catalogSheet = XLSX.utils.json_to_sheet(catalog);
  XLSX.utils.book_append_sheet(wb, catalogSheet, "Catalog (live)");
  const salesSheet = XLSX.utils.json_to_sheet(sales);
  XLSX.utils.book_append_sheet(wb, salesSheet, "Sales (lifetime)");
  const bandsSheet = XLSX.utils.json_to_sheet(
    bands.map((b) => ({ ...b, errors: b.errors.join("; ") })),
  );
  XLSX.utils.book_append_sheet(wb, bandsSheet, "Bands");
  XLSX.writeFile(wb, outPath);
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(outPath: string, rows: CatalogRow[]) {
  if (rows.length === 0) {
    writeFileSync(outPath, "");
    return;
  }
  const headers = Object.keys(rows[0]) as Array<keyof CatalogRow>;
  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  writeFileSync(outPath, lines.join("\n"));
}

async function main() {
  const args = parseArgs();
  mkdirSync(REPORT_DIR, { recursive: true });

  console.log("[start] Bandcamp baseline catalog build");
  console.log(`[args]  workspaceId=${args.workspaceId ?? "(all)"}`);

  const conns = await loadActiveConnections(args.workspaceId);
  console.log(`[conns] active bandcamp_connections: ${conns.length}`);
  if (conns.length === 0) {
    console.error("[error] No active connections — aborting.");
    process.exit(1);
  }

  // Group by workspace so we refresh the token + my_bands lookup once per workspace.
  const byWorkspace = new Map<string, typeof conns>();
  for (const c of conns) {
    const list = byWorkspace.get(c.workspace_id) ?? [];
    list.push(c);
    byWorkspace.set(c.workspace_id, list);
  }

  const catalog: CatalogRow[] = [];
  const sales: SalesRow[] = [];
  const bands: BandSummaryRow[] = [];
  const startedAt = new Date().toISOString();

  for (const [wsId, wsConns] of Array.from(byWorkspace.entries())) {
    console.log(`[ws=${wsId}] refreshing token + loading my_bands`);
    const token = await refreshBandcampToken(wsId);
    const artistLookup = await buildArtistLookup(token);
    console.log(`[ws=${wsId}] artist lookup entries: ${artistLookup.size}`);

    for (const c of wsConns) {
      const label = `${c.band_name ?? "(no-name)"} (${c.band_id})`;
      process.stdout.write(`[band] ${label} … `);
      const t0 = Date.now();
      const summary = await processBand(
        wsId,
        c.band_id,
        c.band_name,
        token,
        artistLookup,
        catalog,
        sales,
      );
      bands.push(summary);
      const dt = Date.now() - t0;
      console.log(
        `merch=${summary.merch_items} options=${summary.merch_options} sales=${summary.sales_rows_emitted} catalog_rows=${summary.catalog_rows_emitted} historical_only=${summary.sales_skus_not_in_live_catalog} (${dt}ms)`,
      );
      if (summary.errors.length > 0) {
        for (const e of summary.errors) console.log(`  [err] ${e}`);
      }
    }
  }

  // Sort catalog deterministically: artist, item_title, option_title, sku.
  catalog.sort((a, b) => {
    const k = (s: string | null | undefined) => (s ?? "").toLowerCase();
    return (
      k(a.artist).localeCompare(k(b.artist)) ||
      k(a.item_title).localeCompare(k(b.item_title)) ||
      k(a.option_title).localeCompare(k(b.option_title)) ||
      k(a.sku).localeCompare(k(b.sku))
    );
  });

  const outBase = join(REPORT_DIR, `bandcamp-baseline-catalog-${TS}`);
  const xlsxPath = `${outBase}.xlsx`;
  const csvPath = `${outBase}.csv`;
  const jsonPath = `${outBase}.json`;

  writeXlsx(xlsxPath, catalog, sales, bands);
  writeCsv(csvPath, catalog);

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    workspace_filter: args.workspaceId,
    workspaces_touched: byWorkspace.size,
    connections_processed: conns.length,
    catalog_rows: catalog.length,
    catalog_rows_with_sku: catalog.filter((r) => r.sku).length,
    catalog_rows_historical_only: catalog.filter((r) => r.source === "historical_only").length,
    distinct_live_skus: new Set(
      catalog.filter((r) => r.source !== "historical_only" && r.sku).map((r) => r.sku),
    ).size,
    distinct_historical_skus: new Set(
      catalog.filter((r) => r.source === "historical_only").map((r) => r.sku),
    ).size,
    sales_rows: sales.length,
    bands,
    files: {
      xlsx: xlsxPath,
      csv: csvPath,
      json: jsonPath,
    },
  };
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  console.log("");
  console.log("================ DONE ================");
  console.log(`workspaces:               ${summary.workspaces_touched}`);
  console.log(`connections:              ${summary.connections_processed}`);
  console.log(`catalog rows total:       ${summary.catalog_rows}`);
  console.log(`  with sku:               ${summary.catalog_rows_with_sku}`);
  console.log(`  historical_only:        ${summary.catalog_rows_historical_only}`);
  console.log(`distinct live skus:       ${summary.distinct_live_skus}`);
  console.log(`distinct historical skus: ${summary.distinct_historical_skus}`);
  console.log(`sales rows:               ${summary.sales_rows}`);
  console.log("");
  console.log(`xlsx → ${xlsxPath}`);
  console.log(`csv  → ${csvPath}`);
  console.log(`json → ${jsonPath}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
