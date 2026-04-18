#!/usr/bin/env tsx
/**
 * Reconcile the remaining missing-level variants from remote truth.
 *
 * Sister to `scripts/seed-missing-inventory-levels.ts`. That script handled
 * 840 variants whose SKU was unknown to both SS and BC (safe to seed 0).
 * This script handles the remaining 752 where the SKU IS present in
 * ShipStation v2 and/or Bandcamp live, so seeding 0 would WRONGLY
 * suppress real stock.
 *
 * Source-of-truth precedence (deliberate):
 *   1. ShipStation v2 — physical warehouse truth, used by fulfillment.
 *      If SS knows the SKU, SS.available wins.
 *   2. Bandcamp live — used only when SS does not know the SKU.
 *
 * The "in both" bucket (44 in the audit) deliberately falls through to
 * SS, because SS reflects physical pick-bin reality whereas BC is the
 * publicly-listed available count after Bandcamp's own buffering.
 *
 * Bandcamp `quantity_available` is capped at 100 by Bandcamp itself for
 * "unlimited" items — those are flagged in the report so an operator can
 * decide whether 100 is truthy or whether to override.
 *
 * SAFETY:
 *   - Default mode is dry-run. `--apply` writes.
 *   - Requires inventory_sync_paused = true.
 *   - Writes a single JSON artifact with full per-SKU detail so the
 *     operator can audit every value before committing.
 *   - upsert on variant_id with the canonical seed shape.
 *
 * Output:
 *   reports/finish-line/reconcile-missing-levels-${ts}.json
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
const WRITE_BATCH = 500;

function normalizeSku(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

interface CliFlags {
  apply: boolean;
}
function parseFlags(argv: string[]): CliFlags {
  return { apply: argv.includes("--apply") };
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

interface SsRecord {
  sku: string;
  available: number;
  inventory_warehouse_id: string;
  inventory_location_id: string;
}

async function loadShipStationBySku(): Promise<Map<string, SsRecord[]>> {
  const records: InventoryRecord[] = await listInventory({});
  const out = new Map<string, SsRecord[]>();
  for (const r of records) {
    const sku = normalizeSku(r.sku);
    if (!sku) continue;
    const arr = out.get(sku) ?? [];
    arr.push({
      sku,
      available: r.available ?? 0,
      inventory_warehouse_id: r.inventory_warehouse_id,
      inventory_location_id: r.inventory_location_id,
    });
    out.set(sku, arr);
  }
  return out;
}

interface BcRecord {
  sku: string;
  quantity_available: number | null;
  band_name: string | null;
  title: string;
  is_unlimited_capped: boolean;
}

async function loadBandcampBySku(workspaceId: string): Promise<Map<string, BcRecord[]>> {
  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("band_id, band_name")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  const out = new Map<string, BcRecord[]>();
  if (!connections || connections.length === 0) return out;
  const token = await refreshBandcampToken(workspaceId);
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
        const qty = it.quantity_available ?? null;
        const arr = out.get(baseSku) ?? [];
        arr.push({
          sku: baseSku,
          quantity_available: qty,
          band_name: conn.band_name ?? null,
          title: it.title,
          is_unlimited_capped: qty === 100,
        });
        out.set(baseSku, arr);
      }
      for (const opt of it.options ?? []) {
        const optSku = normalizeSku(opt.sku);
        if (!optSku) continue;
        const qty = opt.quantity_available ?? null;
        const arr = out.get(optSku) ?? [];
        arr.push({
          sku: optSku,
          quantity_available: qty,
          band_name: conn.band_name ?? null,
          title: `${it.title} (${opt.title ?? "option"})`,
          is_unlimited_capped: qty === 100,
        });
        out.set(optSku, arr);
      }
    }
  }
  return out;
}

interface ReconcileRow {
  variant_id: string;
  workspace_id: string;
  sku: string;
  available: number;
  committed: number;
  incoming: number;
  source: "shipstation" | "bandcamp";
  source_detail: Record<string, unknown>;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, name, slug, inventory_sync_paused")
    .limit(1)
    .single();
  if (!ws) throw new Error("No workspace found");

  console.log(`Workspace: ${ws.name} (${ws.id})`);
  console.log(`  inventory_sync_paused = ${ws.inventory_sync_paused}`);
  console.log(`  mode = ${flags.apply ? "APPLY (writes will happen)" : "dry-run (no writes)"}`);
  if (!ws.inventory_sync_paused && flags.apply) {
    throw new Error(
      "REFUSING TO APPLY: inventory_sync_paused is false. Re-pause the workspace first.",
    );
  }
  console.log("");

  console.log("Loading variants + existing level rows...");
  const variants = await pageAll<{ id: string; sku: string | null; workspace_id: string }>(
    (from, to) =>
      supabase
        .from("warehouse_product_variants")
        .select("id, sku, workspace_id")
        .eq("workspace_id", ws.id)
        .order("id", { ascending: true })
        .range(from, to),
  );
  const levels = await pageAll<{ variant_id: string }>((from, to) =>
    supabase
      .from("warehouse_inventory_levels")
      .select("variant_id")
      .eq("workspace_id", ws.id)
      .order("variant_id", { ascending: true })
      .range(from, to),
  );
  const haveLevel = new Set(levels.map((l) => l.variant_id));
  const missing = variants.filter((v) => !haveLevel.has(v.id));
  console.log(`  variants:     ${variants.length}`);
  console.log(`  level rows:   ${levels.length}`);
  console.log(`  missing rows: ${missing.length}`);
  console.log("");

  if (missing.length === 0) {
    console.log("Nothing to do. All variants have level rows.");
    return;
  }

  console.log("Loading external truth (ShipStation v2 + Bandcamp)...");
  const [ssMap, bcMap] = await Promise.all([
    loadShipStationBySku(),
    loadBandcampBySku(ws.id),
  ]);
  console.log(`  SS unique SKUs: ${ssMap.size}`);
  console.log(`  BC unique SKUs: ${bcMap.size}`);
  console.log("");

  const planRows: ReconcileRow[] = [];
  const skipNoExternalTruth: Array<{ variant_id: string; sku: string | null }> = [];
  const skipMultiLocationSs: Array<{ variant_id: string; sku: string; locations: number }> = [];
  const flagBcUnlimited: Array<{ variant_id: string; sku: string; band_name: string | null; title: string }> = [];

  for (const v of missing) {
    const sku = normalizeSku(v.sku);
    if (!sku) {
      skipNoExternalTruth.push({ variant_id: v.id, sku: null });
      continue;
    }
    const ssRecs = ssMap.get(sku);
    if (ssRecs && ssRecs.length > 0) {
      const total = ssRecs.reduce((acc, r) => acc + (r.available ?? 0), 0);
      if (ssRecs.length > 1) {
        skipMultiLocationSs.push({ variant_id: v.id, sku, locations: ssRecs.length });
      }
      planRows.push({
        variant_id: v.id,
        workspace_id: ws.id,
        sku,
        available: Math.max(0, total),
        committed: 0,
        incoming: 0,
        source: "shipstation",
        source_detail: {
          location_count: ssRecs.length,
          per_location: ssRecs.map((r) => ({
            warehouse: r.inventory_warehouse_id,
            location: r.inventory_location_id,
            available: r.available,
          })),
        },
      });
      continue;
    }
    const bcRecs = bcMap.get(sku);
    if (bcRecs && bcRecs.length > 0) {
      const sumQty = bcRecs.reduce(
        (acc, r) => acc + (typeof r.quantity_available === "number" ? r.quantity_available : 0),
        0,
      );
      if (bcRecs.some((r) => r.is_unlimited_capped)) {
        flagBcUnlimited.push({
          variant_id: v.id,
          sku,
          band_name: bcRecs[0].band_name,
          title: bcRecs[0].title,
        });
      }
      planRows.push({
        variant_id: v.id,
        workspace_id: ws.id,
        sku,
        available: Math.max(0, sumQty),
        committed: 0,
        incoming: 0,
        source: "bandcamp",
        source_detail: {
          record_count: bcRecs.length,
          per_record: bcRecs.map((r) => ({
            band: r.band_name,
            title: r.title,
            quantity_available: r.quantity_available,
            is_unlimited_capped: r.is_unlimited_capped,
          })),
        },
      });
      continue;
    }
    skipNoExternalTruth.push({ variant_id: v.id, sku });
  }

  const fromSs = planRows.filter((r) => r.source === "shipstation").length;
  const fromBc = planRows.filter((r) => r.source === "bandcamp").length;
  const totalUnits = planRows.reduce((acc, r) => acc + r.available, 0);

  console.log("Reconcile plan:");
  console.log("─────────────────────────────────────────────────────────");
  console.log(`  rows to write from ShipStation v2 truth: ${fromSs}`);
  console.log(`  rows to write from Bandcamp live truth:  ${fromBc}`);
  console.log(`  total reconciled units (sum of available): ${totalUnits}`);
  console.log(`  multi-location SS (sum across all):       ${skipMultiLocationSs.length}`);
  console.log(`  BC at unlimited cap (qty==100, flagged):  ${flagBcUnlimited.length}`);
  console.log(`  no external truth available (skipped):    ${skipNoExternalTruth.length}`);
  console.log("");

  let inserted = 0;
  let writeError: string | null = null;
  if (flags.apply) {
    console.log(`Writing ${planRows.length} reconciled level rows...`);
    const writePayload = planRows.map((r) => ({
      variant_id: r.variant_id,
      workspace_id: r.workspace_id,
      sku: r.sku,
      available: r.available,
      committed: r.committed,
      incoming: r.incoming,
    }));
    for (let i = 0; i < writePayload.length; i += WRITE_BATCH) {
      const batch = writePayload.slice(i, i + WRITE_BATCH);
      const { error } = await supabase
        .from("warehouse_inventory_levels")
        .upsert(batch, { onConflict: "variant_id", ignoreDuplicates: false });
      if (error) {
        writeError = error.message;
        console.error(`  batch ${i}–${i + batch.length - 1} FAILED: ${error.message}`);
        break;
      }
      inserted += batch.length;
      console.log(`  ...inserted ${inserted}/${writePayload.length}`);
    }
    console.log(`Done. Rows inserted: ${inserted}.`);
  } else {
    console.log(`(dry-run) Would insert ${planRows.length} rows. Pass --apply to write.`);
  }
  console.log("");

  const outDir = join("reports", "finish-line");
  mkdirSync(outDir, { recursive: true });

  const summary = {
    ts,
    workspace: { id: ws.id, name: ws.name, slug: ws.slug },
    inventory_sync_paused: ws.inventory_sync_paused,
    mode: flags.apply ? "apply" : "dry-run",
    counts: {
      variants_total: variants.length,
      levels_total_existing: levels.length,
      missing_total: missing.length,
      reconciled_from_ss: fromSs,
      reconciled_from_bc: fromBc,
      total_units_reconciled: totalUnits,
      skipped_no_external_truth: skipNoExternalTruth.length,
      flagged_multi_location_ss: skipMultiLocationSs.length,
      flagged_bc_unlimited_cap: flagBcUnlimited.length,
    },
    write: { attempted: flags.apply, inserted, error: writeError },
    plan_full: planRows,
    skips: {
      no_external_truth: skipNoExternalTruth,
      multi_location_ss_first_50: skipMultiLocationSs.slice(0, 50),
      bc_unlimited_cap_first_50: flagBcUnlimited.slice(0, 50),
    },
  };
  const jsonPath = join(outDir, `reconcile-missing-levels-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  console.log(`Wrote summary JSON: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
