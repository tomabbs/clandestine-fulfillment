"use server";

import { z } from "zod/v4";
import { requireStaff } from "@/lib/server/auth-context";
import { commitOrderItems, releaseOrderItems } from "@/lib/server/inventory-commitments";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const labelOrderItemSchema = z.object({
  sku: z.string().trim().min(1).max(255),
  quantity: z.number().int().min(1).max(10_000),
});

const createLabelOrderSchema = z.object({
  orgId: z.string().uuid(),
  orderNumber: z.string().trim().max(120).optional(),
  customerName: z.string().trim().max(200).optional(),
  customerEmail: z.string().trim().email().optional(),
  note: z.string().trim().max(2_000).optional(),
  items: z.array(labelOrderItemSchema).min(1).max(200),
});

const orderIdSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500).optional(),
});

export interface LabelOrderResult {
  orderId: string;
  orderNumber: string;
  committedCount: number;
  decrementedCount: number;
}

export async function createLabelOrder(input: {
  orgId: string;
  orderNumber?: string;
  customerName?: string;
  customerEmail?: string;
  note?: string;
  items: Array<{ sku: string; quantity: number }>;
}): Promise<LabelOrderResult> {
  const { userId, workspaceId } = await requireStaff();
  const validated = createLabelOrderSchema.parse(input);
  const supabase = createServiceRoleClient();

  const aggregated = aggregateItems(validated.items);
  const skus = aggregated.map((item) => item.sku);

  const { data: variantRows, error: variantError } = await supabase
    .from("warehouse_product_variants")
    .select(
      "id, sku, title, price, warehouse_inventory_levels(available), warehouse_products!inner(org_id, title)",
    )
    .eq("workspace_id", workspaceId)
    .in("sku", skus);
  if (variantError) throw new Error(`Failed to load label order SKUs: ${variantError.message}`);

  const variantsBySku = new Map<string, VariantForOrder>();
  for (const row of variantRows ?? []) {
    const product = Array.isArray(row.warehouse_products)
      ? row.warehouse_products[0]
      : row.warehouse_products;
    const level = Array.isArray(row.warehouse_inventory_levels)
      ? row.warehouse_inventory_levels[0]
      : row.warehouse_inventory_levels;
    if (product?.org_id !== validated.orgId) continue;
    variantsBySku.set(row.sku, {
      id: row.id,
      sku: row.sku,
      title: row.title ?? product?.title ?? row.sku,
      productTitle: product?.title ?? row.sku,
      price: row.price == null ? null : Number(row.price),
      available: level?.available ?? 0,
    });
  }

  const missing = skus.filter((sku) => !variantsBySku.has(sku));
  if (missing.length > 0) {
    throw new Error(`Unknown or wrong-label SKUs for label order: ${missing.join(", ")}`);
  }

  const insufficient = aggregated.filter((item) => {
    const variant = variantsBySku.get(item.sku);
    return variant && variant.available < item.quantity;
  });
  if (insufficient.length > 0) {
    throw new Error(
      `Insufficient inventory for label order: ${insufficient
        .map(
          (item) =>
            `${item.sku} requested ${item.quantity}, available ${variantsBySku.get(item.sku)?.available ?? 0}`,
        )
        .join("; ")}`,
    );
  }

  const lineItemsJson = aggregated.map((item) => {
    const variant = variantsBySku.get(item.sku);
    return {
      sku: item.sku,
      quantity: item.quantity,
      title: variant?.title ?? item.sku,
      variant_id: variant?.id ?? null,
      price: variant?.price ?? null,
    };
  });

  const orderNumber =
    validated.orderNumber || `LABEL-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
  const totalPrice = lineItemsJson.reduce(
    (sum, item) => sum + Number(item.price ?? 0) * item.quantity,
    0,
  );

  const { data: order, error: orderError } = await supabase
    .from("warehouse_orders")
    .insert({
      workspace_id: workspaceId,
      org_id: validated.orgId,
      order_number: orderNumber,
      external_order_id: `label_order:${orderNumber}`,
      source: "label_order",
      customer_name: validated.customerName ?? "Label order",
      customer_email: validated.customerEmail ?? null,
      financial_status: "paid",
      fulfillment_status: "submitted",
      total_price: totalPrice,
      currency: "USD",
      line_items: lineItemsJson,
      tags: ["label_order"],
      identity_resolution_status: "manual_label_order",
      identity_resolution_notes: {
        created_by_user_id: userId,
        note: validated.note ?? null,
        lifecycle: "submitted",
      },
    })
    .select("id, order_number")
    .single();
  if (orderError || !order) throw new Error(`Failed to create label order: ${orderError?.message}`);

  const itemRows = aggregated.map((item) => {
    const variant = variantsBySku.get(item.sku);
    return {
      order_id: order.id,
      workspace_id: workspaceId,
      sku: item.sku,
      quantity: item.quantity,
      price: variant?.price ?? null,
      title: variant?.productTitle ?? item.sku,
      variant_title: variant?.title ?? null,
      fulfilled_quantity: 0,
    };
  });
  const { data: insertedItems, error: itemsError } = await supabase
    .from("warehouse_order_items")
    .insert(itemRows)
    .select("id, sku, quantity");
  if (itemsError) throw new Error(`Failed to create label order items: ${itemsError.message}`);

  const commitResult = await commitOrderItems({
    workspaceId,
    orderId: order.id,
    items: aggregated.map((item) => ({ sku: item.sku, qty: item.quantity })),
    metadata: { source: "label_order", created_by_user_id: userId },
  });

  let decrementedCount = 0;
  for (const item of insertedItems ?? []) {
    const result = await recordInventoryChange({
      workspaceId,
      sku: item.sku,
      delta: -item.quantity,
      source: "label_order",
      correlationId: `label-order:${order.id}:${item.id}`,
      metadata: {
        action: "create",
        order_id: order.id,
        order_number: order.order_number,
        warehouse_order_item_id: item.id,
        created_by_user_id: userId,
      },
    });
    if (!result.success) throw new Error(`Failed to decrement label order SKU ${item.sku}`);
    if (!result.alreadyProcessed) decrementedCount++;
  }

  return {
    orderId: order.id,
    orderNumber: order.order_number,
    committedCount: commitResult.inserted,
    decrementedCount,
  };
}

export async function fulfillLabelOrder(input: { orderId: string; reason?: string }): Promise<{
  success: true;
  releasedCount: number;
}> {
  const { workspaceId, userId } = await requireStaff();
  const { orderId, reason } = orderIdSchema.parse(input);
  const supabase = createServiceRoleClient();
  const order = await loadLabelOrder(supabase, workspaceId, orderId);
  if (order.fulfillment_status === "cancelled" || order.fulfillment_status === "voided") {
    throw new Error("Cancelled label orders cannot be fulfilled");
  }
  if (order.fulfillment_status === "fulfilled") {
    return { success: true, releasedCount: 0 };
  }

  const release = await releaseOrderItems({
    workspaceId,
    orderId,
    reason: reason ?? "label_order_fulfilled",
  });

  const { error } = await supabase
    .from("warehouse_orders")
    .update({
      fulfillment_status: "fulfilled",
      updated_at: new Date().toISOString(),
      identity_resolution_notes: {
        ...(order.identity_resolution_notes ?? {}),
        lifecycle: "fulfilled",
        fulfilled_by_user_id: userId,
        fulfilled_reason: reason ?? null,
      },
    })
    .eq("id", orderId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`Failed to fulfill label order: ${error.message}`);

  return { success: true, releasedCount: release.released };
}

export async function voidLabelOrder(input: { orderId: string; reason?: string }): Promise<{
  success: true;
  releasedCount: number;
  recreditedCount: number;
}> {
  const { workspaceId, userId } = await requireStaff();
  const { orderId, reason } = orderIdSchema.parse(input);
  const supabase = createServiceRoleClient();
  const order = await loadLabelOrder(supabase, workspaceId, orderId);
  if (order.fulfillment_status === "cancelled" || order.fulfillment_status === "voided") {
    return { success: true, releasedCount: 0, recreditedCount: 0 };
  }
  if (order.fulfillment_status === "fulfilled") {
    throw new Error("Fulfilled label orders require a correction order, not void");
  }

  const { data: items, error: itemsError } = await supabase
    .from("warehouse_order_items")
    .select("id, sku, quantity")
    .eq("order_id", orderId)
    .eq("workspace_id", workspaceId);
  if (itemsError) throw new Error(`Failed to load label order items: ${itemsError.message}`);

  const release = await releaseOrderItems({
    workspaceId,
    orderId,
    reason: reason ?? "label_order_voided",
  });

  let recreditedCount = 0;
  for (const item of items ?? []) {
    if (!item.sku || !item.quantity || item.quantity <= 0) continue;
    const result = await recordInventoryChange({
      workspaceId,
      sku: item.sku,
      delta: item.quantity,
      source: "label_order",
      correlationId: `label-order-void:${orderId}:${item.id}`,
      metadata: {
        action: "void",
        order_id: orderId,
        order_number: order.order_number,
        warehouse_order_item_id: item.id,
        reason: reason ?? null,
        voided_by_user_id: userId,
      },
    });
    if (!result.success) throw new Error(`Failed to recredit label order SKU ${item.sku}`);
    if (!result.alreadyProcessed) recreditedCount++;
  }

  const { error } = await supabase
    .from("warehouse_orders")
    .update({
      fulfillment_status: "cancelled",
      updated_at: new Date().toISOString(),
      identity_resolution_notes: {
        ...(order.identity_resolution_notes ?? {}),
        lifecycle: "voided",
        voided_by_user_id: userId,
        void_reason: reason ?? null,
      },
    })
    .eq("id", orderId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`Failed to void label order: ${error.message}`);

  return { success: true, releasedCount: release.released, recreditedCount };
}

type VariantForOrder = {
  id: string;
  sku: string;
  title: string;
  productTitle: string;
  price: number | null;
  available: number;
};

function aggregateItems(items: Array<{ sku: string; quantity: number }>): Array<{
  sku: string;
  quantity: number;
}> {
  const aggregated = new Map<string, number>();
  for (const item of items) {
    const sku = item.sku.trim();
    aggregated.set(sku, (aggregated.get(sku) ?? 0) + item.quantity);
  }
  return Array.from(aggregated.entries()).map(([sku, quantity]) => ({ sku, quantity }));
}

async function loadLabelOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  orderId: string,
): Promise<{
  id: string;
  order_number: string;
  source: string;
  fulfillment_status: string | null;
  identity_resolution_notes: Record<string, unknown> | null;
}> {
  const { data: order, error } = await supabase
    .from("warehouse_orders")
    .select("id, order_number, source, fulfillment_status, identity_resolution_notes")
    .eq("id", orderId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || !order) throw new Error(`Label order not found: ${error?.message ?? orderId}`);
  if (order.source !== "label_order") throw new Error("Order is not a label order");
  return order as {
    id: string;
    order_number: string;
    source: string;
    fulfillment_status: string | null;
    identity_resolution_notes: Record<string, unknown> | null;
  };
}
