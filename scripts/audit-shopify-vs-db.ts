import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

/**
 * Inverse-direction coverage audit:
 *   1. All Shopify SKUs       → are they in warehouse_product_variants?
 *   2. Shopify SKUs not on Bandcamp (Distro Only) → are they in DB?
 *
 * Pairs with `audit-bandcamp-vs-db-and-shopify.ts` to give 360° catalog
 * coverage. Read-only — no mutations.
 */

type ShopifyVariant = { id: string; sku: string | null };
type ShopifyProduct = {
  id: string;
  title: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  variants: { nodes: ShopifyVariant[] };
};

function normSku(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

function toNumeric(gid: string): string {
  const m = gid.match(/(\d+)$/);
  return m?.[1] ?? gid;
}

async function loadShopifyAll(): Promise<ShopifyProduct[]> {
  const all: ShopifyProduct[] = [];
  let cursor: string | null = null;
  while (true) {
    const query = `
      query Q($cursor: String) {
        products(first: 200, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            status
            variants(first: 100) { nodes { id sku } }
          }
        }
      }
    `;
    const data: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyProduct[];
      };
    } = await shopifyGraphQL(query, { cursor });
    all.push(...data.products.nodes);
    process.stdout.write(`\r  shopify fetched ${all.length}`);
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  process.stdout.write("\n");
  return all;
}

async function loadDbVariantSkus(sb: ReturnType<typeof createServiceRoleClient>) {
  const skus = new Set<string>();
  const skuToVariant = new Map<
    string,
    { id: string; product_id: string; sku: string; org_id: string | null }
  >();
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("id, product_id, sku, warehouse_products!inner(org_id)")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const v of data as unknown as Array<{
      id: string;
      product_id: string;
      sku: string;
      warehouse_products: { org_id: string | null } | null;
    }>) {
      const ns = normSku(v.sku);
      if (!ns) continue;
      skus.add(ns);
      skuToVariant.set(ns, {
        id: v.id,
        product_id: v.product_id,
        sku: v.sku,
        org_id: v.warehouse_products?.org_id ?? null,
      });
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return { skus, skuToVariant };
}

async function loadBandcampMappingSkus(sb: ReturnType<typeof createServiceRoleClient>) {
  // Variant SKUs that have ANY Bandcamp mapping (umbrella + per-option metadata).
  const set = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("bandcamp_product_mappings")
      .select(
        "variant_id, bandcamp_option_skus, warehouse_product_variants:variant_id(sku)",
      )
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const m of data as unknown as Array<{
      variant_id: string;
      bandcamp_option_skus: string[] | null;
      warehouse_product_variants: { sku: string | null } | null;
    }>) {
      const primary = normSku(m.warehouse_product_variants?.sku);
      if (primary) set.add(primary);
      for (const opt of m.bandcamp_option_skus ?? []) {
        const n = normSku(opt);
        if (n) set.add(n);
      }
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return set;
}

async function main() {
  const sb = createServiceRoleClient();

  console.log("[load] shopify products …");
  const shopify = await loadShopifyAll();

  console.log("[load] db variants + bandcamp mappings …");
  const [{ skus: dbSkus, skuToVariant }, bandcampSkus] = await Promise.all([
    loadDbVariantSkus(sb),
    loadBandcampMappingSkus(sb),
  ]);

  console.log(
    `[loaded] shopify_products=${shopify.length} db_variant_skus=${dbSkus.size} bandcamp_mapped_skus=${bandcampSkus.size}`,
  );

  type Row = {
    shopify_product_id: string;
    shopify_status: string;
    shopify_title: string;
    shopify_variant_id: string;
    sku_raw: string;
    sku_normalized: string;
    in_db: boolean;
    is_bandcamp: boolean;
    classification: string;
  };
  const rows: Row[] = [];

  for (const p of shopify) {
    for (const v of p.variants.nodes) {
      const ns = normSku(v.sku);
      const inDb = ns ? dbSkus.has(ns) : false;
      const isBandcamp = ns ? bandcampSkus.has(ns) : false;
      let classification = "";
      if (!ns) classification = "shopify_variant_no_sku";
      else if (inDb && isBandcamp) classification = "fully_aligned_bandcamp";
      else if (inDb && !isBandcamp) classification = "distro_only_in_db";
      else if (!inDb && isBandcamp)
        classification = "shopify_only_but_in_bandcamp_metadata";
      else classification = "shopify_only_missing_from_db";
      rows.push({
        shopify_product_id: toNumeric(p.id),
        shopify_status: p.status,
        shopify_title: p.title,
        shopify_variant_id: toNumeric(v.id),
        sku_raw: v.sku ?? "",
        sku_normalized: ns,
        in_db: inDb,
        is_bandcamp: isBandcamp,
        classification,
      });
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    shopify: {
      products: shopify.length,
      variants: rows.length,
      variants_with_sku: rows.filter((r) => r.sku_normalized).length,
      unique_skus: new Set(rows.map((r) => r.sku_normalized).filter(Boolean)).size,
      by_status: {
        ACTIVE: shopify.filter((p) => p.status === "ACTIVE").length,
        DRAFT: shopify.filter((p) => p.status === "DRAFT").length,
        ARCHIVED: shopify.filter((p) => p.status === "ARCHIVED").length,
      },
    },
    coverage: {
      shopify_skus_in_db: rows.filter((r) => r.in_db).length,
      shopify_skus_missing_from_db: rows.filter(
        (r) => r.sku_normalized && !r.in_db,
      ).length,
      distro_only_in_db: rows.filter((r) => r.classification === "distro_only_in_db").length,
      bandcamp_aligned: rows.filter((r) => r.classification === "fully_aligned_bandcamp")
        .length,
      shopify_only_missing_from_db: rows.filter(
        (r) => r.classification === "shopify_only_missing_from_db",
      ).length,
      shopify_variant_no_sku: rows.filter((r) => !r.sku_normalized).length,
    },
    missing_from_db_breakdown_by_status: {
      ACTIVE: rows.filter(
        (r) => r.classification === "shopify_only_missing_from_db" && r.shopify_status === "ACTIVE",
      ).length,
      DRAFT: rows.filter(
        (r) => r.classification === "shopify_only_missing_from_db" && r.shopify_status === "DRAFT",
      ).length,
      ARCHIVED: rows.filter(
        (r) =>
          r.classification === "shopify_only_missing_from_db" && r.shopify_status === "ARCHIVED",
      ).length,
    },
  };
  console.log(JSON.stringify(summary, null, 2));

  const outDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csv = join(outDir, `shopify-vs-db-${stamp}.csv`);
  const json = join(outDir, `shopify-vs-db-summary-${stamp}.json`);

  const header = [
    "shopify_product_id",
    "shopify_status",
    "shopify_title",
    "shopify_variant_id",
    "sku_raw",
    "sku_normalized",
    "in_db",
    "is_bandcamp",
    "classification",
  ].join(",");
  const cell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        cell(r.shopify_product_id),
        cell(r.shopify_status),
        cell(r.shopify_title),
        cell(r.shopify_variant_id),
        cell(r.sku_raw),
        cell(r.sku_normalized),
        cell(r.in_db ? "yes" : "no"),
        cell(r.is_bandcamp ? "yes" : "no"),
        cell(r.classification),
      ].join(","),
    );
  }
  writeFileSync(csv, lines.join("\n"), "utf8");
  writeFileSync(json, JSON.stringify({ summary, sample_rows: rows.slice(0, 50) }, null, 2));
  console.log(`[done] csv=${csv}\n       summary=${json}`);

  // Tiny sample of the gap so the user can spot-check.
  const gaps = rows
    .filter((r) => r.classification === "shopify_only_missing_from_db")
    .slice(0, 10);
  if (gaps.length > 0) {
    console.log("\n[gap sample] first 10 Shopify variants missing from DB:");
    for (const g of gaps) {
      console.log(
        `  - [${g.shopify_status}] ${g.sku_raw || "(no sku)"}  ${g.shopify_title.slice(0, 60)}`,
      );
    }
  }

  // Distro-only sanity sample.
  const distroSample = rows
    .filter((r) => r.classification === "distro_only_in_db")
    .slice(0, 5);
  if (distroSample.length > 0) {
    console.log("\n[distro-only sample] first 5 (Shopify-only items in DB, not Bandcamp):");
    for (const d of distroSample) {
      const v = skuToVariant.get(d.sku_normalized);
      console.log(
        `  - ${d.sku_raw} → ${d.shopify_title.slice(0, 60)} ${v?.org_id ? `org=${v.org_id}` : "no org"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
