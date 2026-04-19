import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productDelete, shopifyGraphQL } from "@/lib/clients/shopify-client";

config({ path: ".env.local" });

type Args = {
  execute: boolean;
  limit: number;
  concurrency: number;
};

type ShopifyVariant = {
  id: string;
  sku: string | null;
};

type ShopifyProduct = {
  id: string;
  title: string;
  vendor: string | null;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  createdAt: string;
  variants: { nodes: ShopifyVariant[] };
};

type Row = {
  shopify_product_gid: string;
  shopify_product_id: string;
  status: string;
  title: string;
  vendor: string;
  created_at: string;
  matching_skus: string;
  matched_against: string;
  action: "would_delete" | "deleted" | "delete_error" | "no_twin_kept";
  error: string | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let execute = false;
  let limit = 0;
  let concurrency = 4;
  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    if (arg.startsWith("--limit=")) {
      const v = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(v) && v > 0) limit = v;
    }
    if (arg.startsWith("--concurrency=")) {
      const v = Number.parseInt(arg.slice("--concurrency=".length), 10);
      if (Number.isFinite(v) && v > 0) concurrency = v;
    }
  }
  return { execute, limit, concurrency };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeSku(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9\-_./]/g, "");
}

function toNumericId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

function fingerprintsFor(product: ShopifyProduct): string[] {
  const title = normalizeText(product.title);
  const out: string[] = [];
  for (const v of product.variants.nodes) {
    const sku = normalizeSku(v.sku);
    if (!sku) continue;
    out.push(`${title}||${sku}`);
  }
  return out;
}

async function fetchAll(statusFilter: "draft" | "active" | "archived"): Promise<ShopifyProduct[]> {
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
            id title vendor status createdAt
            variants(first: 50) { nodes { id sku } }
          }
        }
      }`,
      { first: 200, after, query: `status:${statusFilter}` },
    );
    out.push(...data.products.nodes);
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
    process.stdout.write(`  ${statusFilter} fetched ${out.length}\r`);
  }
  process.stdout.write(`\n`);
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `"${String(v).replaceAll('"', '""').replaceAll(/\r?\n/g, " ")}"`;
}

async function main() {
  const args = parseArgs();
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });
  const csvPath = join(reportDir, `shopify-archived-twin-dedupe-${ts}.csv`);

  console.log(
    `[start] dedupe archived Shopify twins mode=${args.execute ? "EXECUTE" : "DRY_RUN"} limit=${args.limit || "all"} concurrency=${args.concurrency}`,
  );

  console.log("[fetch] active …");
  const active = await fetchAll("active");
  console.log("[fetch] draft …");
  const draft = await fetchAll("draft");
  console.log("[fetch] archived …");
  const archived = await fetchAll("archived");
  console.log(`[loaded] active=${active.length} draft=${draft.length} archived=${archived.length}`);

  const liveIndex = new Map<string, ShopifyProduct>();
  for (const p of [...active, ...draft]) {
    for (const fp of fingerprintsFor(p)) {
      if (!liveIndex.has(fp)) liveIndex.set(fp, p);
    }
  }
  console.log(`[index] live (active+draft) fingerprints=${liveIndex.size}`);

  const rows: Row[] = [];
  const queue: Row[] = [];
  for (const p of archived) {
    const fps = fingerprintsFor(p);
    const matched: { fp: string; twin: ShopifyProduct }[] = [];
    for (const fp of fps) {
      const twin = liveIndex.get(fp);
      if (twin) matched.push({ fp, twin });
    }
    if (matched.length === 0) {
      rows.push({
        shopify_product_gid: p.id,
        shopify_product_id: toNumericId(p.id),
        status: p.status,
        title: p.title,
        vendor: p.vendor ?? "",
        created_at: p.createdAt,
        matching_skus: "",
        matched_against: "",
        action: "no_twin_kept",
        error: null,
      });
      continue;
    }
    const matchingSkus = matched.map((m) => m.fp.split("||")[1]).filter(Boolean);
    const matchedAgainst = matched
      .map((m) => `${toNumericId(m.twin.id)}:${m.twin.status}`)
      .join("|");
    const row: Row = {
      shopify_product_gid: p.id,
      shopify_product_id: toNumericId(p.id),
      status: p.status,
      title: p.title,
      vendor: p.vendor ?? "",
      created_at: p.createdAt,
      matching_skus: matchingSkus.join("|"),
      matched_against: matchedAgainst,
      action: "would_delete",
      error: null,
    };
    rows.push(row);
    queue.push(row);
  }

  const targets = args.limit > 0 ? queue.slice(0, args.limit) : queue;
  console.log(
    `[plan] archived_total=${archived.length} delete_candidates=${queue.length} executing=${targets.length} keeping_unique=${rows.filter((r) => r.action === "no_twin_kept").length}`,
  );

  if (args.execute) {
    let idx = 0;
    const workers = Array.from({ length: args.concurrency }).map(async () => {
      while (idx < targets.length) {
        const cur = idx;
        idx += 1;
        const row = targets[cur];
        if (!row) continue;
        try {
          await productDelete(row.shopify_product_gid);
          row.action = "deleted";
        } catch (err) {
          row.action = "delete_error";
          row.error = err instanceof Error ? err.message : String(err);
        }
        if (cur > 0 && cur % 100 === 0) {
          process.stdout.write(`  deleted ${cur}/${targets.length}\r`);
        }
      }
    });
    await Promise.all(workers);
    process.stdout.write("\n");
  }

  const header = [
    "shopify_product_gid",
    "shopify_product_id",
    "status",
    "title",
    "vendor",
    "created_at",
    "matching_skus",
    "matched_against",
    "action",
    "error",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.shopify_product_gid),
        csvCell(r.shopify_product_id),
        csvCell(r.status),
        csvCell(r.title),
        csvCell(r.vendor),
        csvCell(r.created_at),
        csvCell(r.matching_skus),
        csvCell(r.matched_against),
        csvCell(r.action),
        csvCell(r.error ?? ""),
      ].join(","),
    );
  }
  writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
  const summary = {
    archived_total: archived.length,
    archived_with_twin: queue.length,
    archived_no_twin_kept: rows.filter((r) => r.action === "no_twin_kept").length,
    deleted: rows.filter((r) => r.action === "deleted").length,
    delete_errors: rows.filter((r) => r.action === "delete_error").length,
    would_delete_remaining: rows.filter((r) => r.action === "would_delete").length,
  };
  console.log(`[done] report=${csvPath}`);
  console.log(`[summary] ${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
