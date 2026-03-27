/**
 * Mail-order Shopify sync — cron every 30 minutes.
 *
 * Syncs paid orders from the Clandestine Shopify master catalog
 * into mailorder_orders (consignment billing).
 *
 * Source: 'clandestine_shopify'
 * Table:  mailorder_orders (NOT warehouse_orders)
 *
 * CRITICAL INVARIANT:
 *   client_payout_amount = subtotal * 0.5  (NOT total_price)
 *   subtotal = sum of line item prices only (excludes shipping & taxes)
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is minimal.
 */

import { schedules } from "@trigger.dev/sdk";
import type { ShopifyOrder } from "@/lib/clients/shopify-client";
import { fetchOrders } from "@/lib/clients/shopify-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const OVERLAP_MINUTES = 2;
const PAGE_SIZE = 50;

export const mailorderShopifySyncTask = schedules.task({
  id: "mailorder-shopify-sync",
  cron: "*/30 * * * *",
  maxDuration: 840,
  run: async (_payload, { ctx: _ctx }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);

    let totalImported = 0;
    let totalSkipped = 0;

    for (const workspaceId of workspaceIds) {
      // Sync cursor
      const { data: syncState } = await supabase
        .from("warehouse_sync_state")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("sync_type", "mailorder_shopify")
        .single();

      let updatedAtMin: string | null = null;
      if (syncState?.last_sync_cursor) {
        const cursor = new Date(syncState.last_sync_cursor);
        cursor.setMinutes(cursor.getMinutes() - OVERLAP_MINUTES);
        updatedAtMin = cursor.toISOString();
      }

      const syncStartedAt = new Date().toISOString();
      let latestUpdatedAt = syncState?.last_sync_cursor ?? null;
      let pageCursor: string | null = null;
      let hasNextPage = true;

      try {
        while (hasNextPage) {
          const { orders, pageInfo } = await fetchOrders({
            first: PAGE_SIZE,
            after: pageCursor,
            updatedAtMin,
          });

          if (orders.length === 0) break;

          for (const order of orders) {
            // Only sync paid orders
            const isPaid =
              order.displayFinancialStatus === "PAID" || order.displayFinancialStatus === "paid";
            if (!isPaid) {
              totalSkipped++;
              continue;
            }

            const result = await upsertMailOrder(supabase, order, workspaceId);
            if (result) totalImported++;
            else totalSkipped++;

            if (order.updatedAt && (!latestUpdatedAt || order.updatedAt > latestUpdatedAt)) {
              latestUpdatedAt = order.updatedAt;
            }
          }

          pageCursor = pageInfo.endCursor;
          hasNextPage = pageInfo.hasNextPage;
        }

        // Update sync cursor
        await supabase.from("warehouse_sync_state").upsert(
          {
            workspace_id: workspaceId,
            sync_type: "mailorder_shopify",
            last_sync_cursor: latestUpdatedAt ?? syncStartedAt,
            last_sync_wall_clock: syncStartedAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,sync_type" },
        );

        await supabase.from("channel_sync_log").insert({
          workspace_id: workspaceId,
          channel: "shopify",
          sync_type: "mailorder_sync",
          status: "completed",
          items_processed: totalImported,
          started_at: syncStartedAt,
          completed_at: new Date().toISOString(),
        });
      } catch (error) {
        await supabase.from("channel_sync_log").insert({
          workspace_id: workspaceId,
          channel: "shopify",
          sync_type: "mailorder_sync",
          status: "failed",
          items_processed: totalImported,
          error_message: error instanceof Error ? error.message : String(error),
          started_at: syncStartedAt,
          completed_at: new Date().toISOString(),
        });
        throw error;
      }
    }

    return { totalImported, totalSkipped };
  },
});

async function upsertMailOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  order: ShopifyOrder,
  workspaceId: string,
): Promise<boolean> {
  // Skip if already imported
  const { data: existing } = await supabase
    .from("mailorder_orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source", "clandestine_shopify")
    .eq("external_order_id", order.id)
    .single();

  if (existing) return false;

  // Determine org via line item SKU → variant → product.org_id
  const lineItems = order.lineItems.edges.map((e) => e.node);
  const skus = lineItems.filter((li) => li.sku).map((li) => li.sku as string);

  let orgId: string | null = null;
  if (skus.length > 0) {
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("sku, warehouse_products!inner(org_id)")
      .eq("workspace_id", workspaceId)
      .in("sku", skus)
      .limit(1);

    const firstVariant = variants?.[0];
    if (firstVariant) {
      const product = firstVariant.warehouse_products as unknown as { org_id: string };
      orgId = product.org_id;
    }
  }

  if (!orgId) return false;

  // CRITICAL: subtotal = sum of line item prices only (excludes shipping)
  // client_payout_amount = subtotal * 0.5  (NOT total_price)
  const subtotal = lineItems.reduce((sum, li) => {
    const price = li.originalUnitPriceSet?.shopMoney?.amount
      ? parseFloat(li.originalUnitPriceSet.shopMoney.amount)
      : 0;
    return sum + price * li.quantity;
  }, 0);

  const totalPrice = order.totalPriceSet?.shopMoney?.amount
    ? parseFloat(order.totalPriceSet.shopMoney.amount)
    : subtotal;

  const shippingAmount = Math.max(0, totalPrice - subtotal);
  const currency = order.totalPriceSet?.shopMoney?.currencyCode ?? "USD";

  const shippingAddr = order.shippingAddress;
  const customerName = shippingAddr
    ? `${(shippingAddr.firstName as string) ?? ""} ${(shippingAddr.lastName as string) ?? ""}`.trim()
    : null;

  const { error } = await supabase.from("mailorder_orders").insert({
    workspace_id: workspaceId,
    org_id: orgId,
    source: "clandestine_shopify",
    external_order_id: order.id,
    order_number: order.name,
    customer_name: customerName || order.email,
    customer_email: order.email,
    financial_status: order.displayFinancialStatus?.toLowerCase() ?? "paid",
    fulfillment_status: "unfulfilled",
    platform_fulfillment_status: "pending",
    subtotal,
    shipping_amount: shippingAmount,
    total_price: totalPrice,
    currency,
    line_items: lineItems.map((li) => ({
      sku: li.sku,
      title: li.title,
      variant_title: li.variantTitle,
      quantity: li.quantity,
      price: li.originalUnitPriceSet?.shopMoney?.amount
        ? parseFloat(li.originalUnitPriceSet.shopMoney.amount)
        : null,
    })),
    shipping_address: shippingAddr ?? null,
    // INVARIANT: payout = subtotal * 0.5 (NOT total_price * 0.5)
    client_payout_amount: subtotal * 0.5,
    client_payout_status: "pending",
    metadata: {
      platform_order_id: order.id,
      platform_order_number: order.name,
    },
    synced_at: new Date().toISOString(),
  });

  if (error) {
    console.error(`[mailorder-shopify-sync] Insert failed for order ${order.id}:`, error.message);
    return false;
  }

  return true;
}
