"use server";

/**
 * Pre-order Server Actions.
 *
 * Rule #48: Heavy work (release logic) fires Trigger tasks, not direct API calls.
 */

import { tasks } from "@trigger.dev/sdk";
import {
  classifyBandcampPreorderSignal,
  summarizeBandcampPreorderSignals,
} from "@/lib/server/bandcamp-preorder-dashboard";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { getTodayNY } from "@/lib/shared/preorder-dates";
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

type BandcampMappingSignalRow = {
  id: string;
  variant_id: string;
  created_at: string;
  bandcamp_subdomain: string | null;
  bandcamp_album_title: string | null;
  bandcamp_url: string | null;
  bandcamp_release_date: string | null;
  bandcamp_new_date: string | null;
  bandcamp_is_preorder: boolean | null;
  scrape_status: string | null;
  consecutive_failures: number | null;
};

type VariantPreorderProbe = {
  id: string;
  sku: string | null;
  title: string | null;
  is_preorder: boolean | null;
  street_date: string | null;
};

export async function getBandcampProductDetectionDashboard(filters?: {
  newProductDays?: number;
  limit?: number;
}) {
  const supabase = await createServerSupabaseClient();
  const today = getTodayNY();
  const newProductDays = filters?.newProductDays ?? 30;
  const limit = Math.min(filters?.limit ?? 20, 100);
  const since = new Date(Date.now() - newProductDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: newProducts } = await supabase
    .from("bandcamp_product_mappings")
    .select(
      "id, variant_id, created_at, bandcamp_subdomain, bandcamp_album_title, bandcamp_url, bandcamp_release_date, bandcamp_new_date, bandcamp_is_preorder, scrape_status, consecutive_failures",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  const { data: signalRows } = await supabase
    .from("bandcamp_product_mappings")
    .select(
      "id, variant_id, created_at, bandcamp_subdomain, bandcamp_album_title, bandcamp_url, bandcamp_release_date, bandcamp_new_date, bandcamp_is_preorder, scrape_status, consecutive_failures",
    )
    .or(
      `bandcamp_release_date.gt.${today}T00:00:00Z,bandcamp_new_date.gt.${today},bandcamp_is_preorder.eq.true`,
    )
    .limit(500);

  const allRows = [
    ...((newProducts ?? []) as BandcampMappingSignalRow[]),
    ...((signalRows ?? []) as BandcampMappingSignalRow[]),
  ];
  const variantIds = Array.from(new Set(allRows.map((row) => row.variant_id).filter(Boolean)));
  const variantById = new Map<string, VariantPreorderProbe>();
  for (let i = 0; i < variantIds.length; i += 200) {
    const chunk = variantIds.slice(i, i + 200);
    const { data: variants } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, title, is_preorder, street_date")
      .in("id", chunk);
    for (const variant of (variants ?? []) as VariantPreorderProbe[]) {
      variantById.set(variant.id, variant);
    }
  }

  const signalItems = ((signalRows ?? []) as BandcampMappingSignalRow[]).map((row) => {
    const variant = variantById.get(row.variant_id);
    const signalKind = classifyBandcampPreorderSignal({
      today,
      bandcampReleaseDate: row.bandcamp_release_date,
      bandcampNewDate: row.bandcamp_new_date,
      bandcampIsPreorder: row.bandcamp_is_preorder,
    });
    return {
      id: row.id,
      variantId: row.variant_id,
      sku: variant?.sku ?? null,
      title: row.bandcamp_album_title ?? variant?.title ?? "Untitled Bandcamp item",
      bandcampSubdomain: row.bandcamp_subdomain,
      bandcampUrl: row.bandcamp_url,
      bandcampReleaseDate: row.bandcamp_release_date,
      bandcampNewDate: row.bandcamp_new_date,
      bandcampIsPreorder: row.bandcamp_is_preorder,
      variantIsPreorder: variant?.is_preorder ?? null,
      variantStreetDate: variant?.street_date ?? null,
      scrapeStatus: row.scrape_status,
      consecutiveFailures: row.consecutive_failures ?? 0,
      signalKind,
      dashboardMiss: signalKind === "current_upcoming" && variant?.is_preorder !== true,
    };
  });

  const newProductItems = ((newProducts ?? []) as BandcampMappingSignalRow[]).map((row) => {
    const variant = variantById.get(row.variant_id);
    return {
      id: row.id,
      variantId: row.variant_id,
      sku: variant?.sku ?? null,
      title: row.bandcamp_album_title ?? variant?.title ?? "Untitled Bandcamp item",
      bandcampSubdomain: row.bandcamp_subdomain,
      bandcampUrl: row.bandcamp_url,
      createdAt: row.created_at,
      bandcampReleaseDate: row.bandcamp_release_date,
      bandcampNewDate: row.bandcamp_new_date,
      bandcampIsPreorder: row.bandcamp_is_preorder,
      scrapeStatus: row.scrape_status,
    };
  });

  return {
    today,
    newProductWindowDays: newProductDays,
    newProducts: newProductItems,
    preorderSignals: signalItems,
    summary: {
      newProductsInWindow: newProductItems.length,
      dashboardMisses: signalItems.filter((item) => item.dashboardMiss).length,
      ...summarizeBandcampPreorderSignals(signalItems),
    },
  };
}

export async function manualRelease(variantId: string) {
  const supabase = await createServerSupabaseClient();

  // Fetch workspace_id — required by the task payload
  const { data: variant } = await supabase
    .from("warehouse_product_variants")
    .select("workspace_id")
    .eq("id", variantId)
    .single();

  if (!variant) return { error: "Variant not found" };

  // Trigger single-variant release task (HIGH-3 fix: not the full scheduled job)
  const handle = await tasks.trigger("preorder-release-variant", {
    variant_id: variantId,
    workspace_id: variant.workspace_id,
  });

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
