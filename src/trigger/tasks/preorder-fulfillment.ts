/**
 * Pre-order fulfillment — runs 2× daily at 6 AM and 6 PM EST.
 *
 * Rule #69: FIFO allocation. ORDER BY warehouse_orders.created_at ASC.
 * When available stock hits 0, remaining orders stay pending and a
 * short_shipment review queue item is created (severity: critical).
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 * §21: Tags-only model (no selling plans).
 */

import { logger, schedules, task } from "@trigger.dev/sdk";
import { tagsRemove } from "@/lib/clients/shopify-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { getTodayNY, isDaysAfterRelease } from "@/lib/shared/preorder-dates";
import { allocatePreorders } from "@/trigger/lib/preorder-allocation";

export const preorderFulfillmentTask = schedules.task({
  id: "preorder-fulfillment",
  cron: {
    // Run at 6 AM and 6 PM Eastern — catches midnight-release items earlier
    pattern: "0 6,18 * * *",
    timezone: "America/New_York",
  },
  maxDuration: 300,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const today = getTodayNY();

    let variantsReleased = 0;
    let ordersAllocated = 0;
    let shortShipments = 0;

    for (const workspaceId of workspaceIds) {
      // Find all pre-order variants on or past their street date
      const { data: variants } = await supabase
        .from("warehouse_product_variants")
        .select("id, sku, product_id, street_date")
        .eq("workspace_id", workspaceId)
        .eq("is_preorder", true)
        .lte("street_date", today);

      if (!variants || variants.length === 0) continue;

      for (const variant of variants) {
        const result = await releaseVariant(supabase, variant, workspaceId, ctx.run.id);
        variantsReleased++;
        ordersAllocated += result.ordersAllocated;
        if (result.isShortShipment) shortShipments++;
      }

      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "preorder",
        sync_type: "fulfillment",
        status: shortShipments > 0 ? "partial" : "completed",
        items_processed: variantsReleased,
        items_failed: shortShipments,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
    }

    // --- "New Releases" tag cleanup (45 days after street_date) ---
    let newReleasesRemoved = 0;

    for (const workspaceId of workspaceIds) {
      const { data: staleVariants } = await supabase
        .from("warehouse_product_variants")
        .select("product_id, street_date")
        .eq("workspace_id", workspaceId)
        .not("street_date", "is", null);

      if (!staleVariants) continue;

      const staleProductIds = Array.from(
        new Set(
          staleVariants
            .filter((v) => isDaysAfterRelease(v.street_date, 45))
            .map((v) => v.product_id),
        ),
      );

      if (staleProductIds.length === 0) continue;

      const { data: products } = await supabase
        .from("warehouse_products")
        .select("id, shopify_product_id, tags")
        .in("id", staleProductIds)
        .contains("tags", ["New Releases"]);

      for (const product of products ?? []) {
        const tags = (product.tags as string[]) ?? [];
        const updatedTags = tags.filter((t) => t !== "New Releases");

        if (product.shopify_product_id) {
          try {
            await tagsRemove(product.shopify_product_id, ["New Releases"]);
          } catch (err) {
            logger.warn("Failed to remove New Releases tag from Shopify", {
              productId: product.id,
              shopifyProductId: product.shopify_product_id,
              error: String(err),
            });
          }
        }

        await supabase
          .from("warehouse_products")
          .update({ tags: updatedTags, updated_at: new Date().toISOString() })
          .eq("id", product.id);

        newReleasesRemoved++;
      }
    }

    return { variantsReleased, ordersAllocated, shortShipments, newReleasesRemoved };
  },
});

/**
 * Manual single-variant release task.
 *
 * Triggered by manualRelease() server action.
 * Releases exactly one variant instead of running the full scheduled job.
 * Avoids triggering a 300s job to release a single item (HIGH-3 fix).
 */
export const preorderReleaseVariantTask = task({
  id: "preorder-release-variant",
  maxDuration: 60,
  run: async (payload: { variant_id: string; workspace_id: string }) => {
    const supabase = createServiceRoleClient();

    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, product_id, street_date")
      .eq("id", payload.variant_id)
      .single();

    if (!variant) throw new Error(`Variant ${payload.variant_id} not found`);

    return await releaseVariant(supabase, variant, payload.workspace_id, "manual");
  },
});

/**
 * Release a single pre-order variant:
 * 1. Remove "Pre-Orders" tag from Shopify (best-effort)
 * 2. Sync warehouse_products.tags in DB
 * 3. Set is_preorder = false
 * 4. FIFO-allocate orders to available inventory
 * 5. Create review queue item on short shipment
 */
async function releaseVariant(
  supabase: ReturnType<typeof createServiceRoleClient>,
  variant: { id: string; sku: string; product_id: string; street_date: string | null },
  workspaceId: string,
  runId: string,
) {
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("id, shopify_product_id, tags")
    .eq("id", variant.product_id)
    .single();

  // Remove "Pre-Orders" tag from Shopify and sync local DB (GAP-4)
  if (product?.shopify_product_id) {
    try {
      await tagsRemove(product.shopify_product_id, ["Pre-Orders"]);

      const currentTags = (product.tags as string[]) ?? [];
      const updatedTags = currentTags.filter((t) => t !== "Pre-Orders");
      await supabase
        .from("warehouse_products")
        .update({ tags: updatedTags, updated_at: new Date().toISOString() })
        .eq("id", product.id);

      logger.info("releaseVariant: Pre-Orders tag removed", {
        variantId: variant.id,
        sku: variant.sku,
        shopifyProductId: product.shopify_product_id,
      });
    } catch (err) {
      logger.warn("releaseVariant: failed to remove Pre-Orders tag from Shopify", {
        variantId: variant.id,
        sku: variant.sku,
        shopifyProductId: product.shopify_product_id,
        error: String(err),
      });
    }
  }

  // Clear is_preorder flag
  await supabase
    .from("warehouse_product_variants")
    .update({ is_preorder: false, updated_at: new Date().toISOString() })
    .eq("id", variant.id);

  // Get available inventory
  const { data: inventoryLevel } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("workspace_id", workspaceId)
    .eq("sku", variant.sku)
    .single();

  const availableStock = inventoryLevel?.available ?? 0;

  // FIFO pending orders for this SKU
  const { data: pendingOrders } = await supabase
    .from("warehouse_orders")
    .select("id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("is_preorder", true)
    .is("fulfillment_status", null)
    .order("created_at", { ascending: true });

  if (!pendingOrders || pendingOrders.length === 0) {
    return { ordersAllocated: 0, isShortShipment: false };
  }

  const orderIds = pendingOrders.map((o) => o.id);
  const { data: orderItems } = await supabase
    .from("warehouse_order_items")
    .select("order_id, quantity")
    .in("order_id", orderIds)
    .eq("sku", variant.sku);

  const quantityByOrder = new Map<string, number>();
  for (const item of orderItems ?? []) {
    quantityByOrder.set(item.order_id, (quantityByOrder.get(item.order_id) ?? 0) + item.quantity);
  }

  const { data: alreadyAllocated } = await supabase
    .from("warehouse_orders")
    .select("id")
    .in("id", orderIds)
    .eq("fulfillment_status", "ready_to_ship");

  const alreadyAllocatedIds = new Set((alreadyAllocated ?? []).map((o) => o.id));

  const allocationInput = pendingOrders.map((order) => ({
    id: order.id,
    created_at: order.created_at,
    quantity: quantityByOrder.get(order.id) ?? 1,
  }));

  const allocation = allocatePreorders(allocationInput, availableStock, alreadyAllocatedIds);

  if (allocation.allocated.length > 0) {
    const allocatedIds = allocation.allocated.map((a) => a.orderId);
    await supabase
      .from("warehouse_orders")
      .update({ fulfillment_status: "ready_to_ship", updated_at: new Date().toISOString() })
      .in("id", allocatedIds);
  }

  if (allocation.isShortShipment) {
    await supabase.from("warehouse_review_queue").insert({
      workspace_id: workspaceId,
      category: "short_shipment",
      severity: "critical",
      title: `Short shipment: ${variant.sku}`,
      description: `Pre-order release for ${variant.sku} (street date: ${variant.street_date}). ${allocation.totalAllocated} units allocated, ${allocation.totalUnallocated} units short.`,
      metadata: {
        sku: variant.sku,
        variant_id: variant.id,
        available_stock: availableStock,
        allocated_count: allocation.allocated.length,
        unallocated_count: allocation.unallocated.length,
        total_allocated: allocation.totalAllocated,
        total_unallocated: allocation.totalUnallocated,
        run_id: runId,
      },
      group_key: `short_shipment:${variant.sku}`,
      status: "open",
    });
  }

  return {
    ordersAllocated: allocation.allocated.length,
    isShortShipment: allocation.isShortShipment,
  };
}
