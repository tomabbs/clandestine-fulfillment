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
import type { ShopifyLineItem, ShopifyOrder } from "@/lib/clients/shopify-client";
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

/**
 * Upsert one mailorder_orders row per (order × org).
 *
 * A single Clandestine Shopify order may contain products from multiple client
 * orgs. We resolve each line item's org via SKU → variant → product.org_id,
 * group items by org, then insert one row per org so payouts are correctly
 * attributed to each label.
 *
 * Items whose SKU isn't found in the warehouse are attributed to a null org
 * and skipped (no payout row is created for unknown items).
 */
async function upsertMailOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  order: ShopifyOrder,
  workspaceId: string,
): Promise<boolean> {
  const lineItems = order.lineItems.edges.map((e) => e.node);

  // Resolve org_id for every line item via SKU → warehouse_product_variants
  const skus = lineItems.flatMap((li) => (li.sku ? [li.sku as string] : []));
  if (skus.length === 0) return false;

  const { data: variants } = await supabase
    .from("warehouse_product_variants")
    .select("sku, warehouse_products!inner(org_id)")
    .eq("workspace_id", workspaceId)
    .in("sku", skus);

  const skuToOrg = new Map<string, string>();
  for (const v of variants ?? []) {
    const orgId = (v.warehouse_products as unknown as { org_id: string }).org_id;
    if (orgId) skuToOrg.set(v.sku, orgId);
  }

  // Group line items by org (using plain object to avoid Map iteration TS target issues)
  const orgItems: Record<string, ShopifyLineItem[]> = {};
  for (const li of lineItems) {
    const orgId = li.sku ? skuToOrg.get(li.sku as string) : undefined;
    if (!orgId) continue; // Skip items not in the warehouse
    if (!orgItems[orgId]) orgItems[orgId] = [];
    orgItems[orgId].push(li);
  }

  const orgIds = Object.keys(orgItems);
  if (orgIds.length === 0) return false;

  const currency = order.totalPriceSet?.shopMoney?.currencyCode ?? "USD";
  const shippingAddr = order.shippingAddress;
  const customerName = shippingAddr
    ? `${(shippingAddr.firstName as string) ?? ""} ${(shippingAddr.lastName as string) ?? ""}`.trim()
    : null;

  // Total order price (used to split shipping proportionally)
  const orderTotalSubtotal = lineItems.reduce((sum, li) => {
    const price = li.originalUnitPriceSet?.shopMoney?.amount
      ? parseFloat(li.originalUnitPriceSet.shopMoney.amount)
      : 0;
    return sum + price * li.quantity;
  }, 0);
  const orderTotalPrice = order.totalPriceSet?.shopMoney?.amount
    ? parseFloat(order.totalPriceSet.shopMoney.amount)
    : orderTotalSubtotal;
  const orderShipping = Math.max(0, orderTotalPrice - orderTotalSubtotal);

  let anyInserted = false;

  // Insert one row per org — dedup key: (workspace_id, source, external_order_id, org_id)
  for (const orgId of orgIds) {
    const items = orgItems[orgId];
    // CRITICAL INVARIANT: subtotal = sum of this org's items only (excludes shipping)
    // client_payout_amount = subtotal * 0.5 (NOT total_price)
    const subtotal = items.reduce((sum: number, li: ShopifyLineItem) => {
      const price = li.originalUnitPriceSet?.shopMoney?.amount
        ? parseFloat(li.originalUnitPriceSet.shopMoney.amount)
        : 0;
      return sum + price * li.quantity;
    }, 0);

    // Prorate shipping to this org's share of the total order subtotal
    const shippingShare =
      orderTotalSubtotal > 0
        ? (subtotal / orderTotalSubtotal) * orderShipping
        : 0;

        // Fulfillment status from Shopify — "FULFILLED" → "fulfilled", anything else → "unfulfilled"
        const fulfillmentStatus =
          order.displayFulfillmentStatus?.toUpperCase() === "FULFILLED" ? "fulfilled" : "unfulfilled";

        const { error } = await supabase.from("mailorder_orders").upsert(
          {
            workspace_id: workspaceId,
            org_id: orgId,
            source: "clandestine_shopify",
            external_order_id: order.id,
            order_number: order.name,
            customer_name: customerName || order.email,
            customer_email: order.email,
            financial_status: order.displayFinancialStatus?.toLowerCase() ?? "paid",
            fulfillment_status: fulfillmentStatus,
            platform_fulfillment_status: fulfillmentStatus === "fulfilled" ? "confirmed" : "pending",
            subtotal,
            shipping_amount: shippingShare,
            total_price: subtotal + shippingShare,
            currency,
            line_items: items.map((li: ShopifyLineItem) => ({
              sku: li.sku,
              title: li.title,
              variant_title: li.variantTitle,
              quantity: li.quantity,
              price: li.originalUnitPriceSet?.shopMoney?.amount
                ? parseFloat(li.originalUnitPriceSet.shopMoney.amount)
                : null,
            })),
            shipping_address: shippingAddr ?? null,
            // INVARIANT: payout = this org's subtotal * 0.5 (NOT total order price)
            client_payout_amount: subtotal * 0.5,
            client_payout_status: "pending",
            metadata: {
              platform_order_id: order.id,
              platform_order_number: order.name,
              order_total_items: lineItems.length,
              org_item_count: items.length,
            },
            // Use the actual Shopify order creation date, not the import timestamp
            created_at: order.createdAt,
            synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          // ignoreDuplicates: false so re-syncs can update fulfillment status
          { onConflict: "workspace_id,source,external_order_id,org_id", ignoreDuplicates: false },
        );

    if (error) {
      console.error(
        `[mailorder-shopify-sync] Insert failed for order ${order.id} org ${orgId}:`,
        error.message,
      );
    } else {
      anyInserted = true;
    }
  }

  return anyInserted;
}
