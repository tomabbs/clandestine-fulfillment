/**
 * Quantify the SKU + product reduction if every candidate alias group from
 * `_alias-candidates.ts` were collapsed to a single logical product.
 *
 * Reads the most-recent alias-candidates CSV mirrors (tight + loose) plus the
 * "All SKUs" sheet (we re-derive that from the live APIs to avoid a stale
 * snapshot — fast enough at ~20s) and prints:
 *
 *   - total distinct SKUs (case-folded, today)
 *   - per-grouping-mode (tight / loose):
 *       distinct SKUs inside candidate groups
 *       merged_to (= number of candidate groups)
 *       SKUs eliminated  = distinct - merged_to
 *       final SKU count  = total - eliminated
 *       % reduction
 *   - same math at the PRODUCT level, where:
 *       a "product" = unique bandcamp package_id + unique shopify product_id
 *       cross-source product reduction is computed by collapsing each
 *       candidate group to ONE product across both surfaces.
 *
 * Read-only.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  getMerchDetails,
  getMyBands,
  refreshBandcampToken,
  type BandcampBand,
  type BandcampMerchItem,
} from "@/lib/clients/bandcamp";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

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
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normTitle(s: string | null | undefined): string {
  let t = normText(s);
  t = t.replace(/^(the|a|an)\s+/, "");
  t = t.replace(/\s+(ep|lp|single|album)$/, "");
  return t.trim();
}
function normArtist(s: string | null | undefined): string {
  return normText(s).replace(/^(the|a|an)\s+/, "").trim();
}
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
function splitTitle(
  title: string,
  vendor: string | null,
): { artist: string | null; album: string } {
  for (const sep of [" - ", " – ", " — ", " / "]) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      const left = title.slice(0, idx).trim();
      const right = title.slice(idx + sep.length).trim();
      if (left && right) return { artist: left, album: right };
    }
  }
  return { artist: vendor && vendor.trim().length > 0 ? vendor.trim() : null, album: title.trim() };
}

interface Row {
  source: "bandcamp" | "shopify";
  sku: string;
  product_key: string; // unique product id within source: bc:<package_id> or sh:<gid>
  group_key_tight: string;
  group_key_loose: string;
}

async function loadBandcamp(): Promise<Row[]> {
  const sb = createServiceRoleClient();
  const { data: workspaces, error: wsErr } = await sb.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;
  const out: Row[] = [];
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
    } catch {
      continue;
    }
    const artistLookup = new Map<number, string>();
    try {
      const bands: BandcampBand[] = await getMyBands(token);
      for (const b of bands) {
        artistLookup.set(b.band_id, b.name);
        for (const mb of b.member_bands ?? []) artistLookup.set(mb.band_id, mb.name);
      }
    } catch {
      /* ignore */
    }
    for (const conn of connections) {
      const bandId = Number(conn.band_id);
      let items: BandcampMerchItem[] = [];
      try {
        items = await getMerchDetails(bandId, token);
      } catch {
        continue;
      }
      for (const it of items) {
        const memberBandId = it.member_band_id ?? null;
        const artist =
          (memberBandId != null ? artistLookup.get(memberBandId) : null) ??
          conn.band_name ??
          artistLookup.get(bandId) ??
          null;
        const aNorm = normArtist(artist);
        const tightBase = `${aNorm}|||${normTitle(it.title)}`;
        const looseBase = `${aNorm}|||${normTitle(it.album_title?.trim() || it.title.trim())}`;
        const itemFmt = inferFormat([it.title, it.sku, it.item_type, null]);
        const productKey = `bc:${it.package_id}`;
        const baseSku = cleanSku(it.sku);
        if (baseSku) {
          out.push({
            source: "bandcamp",
            sku: baseSku,
            product_key: productKey,
            group_key_tight: `${tightBase}|||${itemFmt}`,
            group_key_loose: `${looseBase}|||${itemFmt}`,
          });
        }
        for (const opt of it.options ?? []) {
          const optSku = cleanSku(opt.sku);
          if (!optSku) continue;
          const optFmt = inferFormat([it.title, optSku, it.item_type, opt.title]);
          out.push({
            source: "bandcamp",
            sku: optSku,
            product_key: productKey,
            group_key_tight: `${tightBase}|||${optFmt}`,
            group_key_loose: `${looseBase}|||${optFmt}`,
          });
        }
      }
    }
  }
  return out;
}

const SHOPIFY_QUERY = `
  query AllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      edges { cursor node {
        id title vendor productType status tags
        variants(first: 100) { edges { node { id sku title selectedOptions { name value } } } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
interface ShopifyResp {
  products: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        vendor: string | null;
        productType: string | null;
        status: string;
        tags: string[];
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
async function loadShopify(): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | null = null;
  for (;;) {
    const data: ShopifyResp = await shopifyGraphQL<ShopifyResp>(SHOPIFY_QUERY, {
      first: 100,
      after,
    });
    for (const e of data.products.edges ?? []) {
      const p = e.node;
      const { artist, album } = splitTitle(p.title, p.vendor);
      const tagsStr = (p.tags ?? []).join(" ");
      const aNorm = normArtist(artist);
      const tNorm = normTitle(album);
      for (const ve of p.variants.edges ?? []) {
        const v = ve.node;
        const sku = cleanSku(v.sku);
        if (!sku) continue;
        const optStr = (v.selectedOptions ?? []).map((o) => `${o.name}:${o.value}`).join(" ");
        const fmt = inferFormat([p.title, p.productType, tagsStr, v.title, optStr, sku]);
        const groupKey = `${aNorm}|||${tNorm}|||${fmt}`;
        out.push({
          source: "shopify",
          sku,
          product_key: `sh:${p.id}`,
          group_key_tight: groupKey,
          group_key_loose: groupKey,
        });
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return out;
}

function isUngrouped(key: string): boolean {
  const [a, t] = key.split("|||");
  return !a || !t;
}

function impact(rows: Row[], mode: "tight" | "loose"): void {
  const keyOf = (r: Row): string => (mode === "tight" ? r.group_key_tight : r.group_key_loose);

  // 1. SKU-level math (case-folded SKU is the unit of count)
  const allSkus = new Set(rows.map((r) => r.sku.toLowerCase()));
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (isUngrouped(k)) continue;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  let candidateSkuSet = new Set<string>();
  let candidateGroupCount = 0;
  for (const [, members] of groups) {
    const distinctSkus = new Set(members.map((r) => r.sku.toLowerCase()));
    if (distinctSkus.size < 2) continue;
    candidateGroupCount += 1;
    for (const s of distinctSkus) candidateSkuSet.add(s);
  }
  const skusEliminated = candidateSkuSet.size - candidateGroupCount;
  const finalSkuCount = allSkus.size - skusEliminated;
  const skuPctReduction = (skusEliminated / allSkus.size) * 100;

  // 2. Product-level math (case-folded by product_key per source)
  // Distinct products = distinct product_keys across both sources.
  const allProducts = new Set(rows.map((r) => r.product_key));
  // For each candidate group, the distinct products contributing to it become 1.
  const candidateProductSet = new Set<string>();
  let productsEliminated = 0;
  for (const [, members] of groups) {
    const distinctSkus = new Set(members.map((r) => r.sku.toLowerCase()));
    if (distinctSkus.size < 2) continue;
    const distinctProducts = new Set(members.map((r) => r.product_key));
    if (distinctProducts.size < 2) continue; // 1 product = no merge possible at product level
    for (const p of distinctProducts) candidateProductSet.add(p);
    productsEliminated += distinctProducts.size - 1;
  }
  const finalProductCount = allProducts.size - productsEliminated;
  const productPctReduction = (productsEliminated / allProducts.size) * 100;

  console.log(`\n=== ${mode.toUpperCase()} grouping (artist + ${mode === "tight" ? "item-title" : "album-title"} + format) ===`);
  console.log(`SKUs (case-folded distinct):`);
  console.log(`  total today:                   ${allSkus.size}`);
  console.log(`  in candidate groups:           ${candidateSkuSet.size}`);
  console.log(`  candidate groups (= merged-to): ${candidateGroupCount}`);
  console.log(
    `  SKUs eliminated by merge:      ${skusEliminated}  (${skuPctReduction.toFixed(1)}% of total)`,
  );
  console.log(`  → final SKU count after merge: ${finalSkuCount}`);
  console.log(`Products (distinct bc package_id + distinct shopify product_id):`);
  console.log(`  total today:                   ${allProducts.size}`);
  console.log(`  contributing to merges:        ${candidateProductSet.size}`);
  console.log(
    `  products eliminated by merge:  ${productsEliminated}  (${productPctReduction.toFixed(1)}% of total)`,
  );
  console.log(`  → final product count:         ${finalProductCount}`);
}

async function main(): Promise<void> {
  console.log("Loading Bandcamp + Shopify (live)…");
  const bc = await loadBandcamp();
  const sh = await loadShopify();
  const all = [...bc, ...sh];
  console.log(`bandcamp rows=${bc.length}  shopify rows=${sh.length}  total rows=${all.length}`);
  impact(all, "tight");
  impact(all, "loose");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
