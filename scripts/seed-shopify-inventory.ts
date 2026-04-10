/**
 * One-time: seed inventory levels for Shopify-only variants (not in Bandcamp).
 *
 * Finds warehouse variants that have a shopify_variant_id but NO warehouse_inventory_levels row,
 * fetches their current stock from the Clandestine Shopify store, and creates the inventory levels.
 *
 * Usage:
 *   npx tsx scripts/seed-shopify-inventory.ts --dry-run
 *   npx tsx scripts/seed-shopify-inventory.ts --apply
 */

import { createClient } from "@supabase/supabase-js";
import { Redis } from "@upstash/redis";
import "dotenv/config";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (!apply && !dryRun) {
  console.error("Usage: npx tsx scripts/seed-shopify-inventory.ts [--dry-run|--apply]");
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOPIFY_URL = process.env.SHOPIFY_STORE_URL!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN!;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-01";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

async function shopifyGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SHOPIFY_URL}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data: T; errors?: unknown[] };
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const BATCH_SIZE = 50;

async function main() {
  console.log(`\nShopify Inventory Seed — ${dryRun ? "DRY RUN" : "APPLY MODE"}\n`);

  // Get workspace
  const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!ws) { console.error("No workspace"); process.exit(1); }
  const workspaceId = ws.id;

  // Find variants with shopify_variant_id but NO inventory level
  const { data: variants } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku, shopify_variant_id, shopify_inventory_item_id")
    .eq("workspace_id", workspaceId)
    .not("shopify_variant_id", "is", null);

  if (!variants?.length) {
    console.log("No Shopify variants found.");
    return;
  }

  // Get existing inventory level variant IDs
  const { data: existingLevels } = await supabase
    .from("warehouse_inventory_levels")
    .select("variant_id")
    .eq("workspace_id", workspaceId);

  const hasLevel = new Set((existingLevels ?? []).map((l) => l.variant_id));
  const missing = variants.filter((v) => !hasLevel.has(v.id));

  console.log(`Total Shopify variants: ${variants.length}`);
  console.log(`Already have inventory levels: ${hasLevel.size}`);
  console.log(`Missing inventory levels: ${missing.length}`);

  if (missing.length === 0) {
    console.log("\nAll variants already have inventory levels.");
    return;
  }

  // Step 1: For variants without shopify_inventory_item_id, fetch it from Shopify
  const needsItemId = missing.filter((v) => !v.shopify_inventory_item_id);
  console.log(`\nVariants needing inventory_item_id lookup: ${needsItemId.length}`);

  const variantToItemId = new Map<string, string>();

  // Pre-fill from variants that already have the column
  for (const v of missing) {
    if (v.shopify_inventory_item_id) {
      variantToItemId.set(v.id, v.shopify_inventory_item_id);
    }
  }

  // Batch fetch missing inventory item IDs from Shopify
  for (let i = 0; i < needsItemId.length; i += BATCH_SIZE) {
    const batch = needsItemId.slice(i, i + BATCH_SIZE);
    const ids = batch.map((v) => {
      const raw = v.shopify_variant_id!;
      if (raw.startsWith("gid://")) return raw;
      if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
      return raw;
    });

    try {
      const data = await shopifyGraphQL<{
        nodes: Array<{ id: string; inventoryItem: { id: string } } | null>;
      }>(
        `query FetchVariantItems($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } } }`,
        { ids },
      );

      let batchMatched = 0;
      for (const node of data.nodes) {
        if (!node) continue;
        const variant = batch.find((v) => {
          const raw = v.shopify_variant_id!;
          const gid = raw.startsWith("gid://") ? raw : `gid://shopify/ProductVariant/${raw}`;
          return gid === node.id;
        });
        if (variant) {
          variantToItemId.set(variant.id, node.inventoryItem.id);
          batchMatched++;
          if (apply) {
            await supabase
              .from("warehouse_product_variants")
              .update({ shopify_inventory_item_id: node.inventoryItem.id })
              .eq("id", variant.id);
          }
        }
      }
      if (batchMatched === 0 && data.nodes.filter((n: unknown) => n !== null).length > 0) {
        console.log(`  Batch ${i}-${i + BATCH_SIZE}: ${data.nodes.filter((n: unknown) => n !== null).length} nodes returned but 0 matched`);
      }
    } catch (err) {
      console.error(`Batch ${i}-${i + BATCH_SIZE} variant lookup failed:`, err instanceof Error ? err.message : err);
    }

    if (i % 200 === 0 && i > 0) {
      console.log(`  ... processed ${i}/${needsItemId.length} variant lookups`);
    }
  }

  console.log(`Resolved inventory item IDs: ${variantToItemId.size}/${missing.length}`);

  // Step 2: Fetch inventory levels from Shopify in batches
  const inventoryItemIds = Array.from(variantToItemId.values());
  const itemIdToVariant = new Map<string, typeof missing[0]>();
  for (const v of missing) {
    const itemId = variantToItemId.get(v.id);
    if (itemId) itemIdToVariant.set(itemId, v);
  }

  let seeded = 0;
  let skippedNoData = 0;
  let errors = 0;

  for (let i = 0; i < inventoryItemIds.length; i += BATCH_SIZE) {
    const batch = inventoryItemIds.slice(i, i + BATCH_SIZE);

    try {
      const data = await shopifyGraphQL<{
        nodes: Array<{
          id: string;
          inventoryLevels: {
            edges: Array<{
              node: { quantities: Array<{ name: string; quantity: number }> };
            }>;
          };
        } | null>;
      }>(
        `query FetchLevels($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              inventoryLevels(first: 5) {
                edges { node { quantities(names: ["available", "committed", "incoming"]) { name quantity } } }
              }
            }
          }
        }`,
        { ids: batch },
      );

      for (const node of data.nodes) {
        if (!node) continue;
        const variant = itemIdToVariant.get(node.id);
        if (!variant) continue;

        const levels = node.inventoryLevels.edges[0]?.node.quantities ?? [];
        const find = (name: string) => levels.find((q) => q.name === name)?.quantity ?? 0;
        const available = find("available");
        const committed = find("committed");
        const incoming = find("incoming");

        if (apply) {
          const { error } = await supabase.from("warehouse_inventory_levels").upsert(
            {
              variant_id: variant.id,
              workspace_id: workspaceId,
              sku: variant.sku,
              available,
              committed,
              incoming,
              last_redis_write_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "variant_id", ignoreDuplicates: false },
          );

          if (error) {
            console.error(`  Failed to upsert ${variant.sku}: ${error.message}`);
            errors++;
            continue;
          }

          if (redis) {
            await redis.hset(`inv:${variant.sku}`, { available, committed, incoming });
          }
        }

        seeded++;
      }
    } catch (err) {
      console.error(`Batch ${i}-${i + BATCH_SIZE} level fetch failed:`, err instanceof Error ? err.message : err);
      errors++;
    }

    if (i % 200 === 0 && i > 0) {
      console.log(`  ... processed ${i}/${inventoryItemIds.length} inventory lookups`);
    }
  }

  // Log activity record
  if (apply && seeded > 0) {
    await supabase.from("warehouse_inventory_activity").insert({
      workspace_id: workspaceId,
      sku: "__shopify_seed_reconciliation__",
      delta: 0,
      source: "backfill",
      correlation_id: `shopify-seed:${new Date().toISOString()}`,
      metadata: {
        type: "shopify_seed",
        total_missing: missing.length,
        resolved_item_ids: variantToItemId.size,
        seeded,
        skipped: skippedNoData,
        errors,
      },
    });
  }

  console.log(`\n=== SHOPIFY SEED SUMMARY (${dryRun ? "DRY RUN" : "APPLIED"}) ===`);
  console.log(`Variants missing levels:    ${missing.length}`);
  console.log(`Resolved inventory item ID: ${variantToItemId.size}`);
  console.log(`Seeded from Shopify:        ${seeded}`);
  console.log(`Errors:                     ${errors}`);
  console.log();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
