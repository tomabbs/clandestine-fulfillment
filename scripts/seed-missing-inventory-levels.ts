#!/usr/bin/env tsx
/**
 * Seed missing warehouse_inventory_levels rows — read-only by default.
 *
 * Closes the 55%-of-catalog structural gap surfaced by
 * `scripts/audit-sku-coverage.ts`: 1,592 variants with no inventory_levels
 * row at all. Without a level row, those SKUs are invisible to:
 *   - the admin /inventory page filter and column sorts,
 *   - bandcamp-inventory-push (no last_pushed_quantity baseline),
 *   - multi-store-inventory-push (same),
 *   - the freshness sensor,
 *   - any reconciliation report.
 *
 * SAFETY POSTURE:
 *   - Default mode is dry-run. `--apply` writes.
 *   - We ONLY seed rows for variants whose SKU is NOT present in either
 *     ShipStation v2 or Bandcamp live. Those are unambiguously "no
 *     external truth signal exists" → seeding 0 is safe.
 *   - Variants whose SKU IS present in SS or BC are reported but NOT
 *     seeded — they need a separate reconciliation pass that imports the
 *     observed remote quantity instead of zero.
 *   - The seed shape matches the canonical write paths used by
 *     shopify-sync.ts / shopify-full-backfill.ts / inbound-product-create.ts:
 *     `{ variant_id, workspace_id, sku, available:0, committed:0, incoming:0 }`
 *     with upsert on variant_id. The DB trigger derives org_id.
 *   - Lint guard at scripts/ci-inventory-guard.sh greps src/ only; this
 *     scripts/ path is allowed (Rule #59 spirit — bulk structural seed).
 *   - Inventory_sync_paused MUST remain true throughout — fanout would not
 *     fire even if we changed the value (level updates do not call
 *     fanoutInventoryChange directly), but keeping pause on prevents any
 *     unrelated cron from firing while we write.
 *
 * Output:
 *   reports/finish-line/seed-missing-levels-${ts}.json
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
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
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

async function loadShipStationSkus(): Promise<Set<string>> {
  const records: InventoryRecord[] = await listInventory({});
  const out = new Set<string>();
  for (const r of records) {
    const sku = normalizeSku(r.sku);
    if (sku) out.add(sku);
  }
  return out;
}

async function loadBandcampSkus(workspaceId: string): Promise<Set<string>> {
  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("band_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (!connections || connections.length === 0) return new Set();
  const token = await refreshBandcampToken(workspaceId);
  const out = new Set<string>();
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
      if (baseSku) out.add(baseSku);
      for (const opt of it.options ?? []) {
        const optSku = normalizeSku(opt.sku);
        if (optSku) out.add(optSku);
      }
    }
  }
  return out;
}

interface SeedRow {
  variant_id: string;
  workspace_id: string;
  sku: string;
  available: number;
  committed: number;
  incoming: number;
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
      "REFUSING TO APPLY: inventory_sync_paused is false. Re-pause the workspace first; bulk seeding while sync is live can race with cron pushes.",
    );
  }
  console.log("");

  console.log("Loading variants + existing level rows...");
  const variants = await pageAll<{
    id: string;
    sku: string | null;
    workspace_id: string;
  }>((from, to) =>
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
  console.log(`  variants:     ${variants.length}`);
  console.log(`  level rows:   ${levels.length}`);

  const missing = variants.filter((v) => !haveLevel.has(v.id));
  console.log(`  missing rows: ${missing.length}`);
  console.log("");

  if (missing.length === 0) {
    console.log("Nothing to do. All variants have level rows.");
    return;
  }

  console.log("Loading external SKU sets (ShipStation v2 + Bandcamp)...");
  const [ssSkus, bcSkus] = await Promise.all([
    loadShipStationSkus(),
    loadBandcampSkus(ws.id),
  ]);
  console.log(`  ShipStation v2 unique SKUs: ${ssSkus.size}`);
  console.log(`  Bandcamp live unique SKUs:  ${bcSkus.size}`);
  console.log("");

  const skipSkuNull: Array<{ variant_id: string }> = [];
  const deferInSs: Array<{ variant_id: string; sku: string }> = [];
  const deferInBc: Array<{ variant_id: string; sku: string }> = [];
  const deferInBoth: Array<{ variant_id: string; sku: string }> = [];
  const seedSafeZero: SeedRow[] = [];

  for (const v of missing) {
    const sku = normalizeSku(v.sku);
    if (!sku) {
      skipSkuNull.push({ variant_id: v.id });
      continue;
    }
    const inSs = ssSkus.has(sku);
    const inBc = bcSkus.has(sku);
    if (inSs && inBc) {
      deferInBoth.push({ variant_id: v.id, sku });
      continue;
    }
    if (inSs) {
      deferInSs.push({ variant_id: v.id, sku });
      continue;
    }
    if (inBc) {
      deferInBc.push({ variant_id: v.id, sku });
      continue;
    }
    seedSafeZero.push({
      variant_id: v.id,
      workspace_id: ws.id,
      sku,
      available: 0,
      committed: 0,
      incoming: 0,
    });
  }

  console.log("Classification of missing-level variants:");
  console.log("─────────────────────────────────────────────────────────");
  console.log(`  sku is null/empty (skipped):                     ${skipSkuNull.length}`);
  console.log(`  sku in BOTH SS and BC live (defer reconcile):    ${deferInBoth.length}`);
  console.log(`  sku in SS only           (defer reconcile):      ${deferInSs.length}`);
  console.log(`  sku in BC live only      (defer reconcile):      ${deferInBc.length}`);
  console.log(`  sku in NEITHER (safe to seed available=0):       ${seedSafeZero.length}`);
  console.log("");

  let inserted = 0;
  let writeError: string | null = null;
  if (flags.apply) {
    console.log(`Writing ${seedSafeZero.length} new level rows in batches of ${WRITE_BATCH}...`);
    for (let i = 0; i < seedSafeZero.length; i += WRITE_BATCH) {
      const batch = seedSafeZero.slice(i, i + WRITE_BATCH);
      const { error } = await supabase
        .from("warehouse_inventory_levels")
        .upsert(batch, { onConflict: "variant_id", ignoreDuplicates: false });
      if (error) {
        writeError = error.message;
        console.error(
          `  batch ${i}–${i + batch.length - 1} FAILED: ${error.message}`,
        );
        break;
      }
      inserted += batch.length;
      console.log(`  ...inserted ${inserted}/${seedSafeZero.length}`);
    }
    console.log(`Done. Rows inserted: ${inserted}.`);
  } else {
    console.log(`(dry-run) Would insert ${seedSafeZero.length} rows. Pass --apply to write.`);
  }
  console.log("");

  const outDir = join("reports", "finish-line");
  mkdirSync(outDir, { recursive: true });
  const summary = {
    ts,
    workspace: { id: ws.id, name: ws.name, slug: ws.slug },
    inventory_sync_paused: ws.inventory_sync_paused,
    mode: flags.apply ? "apply" : "dry-run",
    variants_total: variants.length,
    levels_total_existing: levels.length,
    missing_total: missing.length,
    classification: {
      sku_null: skipSkuNull.length,
      defer_in_both: deferInBoth.length,
      defer_in_ss_only: deferInSs.length,
      defer_in_bc_only: deferInBc.length,
      seed_safe_zero: seedSafeZero.length,
    },
    write: {
      attempted: flags.apply,
      inserted,
      error: writeError,
    },
    samples: {
      defer_in_both_first_25: deferInBoth.slice(0, 25),
      defer_in_ss_only_first_25: deferInSs.slice(0, 25),
      defer_in_bc_only_first_25: deferInBc.slice(0, 25),
      seed_safe_zero_first_25: seedSafeZero.slice(0, 25).map((r) => r.sku),
      sku_null_first_25: skipSkuNull.slice(0, 25),
    },
  };
  const jsonPath = join(outDir, `seed-missing-levels-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  console.log(`Wrote summary JSON: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
