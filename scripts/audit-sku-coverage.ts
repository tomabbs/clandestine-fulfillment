#!/usr/bin/env tsx
/**
 * SKU coverage audit — read-only.
 *
 * Pulls the SKU set from three sources and prints a coverage matrix:
 *
 *   1. Postgres truth: `warehouse_product_variants` (workspace-scoped),
 *      with inventory levels and bandcamp/clandestine-store mappings as
 *      enrichment columns.
 *   2. ShipStation v2 inventory tenant: every record from `/v2/inventory`
 *      via cursor-paged enumeration. SKU + on_hand + available + warehouse.
 *   3. Bandcamp live merch catalog: `getMerchDetails` per active
 *      `bandcamp_connections` band — both item-level SKU and per-option
 *      SKUs (variants on a Bandcamp package).
 *
 * Output:
 *   - Console summary table.
 *   - JSON artifact: reports/finish-line/sku-coverage-${ts}.json
 *   - CSV detail (one row per SKU): reports/finish-line/sku-coverage-${ts}.csv
 *
 * No mutations. Safe to run while inventory_sync_paused = true.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getMerchDetails,
  refreshBandcampToken,
  type BandcampMerchItem,
} from "@/lib/clients/bandcamp";
import { listInventory, type InventoryRecord } from "@/lib/clients/shipstation-inventory-v2";

const supabase: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const PAGE_SIZE = 1000;

interface DbVariantRow {
  workspace_id: string;
  sku: string | null;
  variant_id: string;
  product_id: string;
  bandcamp_mapped: boolean;
  client_store_mappings: number;
  available: number | null;
  committed: number | null;
  shopify_inventory_item_id: string | null;
}

function normalizeSku(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function pageAll<T>(
  fetcher: (from: number, to: number) => Promise<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await fetcher(from, to);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function loadDbVariants(workspaceId: string): Promise<DbVariantRow[]> {
  const variants = await pageAll<{
    id: string;
    sku: string | null;
    product_id: string;
    workspace_id: string;
    shopify_inventory_item_id: string | null;
  }>((from, to) =>
    supabase
      .from("warehouse_product_variants")
      .select("id, sku, product_id, workspace_id, shopify_inventory_item_id")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const variantIds = variants.map((v) => v.id);
  const skus = variants.map((v) => normalizeSku(v.sku)).filter(Boolean) as string[];

  const levelBySku = new Map<string, { available: number | null; committed: number | null }>();
  const CHUNK = 500;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("warehouse_inventory_levels")
      .select("sku, available, committed")
      .eq("workspace_id", workspaceId)
      .in("sku", chunk);
    if (error) throw error;
    for (const lv of data ?? []) {
      const k = normalizeSku(lv.sku);
      if (!k) continue;
      levelBySku.set(k, {
        available: typeof lv.available === "number" ? lv.available : null,
        committed: typeof lv.committed === "number" ? lv.committed : null,
      });
    }
  }

  // Bandcamp mappings — single workspace_id filter, paginated
  const bcMaps = await pageAll<{ variant_id: string }>((from, to) =>
    supabase
      .from("bandcamp_product_mappings")
      .select("variant_id")
      .eq("workspace_id", workspaceId)
      .order("variant_id", { ascending: true })
      .range(from, to),
  );
  const variantIdSet = new Set(variantIds);
  const bcMappedVariants = new Set(
    bcMaps.map((b) => b.variant_id).filter((id) => variantIdSet.has(id)),
  );

  // Client-store mappings — paginated
  const csMaps = await pageAll<{ variant_id: string; is_active: boolean | null }>((from, to) =>
    supabase
      .from("client_store_sku_mappings")
      .select("variant_id, is_active")
      .eq("is_active", true)
      .order("variant_id", { ascending: true })
      .range(from, to),
  );
  const csCountByVariant = new Map<string, number>();
  for (const cs of csMaps) {
    if (!variantIdSet.has(cs.variant_id)) continue;
    csCountByVariant.set(cs.variant_id, (csCountByVariant.get(cs.variant_id) ?? 0) + 1);
  }

  return variants.map((v) => {
    const sku = normalizeSku(v.sku);
    const lvl = sku ? levelBySku.get(sku) : undefined;
    return {
      workspace_id: v.workspace_id,
      sku,
      variant_id: v.id,
      product_id: v.product_id,
      bandcamp_mapped: bcMappedVariants.has(v.id),
      client_store_mappings: csCountByVariant.get(v.id) ?? 0,
      available: lvl?.available ?? null,
      committed: lvl?.committed ?? null,
      shopify_inventory_item_id: v.shopify_inventory_item_id ?? null,
    };
  });
}

interface SsRow {
  sku: string;
  on_hand: number;
  available: number;
  inventory_warehouse_id: string;
  inventory_location_id: string;
  last_updated_at: string;
}

async function loadShipStationInventory(): Promise<{
  rows: SsRow[];
  totalRecordsBeforeDedup: number;
}> {
  const records: InventoryRecord[] = await listInventory({});
  const seen = new Set<string>();
  const out: SsRow[] = [];
  for (const r of records) {
    const sku = normalizeSku(r.sku);
    if (!sku) continue;
    if (seen.has(sku)) continue;
    seen.add(sku);
    out.push({
      sku,
      on_hand: r.on_hand ?? 0,
      available: r.available ?? 0,
      inventory_warehouse_id: r.inventory_warehouse_id,
      inventory_location_id: r.inventory_location_id,
      last_updated_at: r.last_updated_at,
    });
  }
  return { rows: out, totalRecordsBeforeDedup: records.length };
}

interface BcRow {
  sku: string;
  band_id: number;
  band_name: string | null;
  package_id: number;
  title: string;
  option_label: string | null;
  quantity_available: number | null;
}

async function loadBandcampCatalog(workspaceId: string): Promise<BcRow[]> {
  const { data: connections, error } = await supabase
    .from("bandcamp_connections")
    .select("band_id, band_name")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) throw error;
  if (!connections || connections.length === 0) return [];

  const token = await refreshBandcampToken(workspaceId);
  const out: BcRow[] = [];

  for (const conn of connections) {
    let items: BandcampMerchItem[] = [];
    try {
      items = await getMerchDetails(Number(conn.band_id), token);
    } catch (err) {
      console.error(
        `[bc] getMerchDetails failed for band_id=${conn.band_id}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      continue;
    }
    for (const it of items) {
      const baseSku = normalizeSku(it.sku);
      if (baseSku) {
        out.push({
          sku: baseSku,
          band_id: Number(conn.band_id),
          band_name: conn.band_name ?? null,
          package_id: it.package_id,
          title: it.title,
          option_label: null,
          quantity_available: it.quantity_available ?? null,
        });
      }
      for (const opt of it.options ?? []) {
        const optSku = normalizeSku(opt.sku);
        if (!optSku) continue;
        out.push({
          sku: optSku,
          band_id: Number(conn.band_id),
          band_name: conn.band_name ?? null,
          package_id: it.package_id,
          title: it.title,
          option_label: opt.title ?? null,
          quantity_available: opt.quantity_available ?? null,
        });
      }
    }
  }
  return out;
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}
function difference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

function caseFolded(s: string): string {
  return s.toLowerCase();
}

function findCaseInsensitiveMatches(
  missingFromB: Set<string>,
  bSet: Set<string>,
): Map<string, string> {
  const bLower = new Map<string, string>();
  for (const sku of bSet) bLower.set(caseFolded(sku), sku);
  const matches = new Map<string, string>();
  for (const sku of missingFromB) {
    const m = bLower.get(caseFolded(sku));
    if (m && m !== sku) matches.set(sku, m);
  }
  return matches;
}

function findWhitespaceMatches(missingFromB: Set<string>, bSet: Set<string>): Map<string, string> {
  const bStripped = new Map<string, string>();
  for (const sku of bSet) bStripped.set(sku.replace(/\s+/g, ""), sku);
  const matches = new Map<string, string>();
  for (const sku of missingFromB) {
    const m = bStripped.get(sku.replace(/\s+/g, ""));
    if (m && m !== sku) matches.set(sku, m);
  }
  return matches;
}

async function main(): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const { data: ws } = await supabase
    .from("workspaces")
    .select(
      "id, name, slug, shipstation_v2_inventory_warehouse_id, shipstation_v2_inventory_location_id, inventory_sync_paused",
    )
    .limit(1)
    .single();
  if (!ws) throw new Error("No workspace found");

  console.log(`SKU audit for workspace: ${ws.name} (${ws.id})`);
  console.log(`  inventory_sync_paused = ${ws.inventory_sync_paused}`);
  console.log(`  v2 default warehouse  = ${ws.shipstation_v2_inventory_warehouse_id ?? "NULL"}`);
  console.log(`  v2 default location   = ${ws.shipstation_v2_inventory_location_id ?? "NULL"}`);

  const { count: pgVariantCount } = await supabase
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ws.id);
  console.log(`  pg variant exact count: ${pgVariantCount}`);
  console.log("");

  console.log("Loading Postgres variants (paginated)...");
  const dbVariants = await loadDbVariants(ws.id);
  const dbSkuSet = new Set(dbVariants.map((v) => v.sku).filter(Boolean) as string[]);
  console.log(`  variants total:                 ${dbVariants.length}`);
  console.log(`  variants with non-null SKU:     ${dbSkuSet.size}`);
  console.log(
    `  variants with bandcamp mapping:  ${dbVariants.filter((v) => v.bandcamp_mapped).length}`,
  );
  console.log(
    `  variants with client_store maps: ${dbVariants.filter((v) => v.client_store_mappings > 0).length}`,
  );
  console.log(
    `  variants with available > 0:     ${dbVariants.filter((v) => (v.available ?? 0) > 0).length}`,
  );
  console.log(
    `  variants with available IS NULL: ${dbVariants.filter((v) => v.available == null).length}`,
  );
  console.log("");

  console.log("Loading ShipStation v2 inventory (full tenant enumeration)...");
  let ssRows: SsRow[] = [];
  let ssTotal = 0;
  let ssError: string | null = null;
  try {
    const r = await loadShipStationInventory();
    ssRows = r.rows;
    ssTotal = r.totalRecordsBeforeDedup;
    console.log(`  records returned (pre-dedup):  ${ssTotal}`);
    console.log(`  unique SKUs in ShipStation v2: ${ssRows.length}`);
  } catch (err) {
    ssError = err instanceof Error ? err.message : "unknown";
    console.error(`  ShipStation v2 fetch FAILED: ${ssError}`);
  }
  const ssSkuSet = new Set(ssRows.map((r) => r.sku));
  console.log("");

  console.log("Loading Bandcamp live catalog...");
  let bcRows: BcRow[] = [];
  let bcError: string | null = null;
  try {
    bcRows = await loadBandcampCatalog(ws.id);
    console.log(`  bandcamp catalog rows:       ${bcRows.length}`);
    const uniq = new Set(bcRows.map((r) => r.sku));
    console.log(`  unique SKUs in Bandcamp:     ${uniq.size}`);
    console.log(`  bands queried:               ${new Set(bcRows.map((r) => r.band_id)).size}`);
  } catch (err) {
    bcError = err instanceof Error ? err.message : "unknown";
    console.error(`  Bandcamp fetch FAILED: ${bcError}`);
  }
  const bcSkuSet = new Set(bcRows.map((r) => r.sku));
  console.log("");

  console.log("Coverage matrix (exact SKU match)");
  console.log("─────────────────────────────────────────────────────────");

  const dbInSs = intersect(dbSkuSet, ssSkuSet);
  const dbOnly = difference(dbSkuSet, ssSkuSet);
  const ssOnly = difference(ssSkuSet, dbSkuSet);

  const dbInBc = intersect(dbSkuSet, bcSkuSet);
  const dbBcMappedSkus = new Set(
    dbVariants.filter((v) => v.bandcamp_mapped && v.sku).map((v) => v.sku as string),
  );
  const bcMappedNotInBcLive = difference(dbBcMappedSkus, bcSkuSet);
  const bcLiveNotInDb = difference(bcSkuSet, dbSkuSet);

  console.log(`  DB ∩ SS         : ${dbInSs.size}`);
  console.log(`  DB only (not SS): ${dbOnly.size}`);
  console.log(`  SS only (not DB): ${ssOnly.size}`);
  console.log("");
  console.log(`  DB ∩ BC live    : ${dbInBc.size}`);
  console.log(`  DB BC-mapped not in BC live: ${bcMappedNotInBcLive.size}`);
  console.log(`  BC live not in DB         : ${bcLiveNotInDb.size}`);
  console.log("");

  console.log("Near-miss diagnostics (case + whitespace)");
  console.log("─────────────────────────────────────────────────────────");

  const dbOnlyCaseHitsSs = findCaseInsensitiveMatches(dbOnly, ssSkuSet);
  const dbOnlyWsHitsSs = findWhitespaceMatches(dbOnly, ssSkuSet);
  console.log(`  DB-only that match SS by case-fold only:        ${dbOnlyCaseHitsSs.size}`);
  console.log(`  DB-only that match SS by whitespace strip only: ${dbOnlyWsHitsSs.size}`);

  const dbOnlyCaseHitsBc = findCaseInsensitiveMatches(dbOnly, bcSkuSet);
  console.log(`  DB-only that match BC by case-fold only:        ${dbOnlyCaseHitsBc.size}`);

  const bcLiveCaseHitsDb = findCaseInsensitiveMatches(bcLiveNotInDb, dbSkuSet);
  console.log(`  BC-only that match DB by case-fold only:        ${bcLiveCaseHitsDb.size}`);
  console.log("");

  const dbOnlyVariants = dbVariants.filter((v) => v.sku && dbOnly.has(v.sku));
  const dbOnlyAvailGt0 = dbOnlyVariants.filter((v) => (v.available ?? 0) > 0).length;
  const dbOnlyBcMapped = dbOnlyVariants.filter((v) => v.bandcamp_mapped).length;
  const dbOnlyClientMapped = dbOnlyVariants.filter((v) => v.client_store_mappings > 0).length;

  console.log("DB-only SKU breakdown (the 'in our DB but not in SS' bucket)");
  console.log("─────────────────────────────────────────────────────────");
  console.log(`  total DB-only SKUs:             ${dbOnlyVariants.length}`);
  console.log(`  ...with available > 0:          ${dbOnlyAvailGt0}`);
  console.log(`  ...bandcamp-mapped:             ${dbOnlyBcMapped}`);
  console.log(`  ...client-store-mapped:         ${dbOnlyClientMapped}`);
  console.log("");

  const outDir = join("reports", "finish-line");
  mkdirSync(outDir, { recursive: true });

  const summary = {
    ts,
    workspace: { id: ws.id, name: ws.name, slug: ws.slug },
    workspace_v2_defaults_set: !!(
      ws.shipstation_v2_inventory_warehouse_id && ws.shipstation_v2_inventory_location_id
    ),
    inventory_sync_paused: ws.inventory_sync_paused,
    db: {
      pg_variant_exact_count: pgVariantCount,
      variants_loaded: dbVariants.length,
      variants_with_sku: dbSkuSet.size,
      bandcamp_mapped: dbVariants.filter((v) => v.bandcamp_mapped).length,
      client_store_mapped: dbVariants.filter((v) => v.client_store_mappings > 0).length,
      available_gt_zero: dbVariants.filter((v) => (v.available ?? 0) > 0).length,
      available_is_null: dbVariants.filter((v) => v.available == null).length,
    },
    shipstation: {
      error: ssError,
      records_pre_dedup: ssTotal,
      unique_skus: ssRows.length,
    },
    bandcamp: {
      error: bcError,
      catalog_rows: bcRows.length,
      unique_skus: bcSkuSet.size,
      bands_queried: new Set(bcRows.map((r) => r.band_id)).size,
    },
    matrix: {
      db_intersect_ss: dbInSs.size,
      db_only_not_ss: dbOnly.size,
      ss_only_not_db: ssOnly.size,
      db_intersect_bc_live: dbInBc.size,
      db_bc_mapped_not_in_bc_live: bcMappedNotInBcLive.size,
      bc_live_not_in_db: bcLiveNotInDb.size,
    },
    near_miss: {
      db_only_case_match_ss: dbOnlyCaseHitsSs.size,
      db_only_whitespace_match_ss: dbOnlyWsHitsSs.size,
      db_only_case_match_bc: dbOnlyCaseHitsBc.size,
      bc_only_case_match_db: bcLiveCaseHitsDb.size,
    },
    db_only_breakdown: {
      total: dbOnlyVariants.length,
      available_gt_zero: dbOnlyAvailGt0,
      bandcamp_mapped: dbOnlyBcMapped,
      client_store_mapped: dbOnlyClientMapped,
    },
    samples: {
      db_only_first_25: Array.from(dbOnly).slice(0, 25),
      ss_only_first_25: Array.from(ssOnly).slice(0, 25),
      bc_only_first_25: Array.from(bcLiveNotInDb).slice(0, 25),
      bc_mapped_not_in_bc_live_first_25: Array.from(bcMappedNotInBcLive).slice(0, 25),
      case_mismatch_ss_first_25: Array.from(dbOnlyCaseHitsSs.entries()).slice(0, 25),
      whitespace_mismatch_ss_first_25: Array.from(dbOnlyWsHitsSs.entries()).slice(0, 25),
    },
  };

  const jsonPath = join(outDir, `sku-coverage-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  console.log(`Wrote summary JSON: ${jsonPath}`);

  const allSkus = new Set<string>();
  for (const s of dbSkuSet) allSkus.add(s);
  for (const s of ssSkuSet) allSkus.add(s);
  for (const s of bcSkuSet) allSkus.add(s);

  const dbBySku = new Map<string, DbVariantRow>();
  for (const v of dbVariants) if (v.sku) dbBySku.set(v.sku, v);
  const ssBySku = new Map<string, SsRow>();
  for (const r of ssRows) ssBySku.set(r.sku, r);
  const bcBySku = new Map<string, BcRow>();
  for (const r of bcRows) if (!bcBySku.has(r.sku)) bcBySku.set(r.sku, r);

  const csvLines: string[] = [
    "sku,in_db,in_ss,in_bc,db_available,db_committed,db_bc_mapped,db_client_store_maps,ss_available,ss_on_hand,bc_quantity_available,bc_band_name,bc_title",
  ];
  const csvEsc = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  for (const sku of Array.from(allSkus).sort()) {
    const d = dbBySku.get(sku);
    const s = ssBySku.get(sku);
    const b = bcBySku.get(sku);
    csvLines.push(
      [
        csvEsc(sku),
        d ? 1 : 0,
        s ? 1 : 0,
        b ? 1 : 0,
        csvEsc(d?.available ?? ""),
        csvEsc(d?.committed ?? ""),
        d?.bandcamp_mapped ? 1 : 0,
        d?.client_store_mappings ?? 0,
        csvEsc(s?.available ?? ""),
        csvEsc(s?.on_hand ?? ""),
        csvEsc(b?.quantity_available ?? ""),
        csvEsc(b?.band_name ?? ""),
        csvEsc(b?.title ?? ""),
      ].join(","),
    );
  }
  const csvPath = join(outDir, `sku-coverage-${ts}.csv`);
  writeFileSync(csvPath, csvLines.join("\n"));
  console.log(`Wrote SKU detail CSV: ${csvPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
