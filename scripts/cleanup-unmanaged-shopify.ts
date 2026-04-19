import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productArchive, shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

config({ path: ".env.local" });

type Args = {
  execute: boolean;
  limit: number;
  keepLatestPerFingerprint: number;
  statusFilter: "draft" | "all";
  concurrency: number;
};

type ShopifyNode = {
  id: string;
  title: string;
  vendor: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  createdAt: string;
  variants: {
    nodes: Array<{
      id: string;
      sku: string | null;
    }>;
  };
};

type CandidateRow = {
  shopify_product_gid: string;
  shopify_product_id: string;
  status: string;
  title: string;
  vendor: string;
  created_at: string;
  fingerprint: string;
  action: "keep_latest" | "would_archive" | "archived" | "archive_error";
  error: string | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let execute = false;
  let limit = 500;
  let keepLatestPerFingerprint = 1;
  let statusFilter: "draft" | "all" = "draft";
  let concurrency = 5;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") execute = true;
    if (arg.startsWith("--limit=")) limit = Number.parseInt(arg.slice("--limit=".length), 10);
    if (arg.startsWith("--keep-latest=")) {
      keepLatestPerFingerprint = Number.parseInt(arg.slice("--keep-latest=".length), 10);
    }
    if (arg.startsWith("--status=")) {
      const status = arg.slice("--status=".length);
      if (status === "draft" || status === "all") statusFilter = status;
    }
    if (arg.startsWith("--concurrency=")) {
      concurrency = Number.parseInt(arg.slice("--concurrency=".length), 10);
    }
  }

  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  if (!Number.isFinite(keepLatestPerFingerprint) || keepLatestPerFingerprint < 0) {
    keepLatestPerFingerprint = 1;
  }
  if (!Number.isFinite(concurrency) || concurrency <= 0) concurrency = 5;

  return {
    execute,
    limit,
    keepLatestPerFingerprint,
    statusFilter,
    concurrency,
  };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeSku(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9-_]/g, "");
}

function toNumericProductId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

function fingerprintFor(node: ShopifyNode): string {
  const vendor = normalizeText(node.vendor);
  const title = normalizeText(node.title);
  const skuSet = new Set(
    node.variants.nodes
      .map((variant) => normalizeSku(variant.sku))
      .filter((sku) => sku.length > 0),
  );
  const skuPart = Array.from(skuSet).sort().join("|");
  return `${vendor}||${title}||${skuPart || "no_sku"}`;
}

async function fetchAllManagedShopifyIds(): Promise<Set<string>> {
  const supabase = createServiceRoleClient();
  const out = new Set<string>();
  let from = 0;
  const page = 500;
  while (true) {
    const { data, error } = await supabase
      .from("warehouse_products")
      .select("shopify_product_id")
      .not("shopify_product_id", "is", null)
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const raw = String(row.shopify_product_id ?? "").trim();
      if (!raw) continue;
      out.add(raw.includes("/") ? raw.split("/").pop() ?? raw : raw);
    }
    if (data.length < page) break;
    from += page;
  }
  return out;
}

async function fetchAllShopifyProducts(statusFilter: "draft" | "all"): Promise<ShopifyNode[]> {
  const queryFilter = statusFilter === "draft" ? "status:draft" : undefined;
  const products: ShopifyNode[] = [];
  let after: string | null = null;

  while (true) {
    const response: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyNode[];
      };
    } = await shopifyGraphQL(
      `query Products($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            vendor
            status
            createdAt
            variants(first: 10) {
              nodes { id sku }
            }
          }
        }
      }`,
      { first: 250, after, query: queryFilter },
    );

    products.push(...response.products.nodes);
    if (!response.products.pageInfo.hasNextPage) break;
    after = response.products.pageInfo.endCursor;
  }

  return products;
}

function toCsv(rows: CandidateRow[]): string {
  const header = [
    "shopify_product_gid",
    "shopify_product_id",
    "status",
    "title",
    "vendor",
    "created_at",
    "fingerprint",
    "action",
    "error",
  ];
  const lines = [header];
  for (const row of rows) {
    lines.push([
      row.shopify_product_gid,
      row.shopify_product_id,
      row.status,
      row.title,
      row.vendor,
      row.created_at,
      row.fingerprint,
      row.action,
      row.error ?? "",
    ]);
  }
  return lines
    .map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

async function main() {
  const args = parseArgs();
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });
  const csvPath = join(reportDir, `shopify-unmanaged-cleanup-${ts}.csv`);

  console.log(
    `[start] unmanaged Shopify cleanup mode=${args.execute ? "EXECUTE" : "DRY_RUN"} status=${args.statusFilter} limit=${args.limit} keep_latest=${args.keepLatestPerFingerprint} concurrency=${args.concurrency}`,
  );

  const managedIds = await fetchAllManagedShopifyIds();
  const products = await fetchAllShopifyProducts(args.statusFilter);
  const unmanaged = products.filter((product) => !managedIds.has(toNumericProductId(product.id)));

  const grouped = new Map<string, ShopifyNode[]>();
  for (const product of unmanaged) {
    const key = fingerprintFor(product);
    const existing = grouped.get(key) ?? [];
    existing.push(product);
    grouped.set(key, existing);
  }

  const rows: CandidateRow[] = [];
  const archiveQueue: CandidateRow[] = [];

  for (const [fingerprint, bucket] of grouped.entries()) {
    const ordered = [...bucket].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (let i = 0; i < ordered.length; i += 1) {
      const product = ordered[i];
      const base: CandidateRow = {
        shopify_product_gid: product.id,
        shopify_product_id: toNumericProductId(product.id),
        status: product.status,
        title: product.title,
        vendor: product.vendor ?? "",
        created_at: product.createdAt,
        fingerprint,
        action: i < args.keepLatestPerFingerprint ? "keep_latest" : "would_archive",
        error: null,
      };
      rows.push(base);
      if (base.action === "would_archive") {
        archiveQueue.push(base);
      }
    }
  }

  const candidates = archiveQueue.slice(0, args.limit);
  console.log(
    `[plan] total_products=${products.length} unmanaged=${unmanaged.length} groups=${grouped.size} candidates=${archiveQueue.length} executing=${candidates.length}`,
  );

  if (args.execute) {
    let idx = 0;
    const workers = Array.from({ length: args.concurrency }).map(async () => {
      while (idx < candidates.length) {
        const current = idx;
        idx += 1;
        const row = candidates[current];
        if (!row) continue;
        try {
          await productArchive(row.shopify_product_gid);
          row.action = "archived";
        } catch (error) {
          row.action = "archive_error";
          row.error = error instanceof Error ? error.message : String(error);
        }
      }
    });
    await Promise.all(workers);
  }

  writeFileSync(csvPath, `${toCsv(rows)}\n`, "utf8");
  console.log(`[done] report=${csvPath}`);
  const archived = rows.filter((row) => row.action === "archived").length;
  const errors = rows.filter((row) => row.action === "archive_error").length;
  console.log(`[summary] archived=${archived} errors=${errors} candidates=${archiveQueue.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
