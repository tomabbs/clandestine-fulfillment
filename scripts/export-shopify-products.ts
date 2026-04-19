import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type Args = {
  status: "active" | "draft" | "archived" | "all";
  limit: number | null;
};

type ShopifyVariant = {
  id: string;
  sku: string | null;
  title: string | null;
  price: string | null;
  compareAtPrice: string | null;
  barcode: string | null;
  inventoryQuantity: number | null;
  inventoryItem: {
    tracked: boolean;
    measurement: { weight: { value: number; unit: string } | null } | null;
    unitCost: { amount: string; currencyCode: string } | null;
  } | null;
};

type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  tags: string[];
  totalInventory: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  onlineStoreUrl: string | null;
  variants: { nodes: ShopifyVariant[] };
  collections: { nodes: Array<{ title: string }> };
  featuredImage: { url: string } | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let status: Args["status"] = "all";
  let limit: number | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--status=")) {
      const value = arg.slice("--status=".length) as Args["status"];
      if (["active", "draft", "archived", "all"].includes(value)) status = value;
    }
    if (arg.startsWith("--limit=")) {
      const v = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(v) && v > 0) limit = v;
    }
  }
  return { status, limit };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return `"${s.replaceAll('"', '""').replaceAll(/\r?\n/g, " ")}"`;
}

function toNumericId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

async function fetchManagedMap(): Promise<
  Map<
    string,
    {
      warehouse_product_id: string;
      org_id: string | null;
      product_type: string | null;
      bandcamp_mapping_id: string | null;
    }
  >
> {
  const supabase = createServiceRoleClient();
  const out = new Map<
    string,
    {
      warehouse_product_id: string;
      org_id: string | null;
      product_type: string | null;
      bandcamp_mapping_id: string | null;
    }
  >();
  let from = 0;
  const page = 500;
  while (true) {
    const { data, error } = await supabase
      .from("warehouse_products")
      .select("id, shopify_product_id, org_id, product_type")
      .not("shopify_product_id", "is", null)
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const raw = String(row.shopify_product_id ?? "").trim();
      if (!raw) continue;
      const id = raw.includes("/") ? (raw.split("/").pop() ?? raw) : raw;
      out.set(id, {
        warehouse_product_id: row.id,
        org_id: row.org_id ?? null,
        product_type: row.product_type ?? null,
        bandcamp_mapping_id: null,
      });
    }
    if (data.length < page) break;
    from += page;
  }

  // hydrate bandcamp mapping presence by warehouse_product_id → variant_id → mapping
  const productIds = Array.from(out.values()).map((v) => v.warehouse_product_id);
  if (productIds.length > 0) {
    const variantToProduct = new Map<string, string>();
    for (let i = 0; i < productIds.length; i += 200) {
      const slice = productIds.slice(i, i + 200);
      const { data, error } = await supabase
        .from("warehouse_product_variants")
        .select("id, product_id")
        .in("product_id", slice);
      if (error) throw error;
      for (const v of data ?? []) {
        variantToProduct.set(v.id, v.product_id);
      }
    }
    const variantIds = Array.from(variantToProduct.keys());
    for (let i = 0; i < variantIds.length; i += 200) {
      const slice = variantIds.slice(i, i + 200);
      const { data, error } = await supabase
        .from("bandcamp_product_mappings")
        .select("id, variant_id")
        .in("variant_id", slice);
      if (error) throw error;
      for (const m of data ?? []) {
        const productId = variantToProduct.get(m.variant_id);
        if (!productId) continue;
        for (const [shopifyId, info] of out.entries()) {
          if (info.warehouse_product_id === productId) {
            info.bandcamp_mapping_id = m.id;
            out.set(shopifyId, info);
          }
        }
      }
    }
  }

  return out;
}

async function fetchAll(status: Args["status"], limit: number | null): Promise<ShopifyProduct[]> {
  const queryFilter = status === "all" ? undefined : `status:${status}`;
  const out: ShopifyProduct[] = [];
  let after: string | null = null;
  while (true) {
    const data: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyProduct[];
      };
    } = await shopifyGraphQL(
      `query Products($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title handle vendor productType status tags totalInventory
            createdAt updatedAt publishedAt onlineStoreUrl
            featuredImage { url }
            collections(first: 25) { nodes { title } }
            variants(first: 50) {
              nodes {
                id sku title price compareAtPrice barcode inventoryQuantity
                inventoryItem {
                  tracked
                  measurement { weight { value unit } }
                  unitCost { amount currencyCode }
                }
              }
            }
          }
        }
      }`,
      { first: 100, after, query: queryFilter },
    );
    out.push(...data.products.nodes);
    if (limit && out.length >= limit) {
      return out.slice(0, limit);
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
    process.stdout.write(`  fetched ${out.length}\r`);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });

  console.log(`[start] export Shopify products status=${args.status} limit=${args.limit ?? "all"}`);
  const [products, managed] = await Promise.all([
    fetchAll(args.status, args.limit),
    fetchManagedMap(),
  ]);
  console.log(`\n[fetched] products=${products.length} managed_in_db=${managed.size}`);

  const productHeader = [
    "shopify_product_id",
    "shopify_product_gid",
    "title",
    "handle",
    "vendor",
    "product_type",
    "status",
    "tags",
    "collections",
    "total_inventory",
    "variant_count",
    "created_at",
    "updated_at",
    "published_at",
    "online_store_url",
    "featured_image_url",
    "managed_in_db",
    "warehouse_product_id",
    "org_id",
    "db_product_type",
    "bandcamp_mapping_id",
  ];
  const variantHeader = [
    "shopify_product_id",
    "shopify_product_gid",
    "product_title",
    "product_status",
    "vendor",
    "product_type",
    "shopify_variant_id",
    "variant_title",
    "sku",
    "barcode",
    "price",
    "compare_at_price",
    "inventory_tracked",
    "inventory_quantity",
    "weight_value",
    "weight_unit",
    "unit_cost",
    "unit_cost_currency",
    "managed_in_db",
    "warehouse_product_id",
    "org_id",
    "bandcamp_mapping_id",
  ];

  const productLines: string[] = [productHeader.join(",")];
  const variantLines: string[] = [variantHeader.join(",")];

  for (const p of products) {
    const numericId = toNumericId(p.id);
    const info = managed.get(numericId);
    const isManaged = Boolean(info);
    productLines.push(
      [
        csvCell(numericId),
        csvCell(p.id),
        csvCell(p.title),
        csvCell(p.handle),
        csvCell(p.vendor ?? ""),
        csvCell(p.productType ?? ""),
        csvCell(p.status),
        csvCell((p.tags ?? []).join("|")),
        csvCell((p.collections?.nodes ?? []).map((c) => c.title).join("|")),
        csvCell(p.totalInventory ?? ""),
        csvCell(p.variants?.nodes?.length ?? 0),
        csvCell(p.createdAt),
        csvCell(p.updatedAt),
        csvCell(p.publishedAt ?? ""),
        csvCell(p.onlineStoreUrl ?? ""),
        csvCell(p.featuredImage?.url ?? ""),
        csvCell(isManaged ? "yes" : "no"),
        csvCell(info?.warehouse_product_id ?? ""),
        csvCell(info?.org_id ?? ""),
        csvCell(info?.product_type ?? ""),
        csvCell(info?.bandcamp_mapping_id ?? ""),
      ].join(","),
    );

    for (const v of p.variants?.nodes ?? []) {
      variantLines.push(
        [
          csvCell(numericId),
          csvCell(p.id),
          csvCell(p.title),
          csvCell(p.status),
          csvCell(p.vendor ?? ""),
          csvCell(p.productType ?? ""),
          csvCell(toNumericId(v.id)),
          csvCell(v.title ?? ""),
          csvCell(v.sku ?? ""),
          csvCell(v.barcode ?? ""),
          csvCell(v.price ?? ""),
          csvCell(v.compareAtPrice ?? ""),
          csvCell(v.inventoryItem?.tracked ?? ""),
          csvCell(v.inventoryQuantity ?? ""),
          csvCell(v.inventoryItem?.measurement?.weight?.value ?? ""),
          csvCell(v.inventoryItem?.measurement?.weight?.unit ?? ""),
          csvCell(v.inventoryItem?.unitCost?.amount ?? ""),
          csvCell(v.inventoryItem?.unitCost?.currencyCode ?? ""),
          csvCell(isManaged ? "yes" : "no"),
          csvCell(info?.warehouse_product_id ?? ""),
          csvCell(info?.org_id ?? ""),
          csvCell(info?.bandcamp_mapping_id ?? ""),
        ].join(","),
      );
    }
  }

  const productPath = join(reportDir, `shopify-products-${args.status}-${ts}.csv`);
  const variantPath = join(reportDir, `shopify-variants-${args.status}-${ts}.csv`);
  writeFileSync(productPath, `${productLines.join("\n")}\n`, "utf8");
  writeFileSync(variantPath, `${variantLines.join("\n")}\n`, "utf8");

  console.log(`[done] product_rows=${productLines.length - 1} -> ${productPath}`);
  console.log(`       variant_rows=${variantLines.length - 1} -> ${variantPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
