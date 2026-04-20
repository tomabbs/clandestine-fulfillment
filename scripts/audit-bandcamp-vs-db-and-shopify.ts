import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMerchDetails, refreshBandcampToken } from "@/lib/clients/bandcamp";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type ShopifyVariant = { id: string; sku: string | null };
type ShopifyProduct = {
  id: string;
  title: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  variants: { nodes: ShopifyVariant[] };
};

type Connection = {
  id: string;
  workspace_id: string;
  org_id: string;
  band_id: number;
  band_name: string | null;
  band_url: string | null;
  is_active: boolean;
};

type BandcampSku = {
  workspace_id: string;
  org_id: string;
  connection_band_id: number;
  connection_band_name: string;
  source_band_id: number;
  source_band_name: string;
  source_band_subdomain: string;
  package_id: number;
  item_title: string;
  album_title: string;
  item_type: string;
  url: string;
  option_id: number | null;
  option_title: string;
  sku: string;
  sku_normalized: string;
  price: number | null;
  currency: string;
  quantity_available: number | null;
  is_top_level: boolean;
};

function normSku(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9\-_./]/g, "");
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replaceAll('"', '""').replaceAll(/\r?\n/g, " ")}"`;
}

function toNumeric(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

async function fetchAllShopify(): Promise<ShopifyProduct[]> {
  const out: ShopifyProduct[] = [];
  let after: string | null = null;
  while (true) {
    const data: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyProduct[];
      };
    } = await shopifyGraphQL(
      `query Products($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title status
            variants(first: 50) { nodes { id sku } }
          }
        }
      }`,
      { first: 200, after },
    );
    out.push(...data.products.nodes);
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
    process.stdout.write(`  shopify fetched ${out.length}\r`);
  }
  process.stdout.write("\n");
  return out;
}

async function fetchAllConnections(): Promise<Connection[]> {
  const sb = createServiceRoleClient();
  const { data, error } = await sb
    .from("bandcamp_connections")
    .select("id, workspace_id, org_id, band_id, band_name, band_url, is_active");
  if (error) throw error;
  return (data ?? []) as Connection[];
}

async function fetchDbIndices() {
  const sb = createServiceRoleClient();

  const variantBySku = new Map<string, { id: string; product_id: string; org_id: string | null }>();
  const variantById = new Map<string, { id: string; product_id: string; sku: string }>();
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("id, product_id, sku, warehouse_products!inner(org_id, shopify_product_id)")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const v of data as unknown as Array<{
      id: string;
      product_id: string;
      sku: string;
      warehouse_products: { org_id: string | null; shopify_product_id: string | null } | null;
    }>) {
      const ns = normSku(v.sku);
      if (ns) {
        variantBySku.set(ns, {
          id: v.id,
          product_id: v.product_id,
          org_id: v.warehouse_products?.org_id ?? null,
        });
      }
      variantById.set(v.id, { id: v.id, product_id: v.product_id, sku: v.sku });
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  const mappingByPackage = new Map<
    string,
    {
      id: string;
      variant_id: string;
      bandcamp_item_id: number;
      bandcamp_option_skus: string[];
    }
  >();
  from = 0;
  while (true) {
    const { data, error } = await sb
      .from("bandcamp_product_mappings")
      .select("id, workspace_id, variant_id, bandcamp_item_id, bandcamp_option_skus")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const m of data as Array<{
      id: string;
      workspace_id: string;
      variant_id: string;
      bandcamp_item_id: number;
      bandcamp_option_skus: string[] | null;
    }>) {
      mappingByPackage.set(`${m.workspace_id}:${m.bandcamp_item_id}`, {
        id: m.id,
        variant_id: m.variant_id,
        bandcamp_item_id: m.bandcamp_item_id,
        // Use the same normalization the Bandcamp side uses so apparel option
        // SKUs with `&` / spaces match (e.g. `TS-NS-G&T-S` ↔ `TS-NS-GT-S`).
        bandcamp_option_skus: (m.bandcamp_option_skus ?? []).map((s) => normSku(s)),
      });
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  const productById = new Map<
    string,
    { id: string; title: string | null; org_id: string | null; shopify_product_id: string | null }
  >();
  from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_products")
      .select("id, title, org_id, shopify_product_id")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const p of data as Array<{
      id: string;
      title: string | null;
      org_id: string | null;
      shopify_product_id: string | null;
    }>) {
      productById.set(p.id, p);
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  return { variantBySku, variantById, mappingByPackage, productById };
}

async function pollBandcamp(connections: Connection[]): Promise<BandcampSku[]> {
  const out: BandcampSku[] = [];

  const byWs = new Map<string, Connection[]>();
  for (const c of connections) {
    const arr = byWs.get(c.workspace_id) ?? [];
    arr.push(c);
    byWs.set(c.workspace_id, arr);
  }

  let wsIdx = 0;
  for (const [workspaceId, conns] of byWs) {
    wsIdx += 1;
    console.log(
      `[ws ${wsIdx}/${byWs.size}] workspace=${workspaceId} connections=${conns.length}`,
    );

    let token: string;
    try {
      token = await refreshBandcampToken(workspaceId);
    } catch (err) {
      console.warn(`  [skip] token refresh failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    // Only poll the actual connection band_ids — only labels with credentials own merch APIs.
    // Sub-artists/member_bands surface their releases under the parent label's catalog.
    let bIdx = 0;
    for (const conn of conns) {
      bIdx += 1;
      const band = {
        band_id: conn.band_id,
        name: conn.band_name ?? `band-${conn.band_id}`,
        subdomain: "",
        root_band_id: conn.band_id,
        root_band_name: conn.band_name ?? "",
      };
      try {
        const merch = await getMerchDetails(band.band_id, token);
        let pkgCount = 0;
        let skuCount = 0;
        for (const p of merch) {
          pkgCount += 1;
          const topSku = p.sku ?? "";
          if (topSku) {
            skuCount += 1;
            out.push({
              workspace_id: workspaceId,
              org_id: conn?.org_id ?? "",
              connection_band_id: conn?.band_id ?? band.root_band_id,
              connection_band_name: conn?.band_name ?? band.root_band_name,
              source_band_id: band.band_id,
              source_band_name: band.name,
              source_band_subdomain: band.subdomain,
              package_id: p.package_id,
              item_title: p.title,
              album_title: p.album_title ?? "",
              item_type: p.item_type ?? "",
              url: p.url ?? "",
              option_id: null,
              option_title: "",
              sku: topSku,
              sku_normalized: normSku(topSku),
              price: p.price ?? null,
              currency: p.currency ?? "",
              quantity_available: p.quantity_available ?? null,
              is_top_level: true,
            });
          }
          for (const o of p.options ?? []) {
            const oSku = o.sku ?? "";
            if (!oSku) continue;
            skuCount += 1;
            out.push({
              workspace_id: workspaceId,
              org_id: conn?.org_id ?? "",
              connection_band_id: conn?.band_id ?? band.root_band_id,
              connection_band_name: conn?.band_name ?? band.root_band_name,
              source_band_id: band.band_id,
              source_band_name: band.name,
              source_band_subdomain: band.subdomain,
              package_id: p.package_id,
              item_title: p.title,
              album_title: p.album_title ?? "",
              item_type: p.item_type ?? "",
              url: p.url ?? "",
              option_id: o.option_id,
              option_title: o.title ?? "",
              sku: oSku,
              sku_normalized: normSku(oSku),
              price: p.price ?? null,
              currency: p.currency ?? "",
              quantity_available: o.quantity_available ?? null,
              is_top_level: false,
            });
          }
        }
        console.log(
          `  [conn ${bIdx}/${conns.length}] ${band.name} (id=${band.band_id}) packages=${pkgCount} skus=${skuCount}`,
        );
      } catch (err) {
        console.warn(
          `  [conn ${bIdx}/${conns.length}] ${band.name} FAILED: ${err instanceof Error ? err.message : err}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return out;
}

async function main() {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });

  console.log("[start] live audit Bandcamp API → DB → Clandestine Shopify");
  const connections = await fetchAllConnections();
  console.log(`[loaded] bandcamp_connections=${connections.length}`);

  const [shopifyProducts, db] = await Promise.all([fetchAllShopify(), fetchDbIndices()]);
  const shopifySkuToProducts = new Map<string, ShopifyProduct[]>();
  const shopifyVariantSkuActive = new Set<string>();
  const shopifyVariantSkuNonArchived = new Set<string>();
  const shopifyVariantSkuAny = new Set<string>();
  for (const p of shopifyProducts) {
    for (const v of p.variants.nodes) {
      const ns = normSku(v.sku);
      if (!ns) continue;
      shopifyVariantSkuAny.add(ns);
      if (p.status !== "ARCHIVED") shopifyVariantSkuNonArchived.add(ns);
      if (p.status === "ACTIVE") shopifyVariantSkuActive.add(ns);
      const arr = shopifySkuToProducts.get(ns) ?? [];
      arr.push(p);
      shopifySkuToProducts.set(ns, arr);
    }
  }
  console.log(
    `[loaded] shopify_products=${shopifyProducts.length} shopify_unique_skus=${shopifyVariantSkuAny.size} db_variants=${db.variantBySku.size} db_mappings=${db.mappingByPackage.size}`,
  );

  console.log("[poll] hitting Bandcamp API for every connection × band × package …");
  const bandcamp = await pollBandcamp(connections);
  console.log(`[bandcamp] sku_rows=${bandcamp.length}`);

  // Per-row classification
  type Row = BandcampSku & {
    in_db_mapping: boolean;
    db_mapping_variant_id: string;
    in_db_variant_by_sku: boolean;
    db_variant_id: string;
    db_product_id: string;
    db_product_title: string;
    db_product_org_id: string;
    db_shopify_product_id: string;
    in_shopify_any: boolean;
    in_shopify_non_archived: boolean;
    in_shopify_active: boolean;
    shopify_product_ids: string;
    shopify_statuses: string;
    classification: string;
  };

  const rows: Row[] = [];
  for (const b of bandcamp) {
    const ns = b.sku_normalized;
    const mappingKey = `${b.workspace_id}:${b.package_id}`;
    const mapping = db.mappingByPackage.get(mappingKey);
    const variant = ns ? db.variantBySku.get(ns) : undefined;
    const product = variant ? db.productById.get(variant.product_id) : undefined;
    const shopMatches = ns ? shopifySkuToProducts.get(ns) ?? [] : [];

    const inShopifyAny = shopMatches.length > 0;
    const inShopifyNonArchived = shopMatches.some((p) => p.status !== "ARCHIVED");
    const inShopifyActive = shopMatches.some((p) => p.status === "ACTIVE");

    // `tracked_as_metadata`: this option SKU is recorded inside an existing
    // package mapping's `bandcamp_option_skus` array (legacy umbrella shape)
    // but does NOT yet exist as a first-class warehouse_product_variants row.
    // These are NOT lost data — they're awaiting Path B/C apparel restructure.
    const trackedAsMetadata =
      !variant &&
      ns !== null &&
      ns !== "" &&
      mapping !== undefined &&
      mapping.bandcamp_option_skus.includes(ns);

    let classification = "";
    if (mapping && variant && inShopifyNonArchived) classification = "fully_aligned";
    else if (variant && inShopifyNonArchived && !mapping)
      classification = "in_db_and_shopify_no_bandcamp_mapping";
    else if (variant && !inShopifyNonArchived) classification = "in_db_missing_from_shopify";
    else if (!variant && inShopifyNonArchived) classification = "in_shopify_missing_from_db";
    else if (trackedAsMetadata) classification = "tracked_as_metadata";
    else if (!variant && !inShopifyAny) classification = "missing_from_db_and_shopify";
    else classification = "other";

    rows.push({
      ...b,
      in_db_mapping: Boolean(mapping),
      db_mapping_variant_id: mapping?.variant_id ?? "",
      in_db_variant_by_sku: Boolean(variant),
      db_variant_id: variant?.id ?? "",
      db_product_id: variant?.product_id ?? "",
      db_product_title: product?.title ?? "",
      db_product_org_id: product?.org_id ?? "",
      db_shopify_product_id: product?.shopify_product_id ?? "",
      in_shopify_any: inShopifyAny,
      in_shopify_non_archived: inShopifyNonArchived,
      in_shopify_active: inShopifyActive,
      shopify_product_ids: shopMatches.map((p) => toNumeric(p.id)).join("|"),
      shopify_statuses: shopMatches.map((p) => p.status).join("|"),
      classification,
    });
  }

  const summary = {
    timestamp: new Date().toISOString(),
    bandcamp: {
      sku_rows_total: bandcamp.length,
      sku_rows_with_sku: rows.filter((r) => r.sku_normalized).length,
      sku_rows_without_sku: rows.filter((r) => !r.sku_normalized).length,
      unique_skus: new Set(rows.map((r) => r.sku_normalized).filter(Boolean)).size,
      unique_packages: new Set(rows.map((r) => `${r.workspace_id}:${r.package_id}`)).size,
      bands_polled: new Set(rows.map((r) => r.source_band_id)).size,
    },
    coverage: {
      bandcamp_skus_in_db_variants: rows.filter((r) => r.in_db_variant_by_sku).length,
      bandcamp_skus_missing_from_db: rows.filter((r) => !r.in_db_variant_by_sku).length,
      bandcamp_skus_tracked_as_metadata: rows.filter((r) => r.classification === "tracked_as_metadata").length,
      bandcamp_packages_with_db_mapping: rows.filter((r) => r.in_db_mapping).length,
      bandcamp_packages_without_db_mapping: rows.filter((r) => !r.in_db_mapping).length,
      bandcamp_skus_in_shopify_any: rows.filter((r) => r.in_shopify_any).length,
      bandcamp_skus_in_shopify_non_archived: rows.filter((r) => r.in_shopify_non_archived).length,
      bandcamp_skus_in_shopify_active: rows.filter((r) => r.in_shopify_active).length,
      bandcamp_skus_missing_from_shopify: rows.filter((r) => !r.in_shopify_any).length,
    },
    classification_counts: rows.reduce(
      (a, r) => {
        a[r.classification] = (a[r.classification] ?? 0) + 1;
        return a;
      },
      {} as Record<string, number>,
    ),
  };

  console.log(JSON.stringify(summary, null, 2));

  const header = [
    "workspace_id",
    "org_id",
    "connection_band_id",
    "connection_band_name",
    "source_band_id",
    "source_band_name",
    "source_band_subdomain",
    "package_id",
    "item_title",
    "album_title",
    "item_type",
    "option_id",
    "option_title",
    "sku",
    "sku_normalized",
    "is_top_level",
    "price",
    "currency",
    "quantity_available",
    "in_db_mapping",
    "db_mapping_variant_id",
    "in_db_variant_by_sku",
    "db_variant_id",
    "db_product_id",
    "db_product_title",
    "db_product_org_id",
    "db_shopify_product_id",
    "in_shopify_any",
    "in_shopify_non_archived",
    "in_shopify_active",
    "shopify_product_ids",
    "shopify_statuses",
    "classification",
    "url",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.workspace_id),
        csvCell(r.org_id),
        csvCell(r.connection_band_id),
        csvCell(r.connection_band_name),
        csvCell(r.source_band_id),
        csvCell(r.source_band_name),
        csvCell(r.source_band_subdomain),
        csvCell(r.package_id),
        csvCell(r.item_title),
        csvCell(r.album_title),
        csvCell(r.item_type),
        csvCell(r.option_id ?? ""),
        csvCell(r.option_title),
        csvCell(r.sku),
        csvCell(r.sku_normalized),
        csvCell(r.is_top_level ? "yes" : "no"),
        csvCell(r.price ?? ""),
        csvCell(r.currency),
        csvCell(r.quantity_available ?? ""),
        csvCell(r.in_db_mapping ? "yes" : "no"),
        csvCell(r.db_mapping_variant_id),
        csvCell(r.in_db_variant_by_sku ? "yes" : "no"),
        csvCell(r.db_variant_id),
        csvCell(r.db_product_id),
        csvCell(r.db_product_title),
        csvCell(r.db_product_org_id),
        csvCell(r.db_shopify_product_id),
        csvCell(r.in_shopify_any ? "yes" : "no"),
        csvCell(r.in_shopify_non_archived ? "yes" : "no"),
        csvCell(r.in_shopify_active ? "yes" : "no"),
        csvCell(r.shopify_product_ids),
        csvCell(r.shopify_statuses),
        csvCell(r.classification),
        csvCell(r.url),
      ].join(","),
    );
  }
  const csvPath = join(reportDir, `bandcamp-vs-db-and-shopify-live-${ts}.csv`);
  writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
  const summaryPath = join(reportDir, `bandcamp-vs-db-and-shopify-summary-${ts}.json`);
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[done] csv=${csvPath}`);
  console.log(`       summary=${summaryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
