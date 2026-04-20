/**
 * Clandestine Shopify distro sync — Phase 0.7.
 *
 * Background:
 *   The "main" `shopify-sync` task (every 15 min) only upserts products that
 *   ALREADY have a `warehouse_products` row with a non-null `org_id` (line ~195
 *   of shopify-sync.ts: `if (!orgId) continue;`). That gates the full catalog
 *   to fulfillment-client products. Distro items — products on Clandestine's
 *   own Shopify with no Bandcamp upstream and no client org — are silently
 *   discarded.
 *
 *   This task fills the gap. Once a day it walks the Clandestine Shopify
 *   product list and creates `warehouse_products` rows for any product whose
 *   variants are NOT mapped to a `bandcamp_product_mappings` row (i.e. truly
 *   distro). The discriminator is `org_id IS NULL` (enabled by the Phase 0.7
 *   migration that drops NOT NULL on `warehouse_products.org_id`).
 *
 * Boundaries (read carefully — easy to expand by accident):
 *   - This task does NOT touch products that already have a `warehouse_products`
 *     row. Both client-owned and previously-imported distro rows are left to
 *     `shopify-sync` (which now happily processes both since we relaxed the
 *     `if (!orgId) continue;` to be NULL-tolerant via migration).
 *   - This task does NOT enroll distro products in Bandcamp anything. They
 *     have no Bandcamp identity by definition.
 *   - This task does NOT sync inventory (Rule #59 + Rule #20). Inventory comes
 *     in via SHIP_NOTIFY (Phase 2), not via this importer.
 *   - Workspace selection: imports into the "Clandestine" workspace only. We
 *     resolve it by `slug = 'clandestine'`; if absent (test env), we no-op
 *     instead of crashing. Distro products belong to Clandestine's own
 *     fulfillment scope, not to any client workspace.
 *
 * Rule #7: createServiceRoleClient() — bypasses RLS to write distro rows.
 * Rule #59: bulk-style upsert with no per-row recordInventoryChange call —
 *           this is catalog ingestion, not an inventory write path.
 * Rule #12: payload IDs only — schedules.task takes no payload.
 */

import { schedules } from "@trigger.dev/sdk";
import { fetchProducts, type ShopifyProduct } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { normalizeShopifyProductId } from "@/lib/shared/shopify-id";

const PAGE_SIZE = 50;

export const clandestineShopifySyncTask = schedules.task({
  id: "clandestine-shopify-sync",
  // Daily at 04:30 UTC — runs after the nightly `bandcamp-baseline-audit`
  // (03:00 UTC) so any overnight Bandcamp publishes have written their
  // `bandcamp_product_mappings` rows before we evaluate "is this distro?".
  cron: "30 4 * * *",
  maxDuration: 600,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();

    // Resolve the Clandestine workspace. Distro items live there.
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("id")
      .eq("slug", "clandestine")
      .maybeSingle();

    if (!workspace) {
      console.warn(
        "[clandestine-shopify-sync] No workspace with slug='clandestine' — skipping run.",
      );
      return { skipped: true, reason: "no_clandestine_workspace" };
    }

    const workspaceId = workspace.id;
    const startedAt = new Date().toISOString();

    await supabase.from("channel_sync_log").insert({
      workspace_id: workspaceId,
      channel: "clandestine_shopify",
      sync_type: "distro_import",
      status: "started",
      started_at: startedAt,
      metadata: { run_id: ctx.run.id },
    });

    let cursor: string | null = null;
    let hasNextPage = true;
    let scanned = 0;
    let createdProducts = 0;
    let createdVariants = 0;

    try {
      while (hasNextPage) {
        const { products, pageInfo } = await fetchProducts({
          first: PAGE_SIZE,
          after: cursor,
          updatedAtMin: null,
        });

        if (products.length === 0) break;

        for (const product of products) {
          scanned++;
          const result = await maybeCreateDistroProduct(supabase, product, workspaceId);
          if (result.createdProduct) createdProducts++;
          createdVariants += result.createdVariants;
        }

        cursor = pageInfo.endCursor;
        hasNextPage = pageInfo.hasNextPage;
      }

      await supabase
        .from("channel_sync_log")
        .update({
          status: "completed",
          items_processed: createdProducts,
          completed_at: new Date().toISOString(),
          metadata: {
            run_id: ctx.run.id,
            scanned,
            created_products: createdProducts,
            created_variants: createdVariants,
          },
        })
        .eq("workspace_id", workspaceId)
        .eq("channel", "clandestine_shopify")
        .eq("started_at", startedAt);

      return { workspaceId, scanned, createdProducts, createdVariants };
    } catch (error) {
      await supabase
        .from("channel_sync_log")
        .update({
          status: "failed",
          items_processed: createdProducts,
          error_message: error instanceof Error ? error.message : String(error),
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("channel", "clandestine_shopify")
        .eq("started_at", startedAt);
      throw error;
    }
  },
});

/**
 * For one Shopify product, decide whether it is distro and create
 * `warehouse_products` + `warehouse_product_variants` if so. Returns counts.
 *
 * Decision rules (in order):
 *   1. If a `warehouse_products` row already exists for this `shopify_product_id`,
 *      skip — it's already known (either client-owned or a previous distro import).
 *   2. If ANY variant SKU on this product matches a `bandcamp_product_mappings`
 *      row in this workspace, skip — this is a client product whose Bandcamp
 *      counterpart hasn't yet created the warehouse_products row. Leave it to
 *      `bandcamp-sync` to author.
 *   3. Otherwise: create `warehouse_products` with `org_id = NULL` (distro
 *      discriminator) and one `warehouse_product_variants` row per variant
 *      with a non-empty SKU.
 *
 * Exported for unit testing.
 */
export async function maybeCreateDistroProduct(
  supabase: ReturnType<typeof createServiceRoleClient>,
  product: ShopifyProduct,
  workspaceId: string,
): Promise<{ createdProduct: boolean; createdVariants: number }> {
  // Rule 1 — already known
  const { data: existing } = await supabase
    .from("warehouse_products")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_product_id", product.id)
    .maybeSingle();

  if (existing) return { createdProduct: false, createdVariants: 0 };

  const variantSkus = product.variants.edges
    .map((e) => e.node.sku)
    .filter((sku): sku is string => Boolean(sku));

  if (variantSkus.length === 0) return { createdProduct: false, createdVariants: 0 };

  // Rule 2 — does any variant already participate in Bandcamp? If yes, this
  // is a client product (or a soon-to-be one); not distro.
  const { data: bandcampMatches } = await supabase
    .from("warehouse_product_variants")
    .select("id, bandcamp_product_mappings!inner(id)")
    .eq("workspace_id", workspaceId)
    .in("sku", variantSkus);

  if ((bandcampMatches?.length ?? 0) > 0) {
    return { createdProduct: false, createdVariants: 0 };
  }

  // Rule 3 — create distro row.
  const { data: insertedProduct, error: productError } = await supabase
    .from("warehouse_products")
    .insert({
      workspace_id: workspaceId,
      org_id: null,
      shopify_product_id: normalizeShopifyProductId(product.id),
      title: product.title,
      vendor: product.vendor,
      product_type: product.productType,
      status: product.status.toLowerCase() as "active" | "draft" | "archived",
      tags: product.tags,
      shopify_handle: product.handle,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (productError || !insertedProduct) {
    console.error(
      `[clandestine-shopify-sync] Failed to insert distro product ${product.id}:`,
      productError?.message,
    );
    return { createdProduct: false, createdVariants: 0 };
  }

  let variantCount = 0;
  for (const edge of product.variants.edges) {
    const variant = edge.node;
    if (!variant.sku) continue;

    const parsedPrice = variant.price ? Number.parseFloat(variant.price) : null;
    const costValue = parsedPrice != null ? Math.round(parsedPrice * 0.5 * 100) / 100 : null;

    const { error: variantError } = await supabase.from("warehouse_product_variants").upsert(
      {
        product_id: insertedProduct.id,
        workspace_id: workspaceId,
        sku: variant.sku,
        shopify_variant_id: variant.id,
        shopify_inventory_item_id: variant.inventoryItem?.id ?? null,
        title: variant.title,
        price: parsedPrice,
        compare_at_price: variant.compareAtPrice ? Number.parseFloat(variant.compareAtPrice) : null,
        barcode: variant.barcode,
        weight: variant.inventoryItem?.measurement?.weight?.value ?? null,
        weight_unit: variant.inventoryItem?.measurement?.weight?.unit?.toLowerCase() ?? "lb",
        option1_name: variant.selectedOptions[0]?.name ?? null,
        option1_value: variant.selectedOptions[0]?.value ?? null,
        cost: costValue,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,sku", ignoreDuplicates: false },
    );

    if (variantError) {
      // Rule #39: never crash on SKU uniqueness violations. A SKU collision
      // here means another (probably client) product owns this SKU. Surface
      // to review queue and continue.
      await supabase.from("warehouse_review_queue").upsert(
        {
          workspace_id: workspaceId,
          category: "sku_collision",
          severity: "medium",
          title: `Distro import: SKU '${variant.sku}' already owned by another product`,
          description: `Clandestine Shopify product ${product.id} (variant ${variant.id}) collides on SKU '${variant.sku}'. Distro row created but variant skipped.`,
          metadata: {
            shopify_product_id: product.id,
            shopify_variant_id: variant.id,
            sku: variant.sku,
            error: variantError.message,
          },
          group_key: `distro_sku_collision:${variant.sku}`,
          status: "open",
        },
        { onConflict: "group_key", ignoreDuplicates: false },
      );
      continue;
    }
    variantCount++;
  }

  return { createdProduct: true, createdVariants: variantCount };
}
