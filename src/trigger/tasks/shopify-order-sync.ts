/**
 * Shopify order sync — cron every 30 minutes.
 *
 * Same cursor pattern as shopify-sync (Rule #46).
 * Matches orders to orgs via line item SKU → variant → product.org_id.
 * Splits orders across multiple orgs if needed.
 * Detects pre-orders via variant.is_preorder.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { schedules } from "@trigger.dev/sdk";
import type { ShopifyLineItem, ShopifyOrder } from "@/lib/clients/shopify-client";
import { fetchOrders } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"; // TODO: multi-workspace
const OVERLAP_MINUTES = 2;
const PAGE_SIZE = 50;

export interface OrgLineItems {
  orgId: string;
  lineItems: ShopifyLineItem[];
  isPreorder: boolean;
  streetDate: string | null;
}

/**
 * Given line items and a SKU-to-org lookup, group them by org.
 * Pure function for testability.
 */
export function groupLineItemsByOrg(
  lineItems: ShopifyLineItem[],
  skuToOrg: Map<string, { orgId: string; isPreorder: boolean; streetDate: string | null }>,
): OrgLineItems[] {
  const grouped = new Map<string, OrgLineItems>();

  for (const li of lineItems) {
    if (!li.sku) continue;
    const info = skuToOrg.get(li.sku);
    if (!info) continue;

    let group = grouped.get(info.orgId);
    if (!group) {
      group = { orgId: info.orgId, lineItems: [], isPreorder: false, streetDate: null };
      grouped.set(info.orgId, group);
    }

    group.lineItems.push(li);

    if (info.isPreorder) {
      group.isPreorder = true;
      if (info.streetDate && (!group.streetDate || info.streetDate > group.streetDate)) {
        group.streetDate = info.streetDate;
      }
    }
  }

  return Array.from(grouped.values());
}

export const shopifyOrderSyncTask = schedules.task({
  id: "shopify-order-sync",
  cron: "*/30 * * * *",
  maxDuration: 300,
  run: async (_payload, { ctx: _ctx }) => {
    const supabase = createServiceRoleClient();

    // Load sync cursor
    const { data: syncState } = await supabase
      .from("warehouse_sync_state")
      .select("*")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("sync_type", "shopify_orders")
      .single();

    let updatedAtMin: string | null = null;
    if (syncState?.last_sync_cursor) {
      const cursor = new Date(syncState.last_sync_cursor);
      cursor.setMinutes(cursor.getMinutes() - OVERLAP_MINUTES);
      updatedAtMin = cursor.toISOString();
    }

    const syncStartedAt = new Date().toISOString();
    let totalOrders = 0;
    let latestUpdatedAt = syncState?.last_sync_cursor ?? null;
    let cursor: string | null = null;
    let hasNextPage = true;

    try {
      while (hasNextPage) {
        const { orders, pageInfo } = await fetchOrders({
          first: PAGE_SIZE,
          after: cursor,
          updatedAtMin,
        });

        if (orders.length === 0) break;

        for (const order of orders) {
          const count = await upsertOrder(supabase, order, WORKSPACE_ID);
          totalOrders += count;

          if (order.updatedAt && (!latestUpdatedAt || order.updatedAt > latestUpdatedAt)) {
            latestUpdatedAt = order.updatedAt;
          }
        }

        cursor = pageInfo.endCursor;
        hasNextPage = pageInfo.hasNextPage;
      }

      // Update sync cursor
      await supabase.from("warehouse_sync_state").upsert(
        {
          workspace_id: WORKSPACE_ID,
          sync_type: "shopify_orders",
          last_sync_cursor: latestUpdatedAt ?? syncStartedAt,
          last_sync_wall_clock: syncStartedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,sync_type" },
      );

      await supabase.from("channel_sync_log").insert({
        workspace_id: WORKSPACE_ID,
        channel: "shopify",
        sync_type: "order_sync",
        status: "completed",
        items_processed: totalOrders,
        started_at: syncStartedAt,
        completed_at: new Date().toISOString(),
      });

      return { orders: totalOrders };
    } catch (error) {
      await supabase.from("channel_sync_log").insert({
        workspace_id: WORKSPACE_ID,
        channel: "shopify",
        sync_type: "order_sync",
        status: "failed",
        items_processed: totalOrders,
        error_message: error instanceof Error ? error.message : String(error),
        started_at: syncStartedAt,
        completed_at: new Date().toISOString(),
      });
      throw error;
    }
  },
});

async function upsertOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  order: ShopifyOrder,
  workspaceId: string,
): Promise<number> {
  const lineItems = order.lineItems.edges.map((e) => e.node);
  const skus = lineItems.filter((li) => li.sku).map((li) => li.sku as string);

  if (skus.length === 0) return 0;

  // Look up org + preorder info per SKU
  const { data: variants } = await supabase
    .from("warehouse_product_variants")
    .select("sku, is_preorder, street_date, warehouse_products!inner(org_id)")
    .eq("workspace_id", workspaceId)
    .in("sku", skus);

  const skuToOrg = new Map<
    string,
    { orgId: string; isPreorder: boolean; streetDate: string | null }
  >();
  for (const v of variants ?? []) {
    const product = v.warehouse_products as unknown as { org_id: string };
    skuToOrg.set(v.sku, {
      orgId: product.org_id,
      isPreorder: v.is_preorder ?? false,
      streetDate: v.street_date,
    });
  }

  // Group by org — split order if items belong to multiple orgs
  const orgGroups = groupLineItemsByOrg(lineItems, skuToOrg);
  let created = 0;

  for (const group of orgGroups) {
    // Upsert order per org
    const { data: existingOrder } = await supabase
      .from("warehouse_orders")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_order_id", order.id)
      .eq("org_id", group.orgId)
      .single();

    const orderData = {
      workspace_id: workspaceId,
      org_id: group.orgId,
      shopify_order_id: order.id,
      order_number: order.name,
      customer_name: order.shippingAddress
        ? `${(order.shippingAddress as Record<string, unknown>).firstName ?? ""} ${(order.shippingAddress as Record<string, unknown>).lastName ?? ""}`.trim()
        : order.email,
      customer_email: order.email,
      financial_status: order.displayFinancialStatus,
      fulfillment_status: order.displayFulfillmentStatus,
      total_price: order.totalPriceSet?.shopMoney
        ? Number.parseFloat(order.totalPriceSet.shopMoney.amount)
        : null,
      currency: order.totalPriceSet?.shopMoney?.currencyCode ?? "USD",
      line_items: group.lineItems,
      shipping_address: order.shippingAddress,
      tags: order.tags,
      is_preorder: group.isPreorder,
      street_date: group.streetDate,
      source: "shopify" as const,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existingOrder) {
      await supabase.from("warehouse_orders").update(orderData).eq("id", existingOrder.id);
    } else {
      const { data: newOrder } = await supabase
        .from("warehouse_orders")
        .insert(orderData)
        .select("id")
        .single();

      if (newOrder) {
        const items = group.lineItems
          .filter((li) => li.sku)
          .map((li) => ({
            order_id: newOrder.id,
            workspace_id: workspaceId,
            sku: li.sku as string,
            quantity: li.quantity,
            price: li.originalUnitPriceSet
              ? Number.parseFloat(li.originalUnitPriceSet.shopMoney.amount)
              : null,
            title: li.title,
            variant_title: li.variantTitle,
            shopify_line_item_id: li.id,
          }));

        if (items.length > 0) {
          await supabase.from("warehouse_order_items").insert(items);
        }
      }

      created++;
    }
  }

  return created;
}
