/**
 * One-time bootstrap: seed warehouse inventory from Bandcamp live data.
 *
 * Usage:
 *   npx tsx scripts/seed-bandcamp-inventory.ts --file=path/to/bandcamp-live-inventory.xlsx --dry-run
 *   npx tsx scripts/seed-bandcamp-inventory.ts --file=path/to/bandcamp-live-inventory.xlsx --apply --confirm-bootstrap
 *
 * Flags:
 *   --dry-run    Report only, no DB/Redis writes
 *   --apply      Execute writes
 *   --confirm-bootstrap  Required for --apply (prevents casual reuse)
 *   --force      Allow re-run even if a previous seed timestamp exists
 */

import { createClient } from "@supabase/supabase-js";
import { Redis } from "@upstash/redis";
import * as fs from "node:fs";
import * as path from "node:path";
import XLSX from "xlsx";

const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith("--file="))?.replace("--file=", "");
const dryRun = args.includes("--dry-run");
const apply = args.includes("--apply");
const confirmBootstrap = args.includes("--confirm-bootstrap");
const force = args.includes("--force");

if (!fileArg) {
  console.error("Usage: npx tsx scripts/seed-bandcamp-inventory.ts --file=<path> [--dry-run|--apply --confirm-bootstrap]");
  process.exit(1);
}
const filePath: string = fileArg;

if (apply && !confirmBootstrap) {
  console.error("Error: --apply requires --confirm-bootstrap flag (this is a one-time bootstrap tool)");
  process.exit(1);
}

if (!apply && !dryRun) {
  console.error("Error: specify --dry-run or --apply --confirm-bootstrap");
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let redis: Redis | null = null;
if (REDIS_URL && REDIS_TOKEN) {
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

interface SeedRow {
  account: string;
  artist: string;
  productTitle: string;
  optionVariant: string;
  skuItem: string;
  skuOption: string;
  qtyAvailable: number | null;
  qtySold: number;
  packageId: number;
  effectiveSku: string;
}

interface ConflictRow {
  sku: string;
  existingQty: number;
  bandcampQty: number;
  account: string;
  productTitle: string;
}

async function main() {
  console.log(`\nBandcamp Inventory Seed — ${dryRun ? "DRY RUN" : "APPLY MODE"}`);
  console.log(`File: ${filePath}\n`);

  // Check for previous seed
  if (apply && !force) {
    const { data: prevSeed } = await supabase
      .from("warehouse_sync_state")
      .select("last_sync_cursor")
      .eq("sync_type", "bandcamp_seed")
      .maybeSingle();

    if (prevSeed?.last_sync_cursor) {
      console.error(`Error: Previous seed found at ${prevSeed.last_sync_cursor}. Use --force to override.`);
      process.exit(1);
    }
  }

  // Get workspace ID
  const { data: workspaces } = await supabase.from("workspaces").select("id");
  if (!workspaces?.length) {
    console.error("No workspaces found");
    process.exit(1);
  }
  const workspaceId = workspaces[0].id;

  // Parse XLSX
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];

  const rows: SeedRow[] = raw.map((r) => {
    const skuOption = String(r["SKU (Option)"] ?? "").trim();
    const skuItem = String(r["SKU (Item)"] ?? "").trim();
    return {
      account: String(r["Account"] ?? ""),
      artist: String(r["Artist"] ?? ""),
      productTitle: String(r["Product Title"] ?? ""),
      optionVariant: String(r["Option/Variant"] ?? ""),
      skuItem,
      skuOption,
      qtyAvailable: typeof r["Qty Available (LIVE)"] === "number" ? r["Qty Available (LIVE)"] as number : null,
      qtySold: typeof r["Qty Sold (LIVE)"] === "number" ? r["Qty Sold (LIVE)"] as number : 0,
      packageId: typeof r["Package ID"] === "number" ? r["Package ID"] as number : 0,
      effectiveSku: skuOption || skuItem,
    };
  });

  console.log(`Parsed ${rows.length} rows from XLSX`);

  const seedable = rows.filter((r) => r.qtyAvailable !== null && r.qtyAvailable >= 0);
  console.log(`Seedable rows (qty available is numeric): ${seedable.length}`);

  let matched = 0;
  let inserted = 0;
  let updated = 0;
  let skippedZero = 0;
  let unmapped = 0;
  const conflicts: ConflictRow[] = [];
  const unmappedRows: SeedRow[] = [];

  for (const row of seedable) {
    // Three-tier SKU fallback
    let variant: { id: string; sku: string } | null = null;

    // Tier 1: SKU (Option) — most specific
    if (row.skuOption) {
      const { data } = await supabase
        .from("warehouse_product_variants")
        .select("id, sku")
        .eq("workspace_id", workspaceId)
        .eq("sku", row.skuOption)
        .maybeSingle();
      if (data) variant = data;
    }

    // Tier 2: SKU (Item)
    if (!variant && row.skuItem) {
      const { data } = await supabase
        .from("warehouse_product_variants")
        .select("id, sku")
        .eq("workspace_id", workspaceId)
        .eq("sku", row.skuItem)
        .maybeSingle();
      if (data) variant = data;
    }

    // Tier 3: Package ID → bandcamp_product_mappings → variant_id
    if (!variant && row.packageId) {
      const { data: mapping } = await supabase
        .from("bandcamp_product_mappings")
        .select("variant_id, warehouse_product_variants!inner(id, sku)")
        .eq("workspace_id", workspaceId)
        .eq("bandcamp_item_id", row.packageId)
        .maybeSingle();
      if (mapping) {
        const v = mapping.warehouse_product_variants as unknown as { id: string; sku: string };
        variant = { id: v.id, sku: v.sku };
      }
    }

    if (!variant) {
      unmapped++;
      unmappedRows.push(row);
      continue;
    }

    matched++;

    if (row.qtyAvailable === 0) {
      skippedZero++;
      continue;
    }

    // Check existing inventory level
    const { data: existing } = await supabase
      .from("warehouse_inventory_levels")
      .select("id, available")
      .eq("variant_id", variant.id)
      .maybeSingle();

    const qty = row.qtyAvailable ?? 0;

    if (existing && existing.available !== 0 && existing.available !== 999) {
      conflicts.push({
        sku: variant.sku,
        existingQty: existing.available,
        bandcampQty: qty,
        account: row.account,
        productTitle: row.productTitle,
      });
      continue;
    }

    if (apply) {
      await supabase.from("warehouse_inventory_levels").upsert(
        {
          variant_id: variant.id,
          workspace_id: workspaceId,
          sku: variant.sku,
          available: qty,
          committed: 0,
          incoming: 0,
          last_redis_write_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "variant_id", ignoreDuplicates: false },
      );

      if (redis) {
        await redis.hset(`inv:${variant.sku}`, {
          available: qty,
          committed: 0,
          incoming: 0,
        });
      }

      if (existing) {
        updated++;
      } else {
        inserted++;
      }
    } else {
      if (existing) updated++;
      else inserted++;
    }
  }

  // Log reconciliation activity
  if (apply && (inserted > 0 || updated > 0)) {
    await supabase.from("warehouse_inventory_activity").insert({
      workspace_id: workspaceId,
      sku: "__bandcamp_seed_reconciliation__",
      delta: 0,
      source: "backfill",
      correlation_id: `bandcamp-seed:${new Date().toISOString()}`,
      metadata: {
        type: "bandcamp_seed",
        total_rows: rows.length,
        matched,
        inserted,
        updated,
        conflicts: conflicts.length,
        unmapped,
      },
    });

    // Record seed timestamp
    await supabase.from("warehouse_sync_state").upsert(
      {
        workspace_id: workspaceId,
        sync_type: "bandcamp_seed",
        last_sync_cursor: new Date().toISOString(),
        last_sync_wall_clock: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,sync_type" },
    );
  }

  // Write conflicts CSV
  if (conflicts.length > 0) {
    const csvDir = path.join(process.cwd(), "reports");
    fs.mkdirSync(csvDir, { recursive: true });
    const csvPath = path.join(csvDir, `seed-conflicts-${new Date().toISOString().split("T")[0]}.csv`);
    const csvLines = [
      "sku,existing_qty,bandcamp_qty,account,product_title",
      ...conflicts.map(
        (c) => `${c.sku},${c.existingQty},${c.bandcampQty},"${c.account}","${c.productTitle}"`,
      ),
    ];
    fs.writeFileSync(csvPath, csvLines.join("\n"));
    console.log(`Conflicts CSV: ${csvPath}`);
  }

  // Write unmapped report
  if (unmappedRows.length > 0) {
    const csvDir = path.join(process.cwd(), "reports");
    fs.mkdirSync(csvDir, { recursive: true });
    const csvPath = path.join(csvDir, `seed-unmapped-${new Date().toISOString().split("T")[0]}.csv`);
    const csvLines = [
      "account,artist,product_title,sku_item,sku_option,package_id,qty_available",
      ...unmappedRows.map(
        (r) =>
          `"${r.account}","${r.artist}","${r.productTitle}","${r.skuItem}","${r.skuOption}",${r.packageId},${r.qtyAvailable ?? ""}`,
      ),
    ];
    fs.writeFileSync(csvPath, csvLines.join("\n"));
    console.log(`Unmapped CSV: ${csvPath}`);
  }

  console.log(`\n=== SEED SUMMARY (${dryRun ? "DRY RUN" : "APPLIED"}) ===`);
  console.log(`Total XLSX rows:    ${rows.length}`);
  console.log(`Seedable:           ${seedable.length}`);
  console.log(`Matched to variant: ${matched}`);
  console.log(`  Inserted (new):   ${inserted}`);
  console.log(`  Updated (0/999):  ${updated}`);
  console.log(`  Skipped (qty=0):  ${skippedZero}`);
  console.log(`  Conflicts:        ${conflicts.length}`);
  console.log(`Unmapped (no SKU):  ${unmapped}`);
  console.log();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
