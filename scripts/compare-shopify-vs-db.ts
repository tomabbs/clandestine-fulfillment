import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type ShopifyVariant = { id: string; sku: string | null; title: string | null };
type ShopifyProduct = {
  id: string;
  title: string;
  vendor: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  productType: string | null;
  createdAt: string;
  variants: { nodes: ShopifyVariant[] };
};

type DbProduct = {
  id: string;
  title: string | null;
  vendor: string | null;
  product_type: string | null;
  shopify_product_id: string | null;
  status: string | null;
  org_id: string | null;
  created_at: string;
};

type DbVariant = {
  id: string;
  product_id: string;
  sku: string;
  title: string | null;
  workspace_id: string;
};

function normSku(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9\-_./]/g, "");
}

function normTitle(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toNumeric(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replaceAll('"', '""').replaceAll(/\r?\n/g, " ")}"`;
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
        products(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title vendor status productType createdAt
            variants(first: 50) { nodes { id sku title } }
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
  process.stdout.write(`\n`);
  return out;
}

async function fetchAllDbProducts() {
  const sb = createServiceRoleClient();
  const products: DbProduct[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_products")
      .select("id, title, vendor, product_type, shopify_product_id, status, org_id, created_at")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    products.push(...(data as DbProduct[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  const variants: DbVariant[] = [];
  from = 0;
  while (true) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("id, product_id, sku, title, workspace_id")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    variants.push(...(data as DbVariant[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  return { products, variants };
}

async function main() {
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });

  console.log("[fetch] Shopify (all statuses) + DB warehouse_products + warehouse_product_variants");
  const [shopify, db] = await Promise.all([fetchAllShopify(), fetchAllDbProducts()]);
  console.log(
    `[loaded] shopify_products=${shopify.length} db_products=${db.products.length} db_variants=${db.variants.length}`,
  );

  // Build Shopify indices
  const shopifyById = new Map<string, ShopifyProduct>();
  const shopifySkuToProduct = new Map<string, ShopifyProduct[]>();
  let shopifyVariantTotal = 0;
  let shopifyVariantWithSku = 0;
  const shopifyByStatus = { ACTIVE: 0, DRAFT: 0, ARCHIVED: 0 };
  const shopifyAllSkus = new Set<string>();
  const shopifyActiveSkus = new Set<string>();
  const shopifyNonArchivedSkus = new Set<string>();
  for (const p of shopify) {
    shopifyById.set(toNumeric(p.id), p);
    shopifyByStatus[p.status]++;
    for (const v of p.variants.nodes) {
      shopifyVariantTotal++;
      const sku = normSku(v.sku);
      if (!sku) continue;
      shopifyVariantWithSku++;
      shopifyAllSkus.add(sku);
      if (p.status !== "ARCHIVED") shopifyNonArchivedSkus.add(sku);
      if (p.status === "ACTIVE") shopifyActiveSkus.add(sku);
      const arr = shopifySkuToProduct.get(sku) ?? [];
      arr.push(p);
      shopifySkuToProduct.set(sku, arr);
    }
  }

  // Build DB indices
  const dbProductById = new Map<string, DbProduct>();
  for (const p of db.products) dbProductById.set(p.id, p);

  const dbVariantsByProduct = new Map<string, DbVariant[]>();
  const dbSkuToVariants = new Map<string, DbVariant[]>();
  let dbVariantsWithSku = 0;
  for (const v of db.variants) {
    const arr = dbVariantsByProduct.get(v.product_id) ?? [];
    arr.push(v);
    dbVariantsByProduct.set(v.product_id, arr);
    const sku = normSku(v.sku);
    if (!sku) continue;
    dbVariantsWithSku++;
    const arr2 = dbSkuToVariants.get(sku) ?? [];
    arr2.push(v);
    dbSkuToVariants.set(sku, arr2);
  }
  const dbAllSkus = new Set<string>(dbSkuToVariants.keys());

  // Linkage: db.shopify_product_id → shopify rows
  const dbShopifyRefs = db.products
    .map((p) => ({
      product: p,
      ref: p.shopify_product_id
        ? p.shopify_product_id.includes("/")
          ? p.shopify_product_id.split("/").pop() ?? p.shopify_product_id
          : p.shopify_product_id
        : null,
    }))
    .filter((r) => r.ref !== null) as Array<{ product: DbProduct; ref: string }>;

  const refToDbRows = new Map<string, DbProduct[]>();
  for (const r of dbShopifyRefs) {
    const arr = refToDbRows.get(r.ref) ?? [];
    arr.push(r.product);
    refToDbRows.set(r.ref, arr);
  }
  const uniqueDbReferencedShopifyIds = new Set(refToDbRows.keys());

  const dbRefsHittingShopify = [...uniqueDbReferencedShopifyIds].filter((id) =>
    shopifyById.has(id),
  );
  const dbRefsMissingFromShopify = [...uniqueDbReferencedShopifyIds].filter(
    (id) => !shopifyById.has(id),
  );

  const shopifyIdsWithoutDbRef = [...shopifyById.keys()].filter(
    (id) => !uniqueDbReferencedShopifyIds.has(id),
  );

  // Duplicates
  const dbDuplicateLinkGroups = [...refToDbRows.entries()].filter(([, rows]) => rows.length > 1);
  const dbExtraDuplicateRows = dbDuplicateLinkGroups.reduce(
    (a, [, rows]) => a + (rows.length - 1),
    0,
  );

  const shopifyDuplicateSkuGroups = [...shopifySkuToProduct.entries()].filter(
    ([, products]) => new Set(products.map((p) => p.id)).size > 1,
  );

  const dbDuplicateSkuGroups = [...dbSkuToVariants.entries()].filter(
    ([, variants]) => new Set(variants.map((v) => v.product_id)).size > 1,
  );

  // SKU coverage
  const skuInBoth = [...shopifyAllSkus].filter((s) => dbAllSkus.has(s)).length;
  const skuOnlyInShopify = [...shopifyAllSkus].filter((s) => !dbAllSkus.has(s));
  const skuOnlyInDb = [...dbAllSkus].filter((s) => !shopifyAllSkus.has(s));
  const skuActiveInBoth = [...shopifyActiveSkus].filter((s) => dbAllSkus.has(s)).length;
  const skuNonArchivedInBoth = [...shopifyNonArchivedSkus].filter((s) =>
    dbAllSkus.has(s),
  ).length;

  // Status alignment for linked rows
  let statusAligned = 0;
  let statusMismatch = 0;
  const statusMismatchSamples: Array<{ shopify: string; db: string; sku: string }> = [];
  for (const r of dbShopifyRefs) {
    const sp = shopifyById.get(r.ref);
    if (!sp) continue;
    const dbStatus = (r.product.status ?? "").toLowerCase();
    const shStatus = sp.status.toLowerCase();
    if (dbStatus === "" || dbStatus === shStatus) {
      statusAligned++;
    } else {
      statusMismatch++;
      if (statusMismatchSamples.length < 20) {
        statusMismatchSamples.push({
          shopify: shStatus,
          db: dbStatus,
          sku: dbVariantsByProduct.get(r.product.id)?.[0]?.sku ?? "",
        });
      }
    }
  }

  // Title alignment for linked rows (informational)
  let titleAligned = 0;
  let titleMismatch = 0;
  const titleMismatchSamples: Array<{ shopify: string; db: string; id: string }> = [];
  for (const r of dbShopifyRefs) {
    const sp = shopifyById.get(r.ref);
    if (!sp) continue;
    if (normTitle(sp.title) === normTitle(r.product.title)) titleAligned++;
    else {
      titleMismatch++;
      if (titleMismatchSamples.length < 20) {
        titleMismatchSamples.push({ shopify: sp.title, db: r.product.title ?? "", id: r.ref });
      }
    }
  }

  // Variant-level: of shopify products that ARE linked to db, do their variant SKUs match?
  let variantSkuExactMatch = 0;
  let variantSkuPartialMatch = 0;
  let variantSkuMismatch = 0;
  for (const [shopifyId, dbRows] of refToDbRows.entries()) {
    const sp = shopifyById.get(shopifyId);
    if (!sp) continue;
    const dbSkus = new Set(
      dbRows.flatMap((p) => (dbVariantsByProduct.get(p.id) ?? []).map((v) => normSku(v.sku))),
    );
    const shSkus = new Set(sp.variants.nodes.map((v) => normSku(v.sku)).filter((s) => s));
    if (shSkus.size === 0) continue;
    const intersect = [...shSkus].filter((s) => dbSkus.has(s));
    if (intersect.length === shSkus.size && shSkus.size === dbSkus.size) variantSkuExactMatch++;
    else if (intersect.length > 0) variantSkuPartialMatch++;
    else variantSkuMismatch++;
  }

  const summary = {
    timestamp: new Date().toISOString(),
    shopify: {
      products_total: shopify.length,
      products_active: shopifyByStatus.ACTIVE,
      products_draft: shopifyByStatus.DRAFT,
      products_archived: shopifyByStatus.ARCHIVED,
      variants_total: shopifyVariantTotal,
      variants_with_sku: shopifyVariantWithSku,
      unique_skus_all_statuses: shopifyAllSkus.size,
      unique_skus_active: shopifyActiveSkus.size,
      unique_skus_non_archived: shopifyNonArchivedSkus.size,
      duplicate_sku_groups: shopifyDuplicateSkuGroups.length,
    },
    database: {
      warehouse_products_total: db.products.length,
      warehouse_products_with_shopify_id: dbShopifyRefs.length,
      warehouse_products_without_shopify_id: db.products.length - dbShopifyRefs.length,
      warehouse_products_distro_org_null:
        db.products.filter((p) => p.org_id === null).length,
      warehouse_product_variants_total: db.variants.length,
      warehouse_product_variants_with_sku: dbVariantsWithSku,
      unique_skus: dbAllSkus.size,
      duplicate_sku_groups: dbDuplicateSkuGroups.length,
      unique_shopify_ids_referenced: uniqueDbReferencedShopifyIds.size,
      duplicate_link_groups: dbDuplicateLinkGroups.length,
      extra_duplicate_rows_sharing_shopify_id: dbExtraDuplicateRows,
    },
    linkage: {
      db_refs_resolving_to_existing_shopify: dbRefsHittingShopify.length,
      db_refs_pointing_to_missing_shopify: dbRefsMissingFromShopify.length,
      shopify_products_with_no_db_link: shopifyIdsWithoutDbRef.length,
      status_aligned: statusAligned,
      status_mismatch: statusMismatch,
      status_mismatch_samples: statusMismatchSamples,
      title_aligned: titleAligned,
      title_mismatch: titleMismatch,
      title_mismatch_samples: titleMismatchSamples.slice(0, 5),
      variant_sku_exact_match_products: variantSkuExactMatch,
      variant_sku_partial_match_products: variantSkuPartialMatch,
      variant_sku_mismatch_products: variantSkuMismatch,
    },
    sku_coverage: {
      sku_in_both: skuInBoth,
      sku_only_in_shopify: skuOnlyInShopify.length,
      sku_only_in_db: skuOnlyInDb.length,
      shopify_active_skus_in_db: skuActiveInBoth,
      shopify_non_archived_skus_in_db: skuNonArchivedInBoth,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  // Detail CSVs
  const detailDir = reportDir;
  const writeCsv = (name: string, header: string[], rows: string[][]) => {
    const path = join(detailDir, `${name}-${ts}.csv`);
    const lines = [header.join(",")];
    for (const r of rows) lines.push(r.map(csvCell).join(","));
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  };

  // 1. db_refs_pointing_to_missing_shopify
  const missingRows: string[][] = dbRefsMissingFromShopify.map((id) => {
    const dbRows = refToDbRows.get(id) ?? [];
    const dbRow = dbRows[0];
    const v = dbVariantsByProduct.get(dbRow?.id ?? "")?.[0];
    return [
      id,
      dbRow?.id ?? "",
      dbRow?.title ?? "",
      dbRow?.vendor ?? "",
      dbRow?.org_id ?? "",
      v?.sku ?? "",
      String(dbRows.length),
    ];
  });
  const missingPath = writeCsv(
    "db-refs-missing-from-shopify",
    [
      "shopify_product_id",
      "warehouse_product_id",
      "title",
      "vendor",
      "org_id",
      "sample_sku",
      "db_rows_sharing_this_id",
    ],
    missingRows,
  );

  // 2. shopify_no_db_link
  const noLinkRows: string[][] = shopifyIdsWithoutDbRef.map((id) => {
    const sp = shopifyById.get(id);
    return [
      id,
      sp?.title ?? "",
      sp?.vendor ?? "",
      sp?.status ?? "",
      sp?.productType ?? "",
      sp?.createdAt ?? "",
      String(sp?.variants.nodes.length ?? 0),
      sp?.variants.nodes.map((v) => v.sku ?? "").join("|") ?? "",
    ];
  });
  const noLinkPath = writeCsv(
    "shopify-products-without-db-link",
    [
      "shopify_product_id",
      "title",
      "vendor",
      "status",
      "product_type",
      "created_at",
      "variant_count",
      "variant_skus",
    ],
    noLinkRows,
  );

  // 3. db_duplicate_link_groups
  const dupLinkRows: string[][] = [];
  for (const [shopifyId, rows] of dbDuplicateLinkGroups) {
    const sp = shopifyById.get(shopifyId);
    for (const r of rows) {
      const v = dbVariantsByProduct.get(r.id)?.[0];
      dupLinkRows.push([
        shopifyId,
        sp?.title ?? "(missing in shopify)",
        sp?.status ?? "",
        r.id,
        r.title ?? "",
        r.vendor ?? "",
        r.org_id ?? "",
        r.created_at,
        v?.sku ?? "",
        String(rows.length),
      ]);
    }
  }
  const dupLinkPath = writeCsv(
    "db-duplicate-shopify-link-groups",
    [
      "shopify_product_id",
      "shopify_title",
      "shopify_status",
      "warehouse_product_id",
      "db_title",
      "db_vendor",
      "org_id",
      "db_created_at",
      "sample_sku",
      "group_size",
    ],
    dupLinkRows,
  );

  console.log(`[reports]
  ${missingPath}
  ${noLinkPath}
  ${dupLinkPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
