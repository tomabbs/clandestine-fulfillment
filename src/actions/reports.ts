"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const topSellersFiltersSchema = z.object({
  orgId: z.string().uuid().optional(),
  limit: z.number().int().min(10).max(500).default(100),
});

export type TopSellersFilters = z.infer<typeof topSellersFiltersSchema>;

export interface TopSellerRow {
  rank: number;
  productTitle: string;
  variantTitle: string | null;
  vendor: string | null;
  orgName: string | null;
  orgId: string | null;
  sku: string;
  qtySold: number;
  price: number | null;
  revenue: number;
  imageUrl: string | null;
}

/**
 * Bandcamp quantity_sold is all-time units sold via Bandcamp.
 * We store the latest snapshot in bandcamp_product_mappings.last_quantity_sold.
 */
export async function getTopSellers(
  rawFilters?: TopSellersFilters,
): Promise<TopSellerRow[]> {
  await requireAuth();
  const filters = topSellersFiltersSchema.parse(rawFilters ?? {});
  const serviceClient = createServiceRoleClient();

  let query = serviceClient
    .from("bandcamp_product_mappings")
    .select(
      `
      last_quantity_sold,
      warehouse_product_variants!inner (
        sku, title, price,
        warehouse_products!inner (
          title, vendor, org_id, images,
          organizations!inner ( name )
        )
      )
    `,
    )
    .gt("last_quantity_sold", 0)
    .order("last_quantity_sold", { ascending: false })
    .limit(filters.limit);

  if (filters.orgId) {
    query = query.eq("warehouse_product_variants.warehouse_products.org_id", filters.orgId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch top sellers: ${error.message}`);

  return (data ?? []).map((row, i) => {
    const variant = row.warehouse_product_variants as unknown as {
      sku: string;
      title: string | null;
      price: number | null;
      warehouse_products: {
        title: string;
        vendor: string | null;
        org_id: string | null;
        images: Array<{ src: string }> | null;
        organizations: { name: string } | null;
      };
    };
    const product = variant.warehouse_products;
    const qtySold = row.last_quantity_sold ?? 0;
    const price = variant.price ?? 0;

    return {
      rank: i + 1,
      productTitle: product.title,
      variantTitle: variant.title,
      vendor: product.vendor,
      orgName: product.organizations?.name ?? null,
      orgId: product.org_id,
      sku: variant.sku,
      qtySold,
      price: variant.price,
      revenue: Math.round(qtySold * price * 100) / 100,
      imageUrl: (product.images as Array<{ src: string }> | null)?.[0]?.src ?? null,
    };
  });
}

/**
 * Summary stats for the top sellers page.
 */
export async function getTopSellersSummary(): Promise<{
  totalUnitsSold: number;
  totalRevenue: number;
  productsWithSales: number;
}> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data } = await serviceClient
    .from("bandcamp_product_mappings")
    .select("last_quantity_sold, warehouse_product_variants!inner(price)")
    .gt("last_quantity_sold", 0);

  let totalUnits = 0;
  let totalRevenue = 0;

  for (const row of data ?? []) {
    const qty = row.last_quantity_sold ?? 0;
    const price = (row.warehouse_product_variants as unknown as { price: number | null })?.price ?? 0;
    totalUnits += qty;
    totalRevenue += qty * price;
  }

  return {
    totalUnitsSold: totalUnits,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    productsWithSales: (data ?? []).length,
  };
}
