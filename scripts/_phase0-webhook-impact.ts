/**
 * Phase 0 follow-up: map recent Shopify inventory webhooks to SKUs and compare
 * webhook values/current Shopify values against DB truth.
 *
 * Read-only. No side effects.
 *
 * Usage:
 *   npx tsx scripts/_phase0-webhook-impact.ts
 *   npx tsx scripts/_phase0-webhook-impact.ts --hours=72 --limit=800
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import { fetchInventoryLevels, shopifyGraphQL } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CliArgs {
  hours: number;
  limit: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { hours: 48, limit: 500 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--hours=")) {
      out.hours = Math.max(1, Number.parseInt(arg.slice("--hours=".length), 10) || out.hours);
    } else if (arg.startsWith("--limit=")) {
      out.limit = Math.max(1, Number.parseInt(arg.slice("--limit=".length), 10) || out.limit);
    }
  }
  return out;
}

interface WebhookRow {
  created_at: string;
  external_webhook_id: string;
  status: string | null;
  metadata: unknown;
}

interface ParsedWebhook {
  created_at: string;
  external_webhook_id: string;
  status: string | null;
  inventory_item_id: string;
  webhook_available: number | null;
  payload_updated_at: string | null;
}

interface DbLevel {
  sku: string;
  available: number;
  committed: number;
}

const SHOPIFY_NODES_CHUNK = 100;
const SHOPIFY_LEVELS_CHUNK = 250;

function parseWebhook(row: WebhookRow): ParsedWebhook | null {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const payload = (metadata.payload ?? {}) as Record<string, unknown>;
  const inventoryItemId = payload.inventory_item_id;
  if (inventoryItemId === undefined || inventoryItemId === null) return null;

  return {
    created_at: row.created_at,
    external_webhook_id: row.external_webhook_id,
    status: row.status,
    inventory_item_id: String(inventoryItemId),
    webhook_available:
      payload.available === undefined || payload.available === null
        ? null
        : Number(payload.available),
    payload_updated_at:
      payload.updated_at === undefined || payload.updated_at === null
        ? null
        : String(payload.updated_at),
  };
}

async function resolveSkusForInventoryItems(
  inventoryItemIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < inventoryItemIds.length; i += SHOPIFY_NODES_CHUNK) {
    const chunk = inventoryItemIds.slice(i, i + SHOPIFY_NODES_CHUNK);
    const ids = chunk.map((id) => `gid://shopify/InventoryItem/${id}`);
    const data = await shopifyGraphQL<{
      nodes: Array<{
        id: string;
        sku?: string | null;
        variant?: { sku?: string | null } | null;
      } | null>;
    }>(
      `query Phase0InventoryItemSku($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on InventoryItem {
            id
            sku
            variant { sku }
          }
        }
      }`,
      { ids },
    );

    for (const node of data.nodes) {
      if (!node?.id) continue;
      const shortId = node.id.split("/").pop() ?? node.id;
      const sku = node.variant?.sku ?? node.sku ?? null;
      out.set(shortId, sku);
    }
    // Ensure all requested ids have an entry for easier joins.
    for (const requested of chunk) {
      if (!out.has(requested)) out.set(requested, null);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createServiceRoleClient();
  const since = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();

  console.log(`\n=== Pulling recent shopify inventory webhooks (last ${args.hours}h) ===`);
  const { data, error } = await sb
    .from("webhook_events")
    .select("created_at, external_webhook_id, status, metadata")
    .eq("platform", "shopify")
    .eq("topic", "inventory_levels/update")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (error) throw new Error(`webhook_events query failed: ${error.message}`);

  const parsed = ((data ?? []) as WebhookRow[]).map(parseWebhook).filter(Boolean) as ParsedWebhook[];
  console.log(`loaded ${parsed.length} inventory webhook rows`);

  const uniqueInventoryItemIds = [...new Set(parsed.map((r) => r.inventory_item_id))];
  console.log(`unique inventory_item_id values: ${uniqueInventoryItemIds.length}`);

  console.log("\n=== Resolving inventory_item_id -> SKU from Shopify ===");
  const skuByInventoryItemId = await resolveSkusForInventoryItems(uniqueInventoryItemIds);
  const uniqueSkus = [...new Set([...skuByInventoryItemId.values()].filter(Boolean) as string[])];
  console.log(`resolved SKU for ${uniqueSkus.length}/${uniqueInventoryItemIds.length} inventory items`);

  console.log("\n=== Loading DB inventory levels for resolved SKUs ===");
  const dbBySku = new Map<string, DbLevel>();
  if (uniqueSkus.length > 0) {
    const { data: dbRows, error: dbErr } = await sb
      .from("warehouse_inventory_levels")
      .select("sku, available, committed")
      .in("sku", uniqueSkus);
    if (dbErr) throw new Error(`warehouse_inventory_levels query failed: ${dbErr.message}`);
    for (const row of (dbRows ?? []) as DbLevel[]) dbBySku.set(row.sku, row);
  }

  console.log("\n=== Loading current Shopify available for inventory items ===");
  const gqlIds = uniqueInventoryItemIds.map((id) => `gid://shopify/InventoryItem/${id}`);
  const currentLevels = [] as Awaited<ReturnType<typeof fetchInventoryLevels>>;
  for (let i = 0; i < gqlIds.length; i += SHOPIFY_LEVELS_CHUNK) {
    const chunk = gqlIds.slice(i, i + SHOPIFY_LEVELS_CHUNK);
    const levels = await fetchInventoryLevels(chunk);
    currentLevels.push(...levels);
  }
  const currentByInventoryItemId = new Map<string, number>();
  for (const level of currentLevels) {
    const shortId = level.inventoryItemId.split("/").pop() ?? level.inventoryItemId;
    currentByInventoryItemId.set(shortId, level.available);
  }

  const rows = parsed.map((r) => {
    const sku = skuByInventoryItemId.get(r.inventory_item_id) ?? null;
    const db = sku ? dbBySku.get(sku) : undefined;
    const currentShopifyAvailable = currentByInventoryItemId.get(r.inventory_item_id) ?? null;
    const webhookMinusDb =
      r.webhook_available !== null && db ? r.webhook_available - db.available : null;
    const currentMinusDb =
      currentShopifyAvailable !== null && db ? currentShopifyAvailable - db.available : null;
    const zeroRisk = r.webhook_available === 0 && !!db && db.available > 0;

    return {
      created_at: r.created_at,
      external_webhook_id: r.external_webhook_id,
      status: r.status ?? "",
      inventory_item_id: r.inventory_item_id,
      sku: sku ?? "",
      payload_updated_at: r.payload_updated_at ?? "",
      webhook_available: r.webhook_available,
      current_shopify_available: currentShopifyAvailable,
      db_available: db?.available ?? null,
      db_committed: db?.committed ?? null,
      webhook_minus_db: webhookMinusDb,
      current_minus_db: currentMinusDb,
      zero_risk: zeroRisk ? "YES" : "",
      unmapped_sku: sku ? "" : "YES",
      sku_missing_in_db: sku && !db ? "YES" : "",
    };
  });

  const zeroRiskRows = rows.filter((r) => r.zero_risk === "YES");
  const unmappedSkuRows = rows.filter((r) => r.unmapped_sku === "YES");
  const skuMissingInDbRows = rows.filter((r) => r.sku_missing_in_db === "YES");

  const statusCounts = new Map<string, number>();
  for (const row of rows) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);

  console.log("\n=== Headline ===");
  console.log(`rows analyzed: ${rows.length}`);
  console.log(`zero-risk rows (webhook=0 while db>0): ${zeroRiskRows.length}`);
  console.log(`rows with no SKU mapping from Shopify item ID: ${unmappedSkuRows.length}`);
  console.log(`rows with SKU present but missing in DB: ${skuMissingInDbRows.length}`);
  console.log("status breakdown:");
  for (const [status, count] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status || "(empty)"}: ${count}`);
  }

  if (zeroRiskRows.length > 0) {
    console.log("\n=== Top zero-risk examples ===");
    for (const row of zeroRiskRows.slice(0, 25)) {
      console.log(
        `${row.created_at}  sku=${row.sku}  webhook=${row.webhook_available}  currentShopify=${row.current_shopify_available}  db=${row.db_available}`,
      );
    }
  }

  await mkdir("reports", { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `reports/phase0-webhook-impact-${ts}.csv`;
  const header = [
    "created_at",
    "external_webhook_id",
    "status",
    "inventory_item_id",
    "sku",
    "payload_updated_at",
    "webhook_available",
    "current_shopify_available",
    "db_available",
    "db_committed",
    "webhook_minus_db",
    "current_minus_db",
    "zero_risk",
    "unmapped_sku",
    "sku_missing_in_db",
  ];
  const csv = [
    header.join(","),
    ...rows.map((row) =>
      header
        .map((key) => {
          const val = row[key as keyof typeof row];
          return `"${String(val ?? "").replaceAll('"', '""')}"`;
        })
        .join(","),
    ),
  ].join("\n");
  await writeFile(outPath, csv, "utf-8");
  console.log(`\nCSV written: ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
