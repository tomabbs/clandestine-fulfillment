"use server";

/**
 * Pre-order Server Actions.
 *
 * Rule #48: Heavy work (release logic) fires Trigger tasks, not direct API calls.
 */

import { tasks } from "@trigger.dev/sdk";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { allocatePreorders } from "@/trigger/lib/preorder-allocation";

export async function getPreorderProducts(filters?: { page?: number; pageSize?: number }) {
  const supabase = await createServerSupabaseClient();
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const { data: variants, count } = await supabase
    .from("warehouse_product_variants")
    .select(
      `
      id, sku, title, street_date, is_preorder, product_id,
      warehouse_products!inner(title, org_id, shopify_product_id)
    `,
      { count: "exact" },
    )
    .eq("is_preorder", true)
    .order("street_date", { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (!variants) return { variants: [], total: 0 };

  // Get order counts per variant SKU
  const skus = variants.map((v) => v.sku);
  const { data: orderCounts } = await supabase
    .from("warehouse_order_items")
    .select("sku, order_id")
    .in("sku", skus);

  const countBySku = new Map<string, number>();
  for (const item of orderCounts ?? []) {
    countBySku.set(item.sku, (countBySku.get(item.sku) ?? 0) + 1);
  }

  // Get inventory levels per SKU
  const { data: inventoryLevels } = await supabase
    .from("warehouse_inventory_levels")
    .select("sku, available")
    .in("sku", skus);

  const inventoryBySku = new Map<string, number>();
  for (const level of inventoryLevels ?? []) {
    inventoryBySku.set(level.sku, level.available);
  }

  const enriched = variants.map((v) => {
    const product = v.warehouse_products as unknown as {
      title: string;
      org_id: string;
    };
    const orderCount = countBySku.get(v.sku) ?? 0;
    const available = inventoryBySku.get(v.sku) ?? 0;

    return {
      id: v.id,
      sku: v.sku,
      variantTitle: v.title,
      productTitle: product.title,
      streetDate: v.street_date,
      orderCount,
      availableStock: available,
      isShortRisk: orderCount > available,
    };
  });

  return { variants: enriched, total: count ?? 0 };
}

export async function manualRelease(variantId: string) {
  const handle = await tasks.trigger("preorder-fulfillment", {});
  return { runId: handle.id, variantId };
}

export async function getPreorderAllocationPreview(variantId: string) {
  const supabase = await createServerSupabaseClient();

  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku, street_date")
    .eq("id", variantId)
    .single();

  if (!variant) return { error: "Variant not found" };

  // Get available inventory
  const { data: inventoryLevel } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("sku", variant.sku)
    .single();

  const availableStock = inventoryLevel?.available ?? 0;

  // Get pending pre-orders FIFO
  const { data: pendingOrders } = await supabase
    .from("warehouse_orders")
    .select("id, created_at, order_number, customer_name")
    .eq("is_preorder", true)
    .is("fulfillment_status", null)
    .order("created_at", { ascending: true });

  if (!pendingOrders || pendingOrders.length === 0) {
    return {
      sku: variant.sku,
      streetDate: variant.street_date,
      availableStock,
      orders: [],
      allocation: {
        allocated: [],
        unallocated: [],
        totalAllocated: 0,
        totalUnallocated: 0,
        isShortShipment: false,
      },
    };
  }

  // Get quantities per order
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

  const allocationInput = pendingOrders
    .filter((o) => quantityByOrder.has(o.id))
    .map((order) => ({
      id: order.id,
      created_at: order.created_at,
      quantity: quantityByOrder.get(order.id) ?? 1,
    }));

  const allocation = allocatePreorders(allocationInput, availableStock);

  return {
    sku: variant.sku,
    streetDate: variant.street_date,
    availableStock,
    orders: pendingOrders.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      customerName: o.customer_name,
      quantity: quantityByOrder.get(o.id) ?? 0,
    })),
    allocation,
  };
}
