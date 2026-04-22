/**
 * Read-only chunked re-implementation of the seed gate cascade.
 *
 * The shipping seed task at src/trigger/tasks/shipstation-seed-inventory.ts
 * calls `.in("variant_id", variantIds)` with the full workspace variant set
 * (1596 IDs for Clandestine Distribution), which exceeds PostgREST URL
 * length limits and yields HTTP 400. This script reproduces the same
 * gates with manual chunking so we can preview real counts.
 *
 * Side effects: NONE. Pure read.
 *
 * Usage:
 *   npx tsx scripts/_dryrun-seed-chunked.ts <workspaceId>
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { computeEffectiveBandcampAvailable } from "@/lib/server/bandcamp-effective-available";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const CHUNK = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error("usage: npx tsx scripts/_dryrun-seed-chunked.ts <workspaceId>");
    process.exit(1);
  }

  const sb = createServiceRoleClient();

  console.log(`\n=== Seed dry-run (chunked) for workspace ${workspaceId} ===`);

  type V = { id: string; sku: string; warehouse_products: { org_id: string | null } | null };
  const variants: V[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("warehouse_product_variants")
      .select("id, sku, warehouse_products!inner(org_id)")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`variants: ${error.message}`);
    const rows = (data ?? []) as unknown as V[];
    variants.push(...rows.filter((v) => v.warehouse_products?.org_id != null));
    if (rows.length < PAGE) break;
  }
  console.log(`candidates (org-scoped variants): ${variants.length}`);

  const variantIds = variants.map((v) => v.id);

  const bundleVariantIds = new Set<string>();
  for (const ids of chunk(variantIds, CHUNK)) {
    const { data, error } = await sb
      .from("bundle_components")
      .select("bundle_variant_id")
      .in("bundle_variant_id", ids);
    if (error) throw new Error(`bundle_components: ${error.message}`);
    for (const r of data ?? []) bundleVariantIds.add(r.bundle_variant_id as string);
  }
  console.log(`bundle_excluded: ${bundleVariantIds.size}`);

  const mappingByVariant = new Map<
    string,
    { push_mode: string; bandcamp_origin_quantities: unknown }
  >();
  for (const ids of chunk(variantIds, CHUNK)) {
    const { data, error } = await sb
      .from("bandcamp_product_mappings")
      .select("variant_id, push_mode, bandcamp_origin_quantities")
      .in("variant_id", ids);
    if (error) throw new Error(`bandcamp_product_mappings: ${error.message}`);
    for (const r of data ?? []) {
      mappingByVariant.set(r.variant_id as string, {
        push_mode: r.push_mode as string,
        bandcamp_origin_quantities: r.bandcamp_origin_quantities,
      });
    }
  }
  console.log(`bandcamp mappings loaded: ${mappingByVariant.size}`);

  const inventoryByVariant = new Map<string, number>();
  for (const ids of chunk(variantIds, CHUNK)) {
    const { data, error } = await sb
      .from("warehouse_inventory_levels")
      .select("variant_id, available")
      .in("variant_id", ids);
    if (error) throw new Error(`warehouse_inventory_levels: ${error.message}`);
    for (const r of data ?? []) {
      inventoryByVariant.set(r.variant_id as string, Number(r.available) || 0);
    }
  }
  console.log(`inventory levels loaded: ${inventoryByVariant.size}`);

  const counts = {
    candidates: variants.length,
    bundle_excluded: 0,
    blocked_by_push_mode: 0,
    blocked_zero_origin_sum: 0,
    blocked_zero_warehouse_stock: 0,
    seeded: 0,
  };
  const pushModeBreakdown = new Map<string, number>();

  for (const v of variants) {
    if (bundleVariantIds.has(v.id)) {
      counts.bundle_excluded++;
      continue;
    }
    const m = mappingByVariant.get(v.id);
    if (!m || m.push_mode !== "normal") {
      counts.blocked_by_push_mode++;
      const key = m ? `mapped:${m.push_mode}` : "unmapped";
      pushModeBreakdown.set(key, (pushModeBreakdown.get(key) ?? 0) + 1);
      continue;
    }
    const origin = computeEffectiveBandcampAvailable(m.bandcamp_origin_quantities);
    if (origin <= 0) {
      counts.blocked_zero_origin_sum++;
      continue;
    }
    const wh = inventoryByVariant.get(v.id) ?? 0;
    if (wh <= 0) {
      counts.blocked_zero_warehouse_stock++;
      continue;
    }
    counts.seeded++;
  }

  console.log("\n=== Dry-run gate counts ===");
  console.log(JSON.stringify(counts, null, 2));
  console.log("\nblocked_by_push_mode breakdown:");
  for (const [k, v] of [...pushModeBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
