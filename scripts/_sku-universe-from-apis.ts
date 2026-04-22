/**
 * SKU universe count — pulled live from Bandcamp + Shopify APIs.
 *
 * Goal: answer the question "how many distinct SKUs exist when you union
 * everything Bandcamp shows us across all bands with everything Shopify
 * shows us in the Clandestine store" — without trusting our DB.
 *
 * Outputs:
 *   - distinct SKUs across all Bandcamp bands (item-level + option-level)
 *   - distinct SKUs in Clandestine Shopify
 *   - Shopify SKUs NOT in Bandcamp
 *   - Bandcamp SKUs NOT in Shopify (bonus — useful symmetric counterpart)
 *   - intersection size + grand total = unique SKUs across both surfaces
 *
 * DB usage is limited to: enumerating connected bands and fetching the
 * Bandcamp OAuth token. No SKU comes from our DB.
 *
 * Side effects: NONE. Pure read.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getMerchDetails, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

function clean(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const t = sku.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, "").trim();
  return t.length === 0 ? null : t;
}

interface BandcampSkuRow {
  sku: string;
  band_id: number;
  band_name: string | null;
  package_id: number;
  level: "item" | "option";
}

interface ShopifySkuRow {
  sku: string;
  product_id: string;
  variant_id: string;
  product_title: string;
  product_status: string;
}

async function loadBandcamp(): Promise<BandcampSkuRow[]> {
  const sb = createServiceRoleClient();
  const { data: workspaces, error: wsErr } = await sb.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;

  const out: BandcampSkuRow[] = [];

  for (const ws of workspaces ?? []) {
    const { data: connections, error } = await sb
      .from("bandcamp_connections")
      .select("band_id, band_name")
      .eq("workspace_id", ws.id)
      .eq("is_active", true);
    if (error) throw error;
    if (!connections || connections.length === 0) {
      console.log(`  workspace ${ws.name}: 0 active bandcamp_connections`);
      continue;
    }

    let token: string;
    try {
      token = await refreshBandcampToken(ws.id);
    } catch (e) {
      console.error(`  workspace ${ws.name}: token refresh failed — ${e instanceof Error ? e.message : e}`);
      continue;
    }

    console.log(`  workspace ${ws.name}: ${connections.length} bands`);
    for (const conn of connections) {
      try {
        const items = await getMerchDetails(Number(conn.band_id), token);
        let bandSkuCount = 0;
        for (const it of items) {
          const baseSku = clean(it.sku);
          if (baseSku) {
            out.push({
              sku: baseSku,
              band_id: Number(conn.band_id),
              band_name: conn.band_name ?? null,
              package_id: it.package_id,
              level: "item",
            });
            bandSkuCount++;
          }
          for (const opt of it.options ?? []) {
            const optSku = clean(opt.sku);
            if (!optSku) continue;
            out.push({
              sku: optSku,
              band_id: Number(conn.band_id),
              band_name: conn.band_name ?? null,
              package_id: it.package_id,
              level: "option",
            });
            bandSkuCount++;
          }
        }
        console.log(
          `    band_id=${conn.band_id} (${conn.band_name ?? "?"}): items=${items.length} skus_emitted=${bandSkuCount}`,
        );
      } catch (e) {
        console.error(
          `    band_id=${conn.band_id} (${conn.band_name ?? "?"}): getMerchDetails failed — ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }

  return out;
}

const SHOPIFY_VARIANTS_QUERY = `
  query AllVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          sku
          product {
            id
            title
            status
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface VariantsResponse {
  productVariants: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        sku: string | null;
        product: { id: string; title: string; status: string };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function loadShopify(): Promise<ShopifySkuRow[]> {
  const out: ShopifySkuRow[] = [];
  let after: string | null = null;
  let page = 0;
  for (;;) {
    page++;
    const data = await shopifyGraphQL<VariantsResponse>(SHOPIFY_VARIANTS_QUERY, {
      first: 250,
      after,
    });
    const edges = data.productVariants.edges ?? [];
    for (const e of edges) {
      const sku = clean(e.node.sku);
      if (!sku) continue;
      out.push({
        sku,
        product_id: e.node.product.id,
        variant_id: e.node.id,
        product_title: e.node.product.title,
        product_status: e.node.product.status,
      });
    }
    process.stdout.write(`\r  shopify page ${page}: edges=${edges.length} cumulative_with_sku=${out.length}      `);
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }
  process.stdout.write("\n");
  return out;
}

function setUnion<T>(...sets: Set<T>[]): Set<T> {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}
function setIntersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}
function setDifference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (!b.has(v)) out.add(v);
  return out;
}

async function main() {
  console.log("\n=== Bandcamp (live API) ===");
  const bcRows = await loadBandcamp();
  const bcSkus = new Set(bcRows.map((r) => r.sku));
  const bcSkusCaseFolded = new Set([...bcSkus].map((s) => s.toLowerCase()));
  console.log(`bandcamp distinct SKUs (case-sensitive): ${bcSkus.size}`);
  console.log(`bandcamp distinct SKUs (case-folded):    ${bcSkusCaseFolded.size}`);

  console.log("\n=== Shopify (live GraphQL) ===");
  const shRows = await loadShopify();
  const shSkus = new Set(shRows.map((r) => r.sku));
  const shSkusCaseFolded = new Set([...shSkus].map((s) => s.toLowerCase()));
  console.log(`shopify distinct SKUs (case-sensitive):  ${shSkus.size}`);
  console.log(`shopify distinct SKUs (case-folded):     ${shSkusCaseFolded.size}`);

  // Set math (case-folded — Bandcamp vs Shopify casing varies in practice)
  const intersection = setIntersect(bcSkusCaseFolded, shSkusCaseFolded);
  const onlyInShopify = setDifference(shSkusCaseFolded, bcSkusCaseFolded);
  const onlyInBandcamp = setDifference(bcSkusCaseFolded, shSkusCaseFolded);
  const union = setUnion(bcSkusCaseFolded, shSkusCaseFolded);

  console.log("\n=== Set math (case-folded SKU comparison) ===");
  console.log(`bandcamp ∩ shopify (in both):            ${intersection.size}`);
  console.log(`shopify only (NOT in bandcamp):          ${onlyInShopify.size}`);
  console.log(`bandcamp only (NOT in shopify):          ${onlyInBandcamp.size}`);
  console.log(`union (total distinct across both):      ${union.size}`);

  // Write CSVs for follow-up
  const outDir = join(process.cwd(), "reports", "sku-universe");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

  writeFileSync(
    join(outDir, `bandcamp-skus-${stamp}.csv`),
    [
      "sku,band_id,band_name,package_id,level",
      ...bcRows.map(
        (r) =>
          `"${r.sku.replace(/"/g, '""')}",${r.band_id},"${(r.band_name ?? "").replace(/"/g, '""')}",${r.package_id},${r.level}`,
      ),
    ].join("\n"),
  );

  writeFileSync(
    join(outDir, `shopify-skus-${stamp}.csv`),
    [
      "sku,variant_id,product_id,product_title,product_status",
      ...shRows.map(
        (r) =>
          `"${r.sku.replace(/"/g, '""')}","${r.variant_id}","${r.product_id}","${r.product_title.replace(/"/g, '""')}",${r.product_status}`,
      ),
    ].join("\n"),
  );

  writeFileSync(
    join(outDir, `summary-${stamp}.json`),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        bandcamp_distinct_skus_case_sensitive: bcSkus.size,
        bandcamp_distinct_skus_case_folded: bcSkusCaseFolded.size,
        shopify_distinct_skus_case_sensitive: shSkus.size,
        shopify_distinct_skus_case_folded: shSkusCaseFolded.size,
        intersection_case_folded: intersection.size,
        shopify_only_case_folded: onlyInShopify.size,
        bandcamp_only_case_folded: onlyInBandcamp.size,
        union_case_folded: union.size,
      },
      null,
      2,
    ),
  );

  console.log(`\nwrote: ${outDir}/{bandcamp-skus,shopify-skus,summary}-${stamp}.{csv,json}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
