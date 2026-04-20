// Emergency recovery for orphaned variants left by dedup-shopify-products.ts.
//
// Background: dedup-shopify-products.ts had a pagination bug in its variant
// counting (Supabase 1000-row default cap inside a 5000-product slice), so
// it kept the wrong row in some duplicate pairs. The kept rows had no
// variants attached; the deleted rows had the variants. Variants weren't
// CASCADE-deleted (the FK is nullable), so we now have ~1064 variants whose
// product_id points at a now-deleted UUID.
//
// Recovery strategy:
//   For each orphan variant:
//     1. Use shopify_variant_id (which we kept on the row) to query Shopify
//        for the parent product's GID
//     2. Normalize that GID to numeric form
//     3. Find the surviving warehouse_product with that shopify_product_id
//     4. UPDATE the orphan variant's product_id to point at the survivor
//
// Safe to re-run; idempotent. Skips variants that already point at a valid
// product_id.
//
// Usage:
//   pnpm tsx scripts/recover-orphaned-variants.ts --dry-run
//   pnpm tsx scripts/recover-orphaned-variants.ts            (live)

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { shopifyGraphQL } from "../src/lib/clients/shopify-client";
import { normalizeShopifyProductId } from "../src/lib/shared/shopify-id";

interface Args {
  dryRun: boolean;
}

function parseArgs(): Args {
  return { dryRun: process.argv.includes("--dry-run") };
}

interface Variant {
  id: string;
  workspace_id: string;
  product_id: string | null;
  sku: string | null;
  shopify_variant_id: string | null;
}

async function main() {
  const args = parseArgs();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  const s = createClient(url, key);

  console.log(`[recover] dryRun=${args.dryRun}`);

  // Pull all warehouse_product_variants paginated.
  const allVariants: Variant[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await s
      .from("warehouse_product_variants")
      .select("id, workspace_id, product_id, sku, shopify_variant_id")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allVariants.push(...(data as Variant[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`[recover] scanned ${allVariants.length} variants`);

  // Pull all live warehouse_product IDs to find orphans.
  const liveProductIds = new Set<string>();
  let pFrom = 0;
  for (;;) {
    const { data, error } = await s
      .from("warehouse_products")
      .select("id")
      .order("id")
      .range(pFrom, pFrom + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const p of data) liveProductIds.add(p.id as string);
    if (data.length < PAGE) break;
    pFrom += PAGE;
  }
  console.log(`[recover] live products: ${liveProductIds.size}`);

  const orphans = allVariants.filter(
    (v) => v.product_id && !liveProductIds.has(v.product_id),
  );
  const recoverable = orphans.filter((v) => v.shopify_variant_id);
  console.log(`[recover] orphans: ${orphans.length} (${recoverable.length} have shopify_variant_id)`);

  // Build map: shopify_product_id (numeric) -> warehouse_product.id
  // PAGINATED — Supabase caps at 1000 rows per request even with .range().
  const byShopifyId = new Map<string, string>();
  let prodFrom = 0;
  for (;;) {
    const { data, error } = await s
      .from("warehouse_products")
      .select("id, workspace_id, shopify_product_id")
      .not("shopify_product_id", "is", null)
      .order("id")
      .range(prodFrom, prodFrom + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const p of data) {
      const k = `${p.workspace_id}|${normalizeShopifyProductId(p.shopify_product_id as string)}`;
      byShopifyId.set(k, p.id as string);
    }
    if (data.length < PAGE) break;
    prodFrom += PAGE;
  }
  console.log(`[recover] surviving product map size: ${byShopifyId.size}`);

  // Query Shopify for each orphan variant's parent product.
  // Batched via productVariants(query: "id:V1 OR id:V2 ...") — up to 250 per query.
  const BATCH = 100;
  const reattach: Array<{ variantUuid: string; newProductUuid: string }> = [];
  let querycount = 0;
  let unmapped = 0;
  for (let i = 0; i < recoverable.length; i += BATCH) {
    const slice = recoverable.slice(i, i + BATCH);
    const queryStr = slice
      .map((v) => `id:${(v.shopify_variant_id as string).replace(/^gid:\/\/shopify\/ProductVariant\//, "")}`)
      .join(" OR ");
    const data = await shopifyGraphQL<{
      productVariants: {
        nodes: Array<{ id: string; product: { id: string } }>;
      };
    }>(
      `query Q($q: String!) { productVariants(first: 250, query: $q) { nodes { id product { id } } } }`,
      { q: queryStr },
    );
    querycount++;
    const lookup = new Map<string, string>();
    for (const n of data.productVariants.nodes) {
      lookup.set(n.id, n.product.id);
    }
    for (const v of slice) {
      const variantGid = v.shopify_variant_id?.startsWith("gid://")
        ? v.shopify_variant_id
        : `gid://shopify/ProductVariant/${v.shopify_variant_id}`;
      const productGid = lookup.get(variantGid as string);
      if (!productGid) { unmapped++; continue; }
      const productNumeric = normalizeShopifyProductId(productGid);
      const survivor = byShopifyId.get(`${v.workspace_id}|${productNumeric}`);
      if (!survivor) { unmapped++; continue; }
      reattach.push({ variantUuid: v.id, newProductUuid: survivor });
    }
    process.stdout.write(`  shopify queries: ${querycount}, planned re-attaches: ${reattach.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`[recover] re-attach plan: ${reattach.length}; unmapped: ${unmapped}`);

  if (args.dryRun) {
    console.log("[recover] dry-run — exiting");
    return;
  }

  let updated = 0;
  let errors = 0;
  for (const r of reattach) {
    const { error } = await s
      .from("warehouse_product_variants")
      .update({ product_id: r.newProductUuid, updated_at: new Date().toISOString() })
      .eq("id", r.variantUuid);
    if (error) {
      errors++;
      if (errors < 5) console.warn(`  update ${r.variantUuid} failed: ${error.message}`);
      continue;
    }
    updated++;
    if (updated % 100 === 0) process.stdout.write(`  re-attached ${updated}/${reattach.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`[recover] DONE — re-attached: ${updated}, errors: ${errors}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
