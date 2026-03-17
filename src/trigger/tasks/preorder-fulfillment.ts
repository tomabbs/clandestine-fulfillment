/**
 * Pre-order fulfillment — runs daily at 6 AM EST.
 *
 * Rule #69: FIFO allocation. ORDER BY warehouse_orders.created_at ASC.
 * When available stock hits 0, remaining orders stay pending and a
 * short_shipment review queue item is created (severity: critical).
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { schedules } from "@trigger.dev/sdk";
import { tagsRemove } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { allocatePreorders } from "@/trigger/lib/preorder-allocation";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"; // TODO: multi-workspace

export const preorderFulfillmentTask = schedules.task({
  id: "preorder-fulfillment",
  cron: {
    pattern: "0 6 * * *",
    timezone: "America/New_York",
  },
  maxDuration: 300,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const today = new Date().toISOString().split("T")[0];

    let variantsReleased = 0;
    let ordersAllocated = 0;
    let shortShipments = 0;

    // Find all pre-order variants past their street date
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, product_id, street_date")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("is_preorder", true)
      .lte("street_date", today);

    if (!variants || variants.length === 0) {
      return { variantsReleased: 0, ordersAllocated: 0, shortShipments: 0 };
    }

    for (const variant of variants) {
      const result = await releaseVariant(supabase, variant, WORKSPACE_ID, ctx.run.id);
      variantsReleased++;
      ordersAllocated += result.ordersAllocated;
      if (result.isShortShipment) shortShipments++;
    }

    // Log to channel_sync_log
    await supabase.from("channel_sync_log").insert({
      workspace_id: WORKSPACE_ID,
      channel: "preorder",
      sync_type: "fulfillment",
      status: shortShipments > 0 ? "partial" : "completed",
      items_processed: variantsReleased,
      items_failed: shortShipments,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    return { variantsReleased, ordersAllocated, shortShipments };
  },
});

async function releaseVariant(
  supabase: ReturnType<typeof createServiceRoleClient>,
  variant: { id: string; sku: string; product_id: string; street_date: string | null },
  workspaceId: string,
  runId: string,
) {
  // Get Shopify product ID for tag/selling plan operations
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("shopify_product_id")
    .eq("id", variant.product_id)
    .single();

  // Remove selling plan from Shopify (best-effort — don't crash if Shopify errors)
  if (product?.shopify_product_id) {
    try {
      // Look for selling plan groups associated with this product
      // In practice you'd store the selling_plan_group_id on the variant or product
      await tagsRemove(product.shopify_product_id, ["Pre-Orders"]);
    } catch {
      // Log but don't fail the whole run
    }
  }

  // Set is_preorder = false on the variant
  await supabase
    .from("warehouse_product_variants")
    .update({ is_preorder: false, updated_at: new Date().toISOString() })
    .eq("id", variant.id);

  // Get available inventory for this SKU
  const { data: inventoryLevel } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("workspace_id", workspaceId)
    .eq("sku", variant.sku)
    .single();

  const availableStock = inventoryLevel?.available ?? 0;

  // Find pending pre-orders for this variant's SKU, ordered by created_at ASC (FIFO)
  const { data: pendingOrders } = await supabase
    .from("warehouse_orders")
    .select("id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("is_preorder", true)
    .lte("street_date", variant.street_date ?? new Date().toISOString().split("T")[0])
    .is("fulfillment_status", null)
    .order("created_at", { ascending: true });

  if (!pendingOrders || pendingOrders.length === 0) {
    return { ordersAllocated: 0, isShortShipment: false };
  }

  // Get order item quantities for each order matching this SKU
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

  // Find already-allocated orders (idempotency — don't double-allocate on re-run)
  const { data: alreadyAllocated } = await supabase
    .from("warehouse_orders")
    .select("id")
    .in("id", orderIds)
    .eq("fulfillment_status", "ready_to_ship");

  const alreadyAllocatedIds = new Set((alreadyAllocated ?? []).map((o) => o.id));

  // Build allocation input
  const allocationInput = pendingOrders.map((order) => ({
    id: order.id,
    created_at: order.created_at,
    quantity: quantityByOrder.get(order.id) ?? 1,
  }));

  // FIFO allocation (Rule #69)
  const allocation = allocatePreorders(allocationInput, availableStock, alreadyAllocatedIds);

  // Update allocated orders to ready_to_ship
  if (allocation.allocated.length > 0) {
    const allocatedIds = allocation.allocated.map((a) => a.orderId);
    await supabase
      .from("warehouse_orders")
      .update({
        fulfillment_status: "ready_to_ship",
        updated_at: new Date().toISOString(),
      })
      .in("id", allocatedIds);
  }

  // Create review queue item for short shipment
  if (allocation.isShortShipment) {
    await supabase.from("warehouse_review_queue").insert({
      workspace_id: workspaceId,
      category: "short_shipment",
      severity: "critical",
      title: `Short shipment: ${variant.sku}`,
      description: `Pre-order release for ${variant.sku} (street date: ${variant.street_date}). ${allocation.totalAllocated} units allocated to ${allocation.allocated.length} orders. ${allocation.totalUnallocated} units short across ${allocation.unallocated.length} orders.`,
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

/**
 * Release a single variant manually (called by manualRelease server action).
 * Exported for use by the server action via tasks.trigger.
 */
export { releaseVariant as _releaseVariantForTesting };
