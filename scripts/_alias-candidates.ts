/**
 * Alias candidate analysis — find SKUs that share (artist, album/title, format)
 * across the LIVE Bandcamp + Shopify universe.
 *
 * Why: If two SKUs have the same artist + album + format they are very likely
 * the same physical product registered under two different SKUs (typo,
 * re-import, label-vs-artist namespace collision, ShipStation Master/Alias
 * artifact). The user wants a spreadsheet of those candidate groups so they
 * can verify by eye and merge.
 *
 * Sources (NO database trust for catalog rows):
 *   Bandcamp  — getMerchDetails() per active connection (item-level + per-option SKUs)
 *   Shopify   — productVariants paginated GraphQL (id, sku, product.title,
 *               product.vendor, product.productType, product.tags,
 *               product.handle, variant.title, variant.selectedOptions)
 *
 * Grouping key = `${artist_norm} ||| ${album_norm} ||| ${format}`
 *
 * Output (`reports/alias-candidates/`):
 *   - alias-candidates-{ts}.xlsx     two sheets: "Candidates", "All SKUs"
 *   - alias-candidates-{ts}.csv      mirror of "Candidates" sheet
 *   - alias-candidates-{ts}.json     summary counts
 *
 * Read-only. Honors no kill switches; safe to run while inventory_sync_paused.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  getMerchDetails,
  getMyBands,
  refreshBandcampToken,
  type BandcampBand,
  type BandcampMerchItem,
} from "@/lib/clients/bandcamp";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// ---------------------------------------------------------------------------
// Helpers — SKU/string normalization, format inference
// ---------------------------------------------------------------------------

function cleanSku(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, "").trim();
  return t.length === 0 ? null : t;
}

function normText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip leading articles + tail noise that varies between platforms.
 * NOTE: We deliberately do NOT strip "by <artist>" suffixes — that pattern
 * destroyed legitimate titles like "Painting By Numbers". Historical-only
 * rows that came in as "Album Title by Artist Name" are rare enough to
 * tolerate as their own non-grouping rows.
 */
function normTitle(s: string | null | undefined): string {
  let t = normText(s);
  t = t.replace(/^(the|a|an)\s+/, "");
  // Strip "ep" / "lp" / "single" / "album" tail markers (format-redundant)
  t = t.replace(/\s+(ep|lp|single|album)$/, "");
  return t.trim();
}

function normArtist(s: string | null | undefined): string {
  let t = normText(s);
  t = t.replace(/^(the|a|an)\s+/, "");
  return t.trim();
}

/**
 * Pure heuristic format classifier (mirrors the one in
 * scripts/build-bandcamp-baseline-catalog.ts). Returns one of:
 * 7", 10", 12", LP, CD, Cassette, Video, Hoodie, Shirt, Hat, Patch, Pin,
 * Sticker, Tote, Drinkware, Print, Book, Bundle, Digital Album,
 * Digital Track, Merch, Unknown.
 */
function inferFormat(parts: Array<string | null | undefined>): string {
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  if (!hay.trim()) return "Unknown";

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

  return "Unknown";
}

/**
 * Best-effort artist/title split for Shopify product titles.
 *  "Foo - Bar"          → { artist: "Foo", album: "Bar" }
 *  "Foo / Bar"          → { artist: "Foo", album: "Bar" }
 *  "Foo – Bar"          → { artist: "Foo", album: "Bar" }
 *  "Bar"                → { artist: vendor ?? null, album: "Bar" }
 */
function splitTitle(
  title: string,
  vendor: string | null,
): { artist: string | null; album: string } {
  const seps = [" - ", " – ", " — ", " / "];
  for (const sep of seps) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      const left = title.slice(0, idx).trim();
      const right = title.slice(idx + sep.length).trim();
      if (left && right) return { artist: left, album: right };
    }
  }
  return { artist: vendor && vendor.trim().length > 0 ? vendor.trim() : null, album: title.trim() };
}

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

// ---------------------------------------------------------------------------
// Unified per-SKU record
// ---------------------------------------------------------------------------

interface SkuRow {
  source: "bandcamp" | "shopify";
  sku: string;

  // Logical grouping fields. We carry BOTH the item-level title (more
  // conservative — only groups SKUs whose product titles are essentially the
  // same) AND the album-level title (looser — groups all merch tied to the
  // same album, which catches multi-format aliases at the cost of more
  // false-positives like sibling colorways).
  artist: string | null;
  item_title_raw: string; // bandcamp: item.title; shopify: product.title
  album_title_raw: string; // bandcamp: album_title || item.title; shopify: same as item_title_raw
  format: string;

  // Display
  variant_label: string | null; // bandcamp: option.title; shopify: variant.title (or selectedOptions)
  bandcamp_merch_name: string | null; // bandcamp item.title
  bandcamp_url: string | null;
  shopify_url: string | null;

  // Provenance / metadata
  band_name: string | null; // bandcamp connection (label) name
  vendor: string | null; // shopify vendor
  product_status: string | null; // shopify ACTIVE/DRAFT/ARCHIVED
  package_id: number | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;

  // Pre-computed group keys (lowercase)
  group_key_tight: string; // (artist, item_title, format)
  group_key_loose: string; // (artist, album_title, format)
}

// ---------------------------------------------------------------------------
// Bandcamp loader (live API)
// ---------------------------------------------------------------------------

async function loadBandcamp(): Promise<SkuRow[]> {
  const sb = createServiceRoleClient();
  const { data: workspaces, error: wsErr } = await sb.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;

  const out: SkuRow[] = [];

  for (const ws of workspaces ?? []) {
    const { data: connections, error } = await sb
      .from("bandcamp_connections")
      .select("band_id, band_name")
      .eq("workspace_id", ws.id)
      .eq("is_active", true);
    if (error) throw error;
    if (!connections || connections.length === 0) continue;

    let token: string;
    try {
      token = await refreshBandcampToken(ws.id);
    } catch (e) {
      console.error(
        `  workspace ${ws.name}: token refresh failed — ${e instanceof Error ? e.message : e}`,
      );
      continue;
    }

    // Build artist lookup: parent band_id + each member band_id → name
    const artistLookup = new Map<number, string>();
    try {
      const bands: BandcampBand[] = await getMyBands(token);
      for (const b of bands) {
        artistLookup.set(b.band_id, b.name);
        for (const mb of b.member_bands ?? []) artistLookup.set(mb.band_id, mb.name);
      }
    } catch (e) {
      console.error(
        `  workspace ${ws.name}: getMyBands failed — ${e instanceof Error ? e.message : e}`,
      );
    }

    console.log(`  workspace ${ws.name}: ${connections.length} bandcamp bands`);
    for (const conn of connections) {
      const bandId = Number(conn.band_id);
      let items: BandcampMerchItem[] = [];
      try {
        items = await getMerchDetails(bandId, token);
      } catch (e) {
        console.error(
          `    band_id=${bandId} (${conn.band_name ?? "?"}): getMerchDetails failed — ${
            e instanceof Error ? e.message : e
          }`,
        );
        continue;
      }
      let emitted = 0;
      for (const it of items) {
        const memberBandId = it.member_band_id ?? null;
        const artist =
          (memberBandId != null ? artistLookup.get(memberBandId) : null) ??
          conn.band_name ??
          artistLookup.get(bandId) ??
          null;
        const itemTitle = it.title;
        const albumTitle = it.album_title?.trim() || it.title.trim();
        const url = bandcampUrl(it);
        const itemFormat = inferFormat([it.title, it.sku, it.item_type, null]);
        const merchName = it.title;
        const aNorm = normArtist(artist);
        const tightKeyBase = `${aNorm}|||${normTitle(itemTitle)}`;
        const looseKeyBase = `${aNorm}|||${normTitle(albumTitle)}`;

        const baseSku = cleanSku(it.sku);
        if (baseSku) {
          out.push({
            source: "bandcamp",
            sku: baseSku,
            artist,
            item_title_raw: itemTitle,
            album_title_raw: albumTitle,
            format: itemFormat,
            variant_label: null,
            bandcamp_merch_name: merchName,
            bandcamp_url: url,
            shopify_url: null,
            band_name: conn.band_name ?? null,
            vendor: null,
            product_status: null,
            package_id: it.package_id,
            shopify_product_id: null,
            shopify_variant_id: null,
            group_key_tight: `${tightKeyBase}|||${itemFormat}`,
            group_key_loose: `${looseKeyBase}|||${itemFormat}`,
          });
          emitted += 1;
        }

        for (const opt of it.options ?? []) {
          const optSku = cleanSku(opt.sku);
          if (!optSku) continue;
          const optFormat = inferFormat([it.title, optSku, it.item_type, opt.title]);
          out.push({
            source: "bandcamp",
            sku: optSku,
            artist,
            item_title_raw: itemTitle,
            album_title_raw: albumTitle,
            format: optFormat,
            variant_label: opt.title ?? null,
            bandcamp_merch_name: merchName,
            bandcamp_url: url,
            shopify_url: null,
            band_name: conn.band_name ?? null,
            vendor: null,
            product_status: null,
            package_id: it.package_id,
            shopify_product_id: null,
            shopify_variant_id: null,
            group_key_tight: `${tightKeyBase}|||${optFormat}`,
            group_key_loose: `${looseKeyBase}|||${optFormat}`,
          });
          emitted += 1;
        }
      }
      console.log(
        `    band_id=${bandId} (${conn.band_name ?? "?"}): items=${items.length} skus_emitted=${emitted}`,
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Shopify loader (live GraphQL)
// ---------------------------------------------------------------------------

const SHOPIFY_QUERY = `
  query AllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          handle
          vendor
          productType
          status
          tags
          onlineStoreUrl
          variants(first: 100) {
            edges {
              node {
                id
                sku
                title
                selectedOptions { name value }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface ShopifyProductsResp {
  products: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        title: string;
        handle: string;
        vendor: string | null;
        productType: string | null;
        status: string;
        tags: string[];
        onlineStoreUrl: string | null;
        variants: {
          edges: Array<{
            node: {
              id: string;
              sku: string | null;
              title: string | null;
              selectedOptions: Array<{ name: string; value: string }>;
            };
          }>;
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function loadShopify(): Promise<SkuRow[]> {
  const out: SkuRow[] = [];
  // Build a fallback storefront URL prefix from SHOPIFY_STORE_URL (the
  // canonical env var). Strip the protocol+host out so we can compose
  // /products/<handle>. We use the admin host as the storefront here because
  // the store is not on a custom domain — admin links resolve fine for
  // verification purposes.
  const storeUrl = process.env.SHOPIFY_STORE_URL ?? "";
  const storeHost = storeUrl ? new URL(storeUrl).host : "";
  let after: string | null = null;
  let page = 0;

  for (;;) {
    page += 1;
    const data = await shopifyGraphQL<ShopifyProductsResp>(SHOPIFY_QUERY, {
      first: 100,
      after,
    });
    const edges = data.products.edges ?? [];
    for (const e of edges) {
      const p = e.node;
      const { artist, album } = splitTitle(p.title, p.vendor);
      const tagsStr = (p.tags ?? []).join(" ");
      const productUrl =
        p.onlineStoreUrl ??
        (storeHost && p.handle ? `https://${storeHost}/products/${p.handle}` : null);
      const aNorm = normArtist(artist);
      const titleNorm = normTitle(album);

      for (const ve of p.variants.edges ?? []) {
        const v = ve.node;
        const sku = cleanSku(v.sku);
        if (!sku) continue;
        const optionsStr = (v.selectedOptions ?? []).map((o) => `${o.name}:${o.value}`).join(" ");
        const fmt = inferFormat([
          p.title,
          p.productType,
          tagsStr,
          v.title,
          optionsStr,
          sku,
        ]);
        const variantLabel =
          v.title && v.title !== "Default Title"
            ? v.title
            : (v.selectedOptions ?? []).map((o) => o.value).join(" / ") || null;
        // Shopify has no separate album concept, so tight + loose keys are
        // identical (both use product.title with artist/album split).
        const groupKey = `${aNorm}|||${titleNorm}|||${fmt}`;
        out.push({
          source: "shopify",
          sku,
          artist,
          item_title_raw: p.title,
          album_title_raw: p.title,
          format: fmt,
          variant_label: variantLabel,
          bandcamp_merch_name: null,
          bandcamp_url: null,
          shopify_url: productUrl,
          band_name: null,
          vendor: p.vendor,
          product_status: p.status,
          package_id: null,
          shopify_product_id: p.id,
          shopify_variant_id: v.id,
          group_key_tight: groupKey,
          group_key_loose: groupKey,
        });
      }
    }
    process.stdout.write(
      `\r  shopify page ${page}: edges=${edges.length} cumulative_with_sku=${out.length}      `,
    );
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  process.stdout.write("\n");
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CandidateGroup {
  key: string;
  rows: SkuRow[];
}

function buildGroups(all: SkuRow[], keyOf: (r: SkuRow) => string): CandidateGroup[] {
  const groups = new Map<string, SkuRow[]>();
  for (const r of all) {
    const key = keyOf(r);
    const [a, t] = key.split("|||");
    if (!a || !t) continue; // skip rows we can't ground in artist+title
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const candidates: CandidateGroup[] = [];
  for (const [key, rows] of groups.entries()) {
    if (rows.length < 2) continue;
    const distinctSkus = new Set(rows.map((r) => r.sku.toLowerCase()));
    if (distinctSkus.size < 2) continue;
    candidates.push({ key, rows });
  }
  candidates.sort((a, b) => {
    const aCross = new Set(a.rows.map((r) => r.source)).size;
    const bCross = new Set(b.rows.map((r) => r.source)).size;
    if (bCross !== aCross) return bCross - aCross;
    if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
    return a.key.localeCompare(b.key);
  });
  return candidates;
}

function bandcampLinkFor(rows: SkuRow[]): string {
  for (const r of rows) if (r.bandcamp_url) return r.bandcamp_url;
  return "";
}
function bandcampMerchNameFor(rows: SkuRow[]): string {
  for (const r of rows) if (r.bandcamp_merch_name) return r.bandcamp_merch_name;
  return "";
}
function shopifyLinkFor(rows: SkuRow[]): string {
  for (const r of rows) if (r.shopify_url) return r.shopify_url;
  return "";
}

/**
 * Build a per-(sku, source) → distinct-product-count map. We flag a row as
 * `sku_reused_in_source` only when the same SKU is attached to >1 distinct
 * products inside the SAME source (e.g. one SKU on two different Bandcamp
 * package_ids, or one SKU on two different Shopify products). Cross-source
 * SKU reuse (Bandcamp item SKU == Shopify variant SKU for the mirror
 * product) is the EXPECTED mapping pattern, not a bug, so we don't flag it.
 */
function reuseFlagsFor(rows: SkuRow[]): Map<string, boolean> {
  const productsBySkuSource = new Map<string, Set<string>>();
  for (const r of rows) {
    const productKey =
      r.source === "bandcamp" ? `bc:${r.package_id}` : `sh:${r.shopify_product_id}`;
    const k = `${r.source}::${r.sku.toLowerCase()}`;
    const set = productsBySkuSource.get(k) ?? new Set<string>();
    set.add(productKey);
    productsBySkuSource.set(k, set);
  }
  const flags = new Map<string, boolean>();
  for (const [k, set] of productsBySkuSource) flags.set(k, set.size > 1);
  return flags;
}

function buildSheetRows(
  candidates: CandidateGroup[],
): Array<Record<string, string | number | null>> {
  const rowsOut: Array<Record<string, string | number | null>> = [];
  candidates.forEach((g, idx) => {
    const groupId = idx + 1;
    const sources = [...new Set(g.rows.map((r) => r.source))].sort().join("+");
    const sample = g.rows[0];
    const groupBandcampLink = bandcampLinkFor(g.rows);
    const groupBandcampMerch = bandcampMerchNameFor(g.rows);
    const groupShopifyLink = shopifyLinkFor(g.rows);

    const reuseFlags = reuseFlagsFor(g.rows);

    for (const r of g.rows) {
      const reusedInSource =
        reuseFlags.get(`${r.source}::${r.sku.toLowerCase()}`) === true;
      rowsOut.push({
        group_id: groupId,
        group_size: g.rows.length,
        group_sources: sources,
        group_artist: sample.artist ?? "",
        group_album: sample.album_title_raw,
        group_item_title: sample.item_title_raw,
        group_format: sample.format,
        bandcamp_merch_name: groupBandcampMerch,
        bandcamp_link: groupBandcampLink,
        shopify_link: groupShopifyLink,
        sku_reused_in_same_source: reusedInSource ? "YES" : "",
        source: r.source,
        sku: r.sku,
        raw_item_title: r.item_title_raw,
        raw_album_title: r.album_title_raw,
        variant_label: r.variant_label ?? "",
        row_bandcamp_url: r.bandcamp_url ?? "",
        row_shopify_url: r.shopify_url ?? "",
        bandcamp_band_name: r.band_name ?? "",
        shopify_vendor: r.vendor ?? "",
        shopify_product_status: r.product_status ?? "",
        shopify_product_id: r.shopify_product_id ?? "",
        shopify_variant_id: r.shopify_variant_id ?? "",
        bandcamp_package_id: r.package_id ?? "",
      });
    }
  });
  return rowsOut;
}

function writeCsv(path: string, rows: Array<Record<string, string | number | null>>): void {
  if (rows.length === 0) {
    writeFileSync(path, "no candidate groups found\n");
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = row[h];
          if (v === null || v === undefined) return "";
          const s = String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    );
  }
  writeFileSync(path, lines.join("\n"));
}

function summarize(label: string, candidates: CandidateGroup[]): Record<string, unknown> {
  const totalRows = candidates.reduce((s, g) => s + g.rows.length, 0);
  const distinctSkus = new Set(candidates.flatMap((g) => g.rows.map((r) => r.sku.toLowerCase())))
    .size;
  const cross = candidates.filter((g) => new Set(g.rows.map((r) => r.source)).size > 1).length;
  const fmt = new Map<string, number>();
  for (const c of candidates) fmt.set(c.rows[0].format, (fmt.get(c.rows[0].format) ?? 0) + 1);
  console.log(`\n=== ${label} ===`);
  console.log(`  candidate groups: ${candidates.length}`);
  console.log(`  candidate rows:   ${totalRows}`);
  console.log(`  distinct SKUs:    ${distinctSkus}`);
  console.log(`  cross-source:     ${cross}`);
  return {
    candidate_groups: candidates.length,
    candidate_rows: totalRows,
    distinct_skus: distinctSkus,
    cross_source_groups: cross,
    format_breakdown: Object.fromEntries(
      [...fmt.entries()].sort((a, b) => b[1] - a[1]),
    ),
  };
}

async function main(): Promise<void> {
  console.log("\n=== Loading Bandcamp (live API) ===");
  const bc = await loadBandcamp();
  console.log(`bandcamp rows emitted: ${bc.length}`);

  console.log("\n=== Loading Shopify (live GraphQL) ===");
  const sh = await loadShopify();
  console.log(`shopify rows emitted: ${sh.length}`);

  const all = [...bc, ...sh];
  console.log(`\ntotal rows: ${all.length}`);

  const tightCandidates = buildGroups(all, (r) => r.group_key_tight);
  const looseCandidates = buildGroups(all, (r) => r.group_key_loose);

  const tightSummary = summarize(
    "Tight grouping (artist + item-title + format)",
    tightCandidates,
  );
  const looseSummary = summarize(
    "Loose grouping (artist + album-title + format)",
    looseCandidates,
  );

  // Write output
  const outDir = join(process.cwd(), "reports", "alias-candidates");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

  const tightRows = buildSheetRows(tightCandidates);
  const looseRows = buildSheetRows(looseCandidates);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tightRows), "Tight (item-title)");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(looseRows), "Loose (album-title)");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      all.map((r) => ({
        source: r.source,
        sku: r.sku,
        artist: r.artist ?? "",
        item_title: r.item_title_raw,
        album_title: r.album_title_raw,
        format: r.format,
        variant_label: r.variant_label ?? "",
        bandcamp_merch_name: r.bandcamp_merch_name ?? "",
        bandcamp_url: r.bandcamp_url ?? "",
        shopify_url: r.shopify_url ?? "",
        bandcamp_band_name: r.band_name ?? "",
        shopify_vendor: r.vendor ?? "",
        shopify_product_status: r.product_status ?? "",
        shopify_product_id: r.shopify_product_id ?? "",
        shopify_variant_id: r.shopify_variant_id ?? "",
        bandcamp_package_id: r.package_id ?? "",
        group_key_tight: r.group_key_tight,
        group_key_loose: r.group_key_loose,
      })),
    ),
    "All SKUs",
  );
  const xlsxPath = join(outDir, `alias-candidates-${stamp}.xlsx`);
  XLSX.writeFile(wb, xlsxPath);

  const csvTightPath = join(outDir, `alias-candidates-tight-${stamp}.csv`);
  const csvLoosePath = join(outDir, `alias-candidates-loose-${stamp}.csv`);
  writeCsv(csvTightPath, tightRows);
  writeCsv(csvLoosePath, looseRows);

  const summaryPath = join(outDir, `alias-candidates-${stamp}.json`);
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        bandcamp_rows: bc.length,
        shopify_rows: sh.length,
        total_rows: all.length,
        tight: tightSummary,
        loose: looseSummary,
      },
      null,
      2,
    ),
  );

  console.log(
    `\nwrote:\n  ${xlsxPath}\n  ${csvTightPath}\n  ${csvLoosePath}\n  ${summaryPath}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
