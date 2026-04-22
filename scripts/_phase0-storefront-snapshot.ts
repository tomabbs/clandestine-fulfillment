/**
 * Phase 0 — read-only multi-surface inventory snapshot.
 *
 * Goal: confirm that activating ShipStation Inventory Sync (SS → storefronts)
 * has not silently zeroed or drifted Shopify / Squarespace / WooCommerce
 * inventory away from our DB truth.
 *
 * For each sampled SKU we read CURRENT values from:
 *   - DB     (warehouse_inventory_levels.available + committed)
 *   - SS v2  (GET /v2/inventory)
 *   - Clandestine Shopify (env-based admin API)
 *   - Each active client_store_connection (Shopify / Squarespace / WooCommerce)
 *   - last_pushed_quantity / last_pushed_at from client_store_sku_mappings
 *
 * Side effects: NONE. Pure read.
 *
 * Usage:
 *   pnpm tsx scripts/_phase0-storefront-snapshot.ts
 *   pnpm tsx scripts/_phase0-storefront-snapshot.ts --skus=SKU-A,SKU-B,SKU-C
 *   pnpm tsx scripts/_phase0-storefront-snapshot.ts --sample=50
 *   pnpm tsx scripts/_phase0-storefront-snapshot.ts --activated=2026-04-12T18:00:00Z
 *
 * Output: console table + reports/phase0-snapshot-{ISO}.csv
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdir, writeFile } from "node:fs/promises";
import { fetchInventoryLevels, shopifyGraphQL } from "@/lib/clients/shopify-client";
import { listInventory } from "@/lib/clients/shipstation-inventory-v2";
import { getInventory as squarespaceGetInventory } from "@/lib/clients/squarespace-client";
import { getProductBySku as wooGetProductBySku } from "@/lib/clients/woocommerce-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// ────────────────────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  skus: string[];
  sampleSize: number;
  activatedAt: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { skus: [], sampleSize: 30, activatedAt: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--skus=")) {
      out.skus = a
        .slice("--skus=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith("--sample=")) {
      out.sampleSize = Math.max(1, Number.parseInt(a.slice("--sample=".length), 10) || 30);
    } else if (a.startsWith("--activated=")) {
      out.activatedAt = a.slice("--activated=".length);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface DbLevel {
  variant_id: string;
  workspace_id: string;
  org_id: string | null;
  sku: string;
  available: number;
  committed: number;
  last_redis_write_at: string | null;
}

interface ConnRow {
  id: string;
  workspace_id: string;
  org_id: string;
  platform: "shopify" | "squarespace" | "woocommerce" | "bigcommerce";
  store_url: string;
  api_key: string | null;
  api_secret: string | null;
  connection_status: string;
  do_not_fanout: boolean | null;
}

interface MappingRow {
  connection_id: string;
  variant_id: string;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_sku: string | null;
  last_pushed_quantity: number | null;
  last_pushed_at: string | null;
}

interface SnapshotRow {
  sku: string;
  workspace_id: string;
  variant_id: string;
  db_available: number;
  db_committed: number;
  db_last_activity: string | null;
  ss_v2_available: number | null;
  ss_v2_on_hand: number | null;
  clandestine_shopify_available: number | null;
  // per-connection columns flattened — { [connId]: { remote, lastPushedQty, lastPushedAt, error } }
  remote_per_conn: Map<
    string,
    {
      remote_available: number | null;
      last_pushed_quantity: number | null;
      last_pushed_at: string | null;
      error?: string;
    }
  >;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}
function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function yellow(s: string) {
  return `\x1b[33m${s}\x1b[0m`;
}
function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

// ────────────────────────────────────────────────────────────────────────────
// Sampling
// ────────────────────────────────────────────────────────────────────────────

async function pickSampleSkus(
  sb: ReturnType<typeof createServiceRoleClient>,
  size: number,
  forced: string[],
): Promise<DbLevel[]> {
  // Strategy: forced + top-N by available DESC + N most-recently-touched + a few zero-stock SKUs
  // dedup by sku.
  const byAvailable = await sb
    .from("warehouse_inventory_levels")
    .select("variant_id, workspace_id, org_id, sku, available, committed, last_redis_write_at")
    .gt("available", 0)
    .order("available", { ascending: false })
    .limit(Math.ceil(size * 0.6));

  const byRecent = await sb
    .from("warehouse_inventory_levels")
    .select("variant_id, workspace_id, org_id, sku, available, committed, last_redis_write_at")
    .not("last_redis_write_at", "is", null)
    .order("last_redis_write_at", { ascending: false })
    .limit(Math.ceil(size * 0.3));

  const zeroStock = await sb
    .from("warehouse_inventory_levels")
    .select("variant_id, workspace_id, org_id, sku, available, committed, last_redis_write_at")
    .eq("available", 0)
    .order("sku", { ascending: true })
    .limit(Math.ceil(size * 0.1));

  const forcedRows = forced.length
    ? await sb
        .from("warehouse_inventory_levels")
        .select("variant_id, workspace_id, org_id, sku, available, committed, last_redis_write_at")
        .in("sku", forced)
    : { data: [] as DbLevel[] };

  const all = [
    ...((forcedRows.data as DbLevel[] | null) ?? []),
    ...((byAvailable.data as DbLevel[] | null) ?? []),
    ...((byRecent.data as DbLevel[] | null) ?? []),
    ...((zeroStock.data as DbLevel[] | null) ?? []),
  ];

  const seen = new Set<string>();
  const dedup: DbLevel[] = [];
  for (const row of all) {
    if (seen.has(row.sku)) continue;
    seen.add(row.sku);
    dedup.push(row);
    if (dedup.length >= size + forced.length) break;
  }
  return dedup;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-surface readers (defensive — never throw out of the per-SKU loop)
// ────────────────────────────────────────────────────────────────────────────

async function readSsV2Bulk(
  skus: string[],
): Promise<Map<string, { available: number; on_hand: number }>> {
  const out = new Map<string, { available: number; on_hand: number }>();
  if (skus.length === 0) return out;
  // SS v2 caps the `sku` query string value at 200 chars, so we chunk
  // aggressively (~8 SKUs/request) and sequentially since the v2 queue is
  // concurrencyLimit:1 anyway.
  const CHUNK = 8;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    try {
      const v2 = await withTimeout(
        listInventory({ skus: chunk, limit: 100 }),
        20_000,
        `ss v2 listInventory chunk ${i}`,
      );
      // listInventory returns InventoryRecord[] directly per its signature.
      const items = Array.isArray(v2) ? v2 : ((v2 as { inventory?: unknown[] }).inventory ?? []);
      for (const r of items as Array<Record<string, unknown>>) {
        const sku = String(r.sku ?? "");
        if (!sku) continue;
        out.set(sku, {
          available: Number(r.available ?? 0),
          on_hand: Number(r.on_hand ?? r.onHand ?? r.quantity_on_hand ?? 0),
        });
      }
    } catch (e) {
      console.error(
        red(`[ss-v2 chunk ${i}] failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`),
      );
    }
  }
  return out;
}

async function readClandestineShopify(skus: string[]): Promise<Map<string, number>> {
  // For each SKU: GraphQL query productVariants(query: "sku:'X'") → variant.inventoryItem.id
  // Then bulk fetchInventoryLevels for the inventoryItemIds.
  const out = new Map<string, number>();
  const skuToInvItemId = new Map<string, string>();

  for (const sku of skus) {
    try {
      const data = await withTimeout(
        shopifyGraphQL<{
          productVariants: { edges: Array<{ node: { sku: string; inventoryItem: { id: string } } }> };
        }>(
          `query VariantsBySku($q: String!) {
            productVariants(first: 5, query: $q) {
              edges { node { sku inventoryItem { id } } }
            }
          }`,
          { q: `sku:${sku}` },
        ),
        15_000,
        `clandestine shopify variant lookup for ${sku}`,
      );
      const exact = data.productVariants.edges.find((e) => e.node.sku === sku);
      if (exact?.node.inventoryItem?.id) {
        skuToInvItemId.set(sku, exact.node.inventoryItem.id);
      }
    } catch (e) {
      console.error(yellow(`  [clandestine shopify] ${sku}: ${e instanceof Error ? e.message : e}`));
    }
  }

  if (skuToInvItemId.size > 0) {
    try {
      const invItemIds = [...skuToInvItemId.values()];
      const levels = await withTimeout(
        fetchInventoryLevels(invItemIds),
        30_000,
        "clandestine shopify inventory levels",
      );
      const byInvId = new Map(levels.map((l) => [l.inventoryItemId, l.available]));
      for (const [sku, invId] of skuToInvItemId.entries()) {
        const av = byInvId.get(invId);
        if (av !== undefined) out.set(sku, av);
      }
    } catch (e) {
      console.error(red(`[clandestine shopify bulk levels] ${e instanceof Error ? e.message : e}`));
    }
  }
  return out;
}

async function readClientShopifyConnection(
  conn: ConnRow,
  sku: string,
): Promise<number | null> {
  if (!conn.api_key) return null;
  const baseUrl = conn.store_url.replace(/\/$/, "");
  try {
    const variantRes = await withTimeout(
      fetch(`${baseUrl}/admin/api/2026-01/variants.json?sku=${encodeURIComponent(sku)}`, {
        headers: { "X-Shopify-Access-Token": conn.api_key },
      }),
      15_000,
      `client shopify variant ${conn.id}/${sku}`,
    );
    if (!variantRes.ok) return null;
    const { variants } = (await variantRes.json()) as {
      variants: Array<{ id: number; inventory_item_id: number; sku: string }>;
    };
    const match = variants.find((v) => v.sku === sku);
    if (!match) return null;
    const lvlRes = await withTimeout(
      fetch(
        `${baseUrl}/admin/api/2026-01/inventory_levels.json?inventory_item_ids=${match.inventory_item_id}`,
        { headers: { "X-Shopify-Access-Token": conn.api_key } },
      ),
      15_000,
      `client shopify level ${conn.id}/${sku}`,
    );
    if (!lvlRes.ok) return null;
    const { inventory_levels } = (await lvlRes.json()) as {
      inventory_levels: Array<{ available: number }>;
    };
    return inventory_levels.reduce((sum, lvl) => sum + (lvl.available ?? 0), 0);
  } catch {
    return null;
  }
}

async function readClientWooCommerce(conn: ConnRow, sku: string): Promise<number | null> {
  if (!conn.api_key || !conn.api_secret) return null;
  try {
    const product = await withTimeout(
      wooGetProductBySku(
        { consumerKey: conn.api_key, consumerSecret: conn.api_secret, siteUrl: conn.store_url },
        sku,
      ),
      15_000,
      `woo ${conn.id}/${sku}`,
    );
    return product?.stock_quantity ?? null;
  } catch {
    return null;
  }
}

const sqspCache = new Map<string, Map<string, number>>();
async function readClientSquarespace(conn: ConnRow, sku: string): Promise<number | null> {
  if (!conn.api_key) return null;
  // Cache the full inventory list per connection — Squarespace doesn't have a per-SKU lookup.
  if (!sqspCache.has(conn.id)) {
    try {
      const items = await withTimeout(
        squarespaceGetInventory(conn.api_key, conn.store_url),
        45_000,
        `sqsp full inventory ${conn.id}`,
      );
      const map = new Map<string, number>();
      for (const item of items) {
        if (item.sku) map.set(item.sku, item.quantity);
      }
      sqspCache.set(conn.id, map);
    } catch (e) {
      console.error(yellow(`  [sqsp ${conn.id}] full inventory pull failed: ${e instanceof Error ? e.message : e}`));
      sqspCache.set(conn.id, new Map());
    }
  }
  return sqspCache.get(conn.id)?.get(sku) ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const sb = createServiceRoleClient();

  // 1. Pick the SKU sample.
  console.log("\n=== Sampling SKUs ===");
  const sample = await pickSampleSkus(sb, args.sampleSize, args.skus);
  console.log(`sampled ${sample.length} SKUs (forced=${args.skus.length}, sample=${args.sampleSize})`);
  if (sample.length === 0) {
    console.log(red("No SKUs found in warehouse_inventory_levels — aborting."));
    process.exit(1);
  }

  const skuList = sample.map((s) => s.sku);
  const skuToDb = new Map<string, DbLevel>();
  for (const r of sample) skuToDb.set(r.sku, r);

  // 2. Load all active client store connections (we want READS even from dormant).
  console.log("\n=== Loading client store connections ===");
  const { data: connsRaw } = await sb
    .from("client_store_connections")
    .select(
      "id, workspace_id, org_id, platform, store_url, api_key, api_secret, connection_status, do_not_fanout",
    )
    .in("platform", ["shopify", "squarespace", "woocommerce"]);
  const conns = (connsRaw as ConnRow[] | null) ?? [];
  console.log(
    `found ${conns.length} client store connections: ${conns
      .map((c) => `${c.platform}/${c.store_url}/${c.connection_status}${c.do_not_fanout ? "/no-fanout" : ""}`)
      .join(", ") || "(none)"}`,
  );

  // 3. Load sku_mappings for our sampled variants × our connections.
  const variantIds = sample.map((s) => s.variant_id);
  const { data: mapsRaw } = await sb
    .from("client_store_sku_mappings")
    .select(
      "connection_id, variant_id, remote_product_id, remote_variant_id, remote_sku, last_pushed_quantity, last_pushed_at",
    )
    .in("variant_id", variantIds);
  const maps = (mapsRaw as MappingRow[] | null) ?? [];
  // Index: (connId, variantId) → mapping
  const mappingIdx = new Map<string, MappingRow>();
  for (const m of maps) mappingIdx.set(`${m.connection_id}:${m.variant_id}`, m);

  // 4. Read SS v2 in bulk (one paginated call).
  console.log("\n=== Reading ShipStation v2 inventory (bulk) ===");
  const ssV2 = await readSsV2Bulk(skuList);
  console.log(`SS v2 returned data for ${ssV2.size}/${skuList.length} sampled SKUs`);

  // 5. Read Clandestine Shopify (env-based) per SKU.
  console.log("\n=== Reading Clandestine Shopify (env-based) ===");
  const clandShopify = await readClandestineShopify(skuList);
  console.log(`Clandestine Shopify returned data for ${clandShopify.size}/${skuList.length} sampled SKUs`);

  // 6. Per-connection per-SKU reads (slowest leg).
  console.log(`\n=== Reading ${conns.length} client store connections × ${skuList.length} SKUs ===`);
  const snapshots: SnapshotRow[] = [];
  for (const dbLvl of sample) {
    const row: SnapshotRow = {
      sku: dbLvl.sku,
      workspace_id: dbLvl.workspace_id,
      variant_id: dbLvl.variant_id,
      db_available: dbLvl.available,
      db_committed: dbLvl.committed,
      db_last_activity: dbLvl.last_redis_write_at,
      ss_v2_available: ssV2.get(dbLvl.sku)?.available ?? null,
      ss_v2_on_hand: ssV2.get(dbLvl.sku)?.on_hand ?? null,
      clandestine_shopify_available: clandShopify.get(dbLvl.sku) ?? null,
      remote_per_conn: new Map(),
    };

    for (const conn of conns) {
      const mapping = mappingIdx.get(`${conn.id}:${dbLvl.variant_id}`);
      const remoteSku = mapping?.remote_sku ?? dbLvl.sku;
      let remote: number | null = null;
      try {
        if (conn.platform === "shopify") {
          remote = await readClientShopifyConnection(conn, remoteSku);
        } else if (conn.platform === "woocommerce") {
          remote = await readClientWooCommerce(conn, remoteSku);
        } else if (conn.platform === "squarespace") {
          remote = await readClientSquarespace(conn, remoteSku);
        }
      } catch (e) {
        console.error(yellow(`  [${conn.platform}/${conn.id}] ${dbLvl.sku}: ${e instanceof Error ? e.message : e}`));
      }
      row.remote_per_conn.set(conn.id, {
        remote_available: remote,
        last_pushed_quantity: mapping?.last_pushed_quantity ?? null,
        last_pushed_at: mapping?.last_pushed_at ?? null,
      });
    }

    snapshots.push(row);
  }

  // 7. Compute headline metrics.
  console.log("\n=== HEADLINE ===");
  const activatedAt = args.activatedAt ? new Date(args.activatedAt).getTime() : null;
  let totalCompares = 0;
  let aligned = 0;
  let drift = 0;
  let zeroedSuspicious = 0; // storefront == 0 AND db > 0
  let storefrontExceedsDb = 0;
  const damageCandidates: string[] = [];

  for (const r of snapshots) {
    const surfaces: Array<{ label: string; value: number | null }> = [
      { label: "ss_v2", value: r.ss_v2_available },
      { label: "clandestine_shopify", value: r.clandestine_shopify_available },
    ];
    for (const [connId, v] of r.remote_per_conn.entries()) {
      const conn = conns.find((c) => c.id === connId);
      if (!conn) continue;
      surfaces.push({ label: `${conn.platform}/${conn.id.slice(0, 8)}`, value: v.remote_available });
    }

    for (const s of surfaces) {
      if (s.value === null) continue;
      totalCompares++;
      if (s.value === r.db_available) {
        aligned++;
      } else {
        drift++;
        if (s.value === 0 && r.db_available > 0) {
          zeroedSuspicious++;
          damageCandidates.push(`${r.sku} (${s.label}: 0 vs db ${r.db_available})`);
        }
        if (s.value > r.db_available) storefrontExceedsDb++;
      }
    }
  }

  console.log(`Total surface comparisons:       ${totalCompares}`);
  console.log(`Aligned with DB:                 ${green(String(aligned))}`);
  console.log(`Drift (storefront != DB):        ${drift > 0 ? yellow(String(drift)) : "0"}`);
  console.log(`Storefront exceeds DB:           ${storefrontExceedsDb > 0 ? yellow(String(storefrontExceedsDb)) : "0"}`);
  console.log(
    `Suspicious zero (storefront 0, DB > 0): ${zeroedSuspicious > 0 ? red(String(zeroedSuspicious)) : "0"}`,
  );

  if (damageCandidates.length > 0) {
    console.log(red("\n!! ZEROED-OUT CANDIDATES (potential Inventory Sync damage):"));
    for (const d of damageCandidates.slice(0, 20)) console.log(`   ${d}`);
    if (damageCandidates.length > 20) console.log(`   ... +${damageCandidates.length - 20} more`);
  }

  // 8. Per-SKU rich table to console.
  console.log("\n=== Per-SKU detail ===");
  for (const r of snapshots) {
    const cells: string[] = [
      `sku=${r.sku}`,
      `db=${r.db_available}/c${r.db_committed}`,
      `v2=${r.ss_v2_available ?? "—"}`,
      `cland=${r.clandestine_shopify_available ?? "—"}`,
    ];
    for (const [connId, v] of r.remote_per_conn.entries()) {
      const conn = conns.find((c) => c.id === connId);
      if (!conn) continue;
      const remote = v.remote_available;
      const isPushedRecently =
        activatedAt && v.last_pushed_at && new Date(v.last_pushed_at).getTime() >= activatedAt;
      const tag = `${conn.platform.slice(0, 4)}/${conn.id.slice(0, 6)}`;
      let cell = `${tag}=${remote ?? "—"}`;
      if (remote !== null && remote === 0 && r.db_available > 0) cell = red(cell);
      else if (remote !== null && remote !== r.db_available) cell = yellow(cell);
      else if (remote === r.db_available) cell = green(cell);
      if (isPushedRecently) cell = `${cell}*`;
      cells.push(cell);
    }
    if (r.db_last_activity) cells.push(dim(`last_db_act=${r.db_last_activity.slice(0, 16)}`));
    console.log(cells.join("  "));
  }

  // 9. Write CSV.
  await mkdir("reports", { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = `reports/phase0-storefront-snapshot-${ts}.csv`;
  const headerCols = [
    "sku",
    "workspace_id",
    "variant_id",
    "db_available",
    "db_committed",
    "db_last_activity",
    "ss_v2_available",
    "ss_v2_on_hand",
    "clandestine_shopify_available",
  ];
  for (const c of conns) {
    const tag = `${c.platform}_${c.id.slice(0, 8)}`;
    headerCols.push(`${tag}_remote`, `${tag}_last_pushed_qty`, `${tag}_last_pushed_at`);
  }
  const lines = [headerCols.join(",")];
  for (const r of snapshots) {
    const base = [
      r.sku,
      r.workspace_id,
      r.variant_id,
      String(r.db_available),
      String(r.db_committed),
      r.db_last_activity ?? "",
      r.ss_v2_available ?? "",
      r.ss_v2_on_hand ?? "",
      r.clandestine_shopify_available ?? "",
    ];
    for (const c of conns) {
      const v = r.remote_per_conn.get(c.id);
      base.push(
        v?.remote_available?.toString() ?? "",
        v?.last_pushed_quantity?.toString() ?? "",
        v?.last_pushed_at ?? "",
      );
    }
    lines.push(base.map((s) => `"${String(s).replace(/"/g, '""')}"`).join(","));
  }
  await writeFile(csvPath, lines.join("\n"), "utf-8");
  console.log(`\nCSV written: ${csvPath}`);

  // 10. Decision hint.
  console.log("\n=== INTERPRETATION HINT ===");
  if (zeroedSuspicious > 0) {
    console.log(
      red(
        "Some storefronts show 0 while DB shows positive stock. This is the most likely fingerprint of SS Inventory Sync pushing v2-empty values to your storefronts. Recommend: pause SS Inventory Sync from the SS UI and investigate before continuing.",
      ),
    );
  } else if (drift > 0) {
    console.log(
      yellow(
        "Drift detected but no zero-outs. Could be normal sales drift, or SS Inventory Sync pushing slightly different available values. Compare last_pushed_at vs activation time for clearer signal.",
      ),
    );
  } else {
    console.log(green("All sampled surfaces match DB. SS Inventory Sync activation appears non-destructive so far. Safe to proceed to Phase 1 live tests."));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
