import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productArchive } from "../src/lib/clients/shopify-client";
import { createServiceRoleClient } from "../src/lib/server/supabase-server";

config({ path: ".env.local" });

type ProductRow = {
  id: string;
  shopify_product_id: string | null;
  vendor: string | null;
  title: string;
  created_at: string;
  status: string;
};

type Args = {
  execute: boolean;
  vendor: string | null;
  since: string | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let execute = false;
  let vendor: string | null = null;
  let since: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--vendor") {
      vendor = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--since") {
      since = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return { execute, vendor, since };
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts [--execute] [--vendor <name>] [--since <ISO-date>]",
      "",
      "Examples:",
      "  npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts",
      "  npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts --execute --vendor \"Northern Spy Records\"",
      "  npx tsx scripts/cleanup-bandcamp-orphan-shopify.ts --execute --since 2026-04-13",
    ].join("\n"),
  );
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toCsv(rows: string[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\n");
}

async function loadDraftProducts(args: Args): Promise<ProductRow[]> {
  const supabase = createServiceRoleClient();
  const out: ProductRow[] = [];
  const pageSize = 500;
  let offset = 0;

  while (true) {
    let query = supabase
      .from("warehouse_products")
      .select("id,shopify_product_id,vendor,title,created_at,status")
      .eq("status", "draft")
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (args.vendor) query = query.eq("vendor", args.vendor);
    if (args.since) query = query.gte("created_at", args.since);

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    out.push(...(data as ProductRow[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return out;
}

async function filterOrphans(rows: ProductRow[]): Promise<ProductRow[]> {
  if (rows.length === 0) return [];
  const supabase = createServiceRoleClient();
  const pageSize = 200;
  const productIds = rows.map((r) => r.id);
  const hasVariant = new Set<string>();

  for (let i = 0; i < productIds.length; i += pageSize) {
    const chunk = productIds.slice(i, i + pageSize);
    const { data, error } = await supabase
      .from("warehouse_product_variants")
      .select("product_id")
      .in("product_id", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.product_id) hasVariant.add(row.product_id);
    }
  }

  return rows.filter((r) => !hasVariant.has(r.id));
}

async function main() {
  const args = parseArgs();
  const ts = new Date().toISOString().replaceAll(":", "-");
  const reportDir = join(process.cwd(), "reports", "finish-line");
  mkdirSync(reportDir, { recursive: true });
  const csvPath = join(reportDir, `bandcamp-orphan-cleanup-${ts}.csv`);

  // eslint-disable-next-line no-console
  console.log(
    `Starting orphan cleanup (${args.execute ? "EXECUTE" : "DRY RUN"}) vendor=${args.vendor ?? "ALL"} since=${args.since ?? "ANY"}`,
  );

  const draftRows = await loadDraftProducts(args);
  const orphans = await filterOrphans(draftRows);
  // eslint-disable-next-line no-console
  console.log(`Loaded ${draftRows.length} draft rows; identified ${orphans.length} orphan rows.`);

  const supabase = createServiceRoleClient();
  let archived = 0;
  let skipped = 0;
  let errors = 0;

  const csvRows: string[][] = [
    ["warehouse_product_id", "shopify_product_id", "vendor", "title", "created_at", "action", "error"],
  ];

  for (const row of orphans) {
    const shopifyId = row.shopify_product_id?.trim() || null;
    if (!shopifyId) {
      skipped++;
      csvRows.push([row.id, "", row.vendor ?? "", row.title, row.created_at, "skipped_no_shopify_id", ""]);
      continue;
    }

    if (!args.execute) {
      skipped++;
      csvRows.push([row.id, shopifyId, row.vendor ?? "", row.title, row.created_at, "would_archive", ""]);
      continue;
    }

    try {
      await productArchive(shopifyId);
      const { error: deleteError } = await supabase
        .from("warehouse_products")
        .delete()
        .eq("id", row.id);
      if (deleteError) throw deleteError;

      archived++;
      csvRows.push([row.id, shopifyId, row.vendor ?? "", row.title, row.created_at, "archived", ""]);
    } catch (error) {
      errors++;
      csvRows.push([
        row.id,
        shopifyId,
        row.vendor ?? "",
        row.title,
        row.created_at,
        "error",
        String(error),
      ]);
    }

    // Stay under Shopify mutation limits.
    await sleep(350);
  }

  writeFileSync(csvPath, `${toCsv(csvRows)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Report written: ${csvPath}`);
  // eslint-disable-next-line no-console
  console.log(`Summary: archived=${archived} skipped=${skipped} errors=${errors}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
