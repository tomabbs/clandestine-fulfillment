"use server";

import { z } from "zod/v4";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

// === Zod Schemas (Rule #5: Zod for all boundaries) ===

const productFiltersSchema = z.object({
  orgId: z.string().optional(),
  format: z.string().optional(),
  status: z.enum(["active", "draft", "archived"]).optional(),
  search: z.string().optional(),
  missingCost: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(25),
});

export type ProductFilters = z.infer<typeof productFiltersSchema>;

const updateProductSchema = z.object({
  title: z.string().min(1).optional(),
  descriptionHtml: z.string().optional(),
  vendor: z.string().optional(),
  productType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["active", "draft", "archived"]).optional(),
});

const updateVariantSchema = z.object({
  id: z.string().min(1),
  shopifyVariantId: z.string().min(1),
  price: z.string().optional(),
  compareAtPrice: z.string().nullable().optional(),
  weight: z.number().optional(),
  weightUnit: z.string().optional(),
  barcode: z.string().nullable().optional(),
});

const clientReleasesFiltersSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(25),
});

// === Helper ===

async function requireAuth() {
  const supabase = await createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Unauthorized");
  return { supabase, user: userData.user };
}

// === Server Actions ===

export async function getProducts(rawFilters: ProductFilters) {
  await requireAuth();
  const filters = productFiltersSchema.parse(rawFilters);
  const serviceClient = createServiceRoleClient();

  const offset = (filters.page - 1) * filters.pageSize;

  // Base query with variant + image + inventory joins
  let query = serviceClient
    .from("warehouse_products")
    .select(
      `
      *,
      warehouse_product_variants (id, sku, title, price, format_name, is_preorder, street_date, bandcamp_url),
      warehouse_product_images (id, src, alt, position),
      organizations!inner (id, name)
    `,
      { count: "exact" },
    )
    .order("updated_at", { ascending: false })
    .range(offset, offset + filters.pageSize - 1);

  if (filters.orgId) {
    query = query.eq("org_id", filters.orgId);
  }

  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  if (filters.search) {
    // Search by title or SKU via variant
    query = query.or(
      `title.ilike.%${filters.search}%,warehouse_product_variants.sku.ilike.%${filters.search}%`,
    );
  }

  const { data, error, count } = await query;

  if (error) throw new Error(`Failed to fetch products: ${error.message}`);

  let products = data ?? [];
  if (filters.format) {
    products = products.filter((p) => {
      const variants = p.warehouse_product_variants as Array<{ format_name: string | null }>;
      return variants?.some((v) => v.format_name === filters.format);
    });
  }
  // missingCost filter — cost column does not exist in current schema, skip for now
  // TODO: add cost column to warehouse_product_variants if needed

  const allVariantIds = products.flatMap((p) => {
    const vs = p.warehouse_product_variants as Array<{ id: string }>;
    return vs?.map((v) => v.id) ?? [];
  });

  let inventoryByVariant: Record<string, number> = {};
  if (allVariantIds.length > 0) {
    const { data: levels } = await serviceClient
      .from("warehouse_inventory_levels")
      .select("variant_id, available")
      .in("variant_id", allVariantIds);
    if (levels) {
      inventoryByVariant = Object.fromEntries(levels.map((l) => [l.variant_id, l.available ?? 0]));
    }
  }

  let bandcampMappings: Record<string, { bandcamp_url: string | null }> = {};
  if (allVariantIds.length > 0) {
    const { data: mappings } = await serviceClient
      .from("bandcamp_product_mappings")
      .select("variant_id, bandcamp_url")
      .in("variant_id", allVariantIds);
    if (mappings) {
      bandcampMappings = Object.fromEntries(
        mappings.map((m) => [m.variant_id, { bandcamp_url: m.bandcamp_url }]),
      );
    }
  }

  const enrichedProducts = products.map((p) => {
    const vs = (p.warehouse_product_variants ?? []) as Array<{
      id: string;
      sku: string;
      price: number | null;
    }>;
    const first = vs[0] ?? null;
    const inventoryTotal = vs.reduce((sum, v) => sum + (inventoryByVariant[v.id] ?? 0), 0);
    return {
      ...p,
      bandcampMappings,
      firstVariantSku: first?.sku ?? null,
      firstVariantPrice: first?.price ?? null,
      inventoryTotal,
    };
  });

  return {
    products: enrichedProducts,
    total: count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/** Summary stats for catalog page header cards. */
export async function getCatalogStats() {
  await requireAuth();
  const sc = createServiceRoleClient();
  const { count: totalProducts } = await sc
    .from("warehouse_products")
    .select("id", { count: "exact", head: true });
  const { count: totalVariants } = await sc
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true });
  // cost column does not exist in current schema — report 0 for now
  return {
    totalProducts: totalProducts ?? 0,
    totalVariants: totalVariants ?? 0,
    missingCostCount: 0,
  };
}

export async function getProductDetail(productId: string) {
  await requireAuth();

  if (!productId) throw new Error("Product ID is required");

  const serviceClient = createServiceRoleClient();

  // Fetch product with all relations
  const { data: product, error } = await serviceClient
    .from("warehouse_products")
    .select(
      `
      *,
      organizations (id, name),
      warehouse_product_variants (
        id, sku, title, price, compare_at_price, barcode, weight, weight_unit,
        format_name, street_date, is_preorder, shopify_variant_id, bandcamp_url,
        option1_name, option1_value
      ),
      warehouse_product_images (id, src, alt, position)
    `,
    )
    .eq("id", productId)
    .single();

  if (error) throw new Error(`Failed to fetch product: ${error.message}`);
  if (!product) throw new Error("Product not found");

  // Fetch inventory levels for all variants
  const variantIds = (product.warehouse_product_variants as Array<{ id: string }>).map((v) => v.id);

  const { data: inventoryLevels } = await serviceClient
    .from("warehouse_inventory_levels")
    .select("*")
    .in("variant_id", variantIds);

  // Fetch variant location breakdowns
  const { data: variantLocations } = await serviceClient
    .from("warehouse_variant_locations")
    .select("*, warehouse_locations(name, location_type)")
    .in("variant_id", variantIds);

  // Fetch bandcamp mappings for variants
  const { data: bandcampMappings } = await serviceClient
    .from("bandcamp_product_mappings")
    .select("*")
    .in("variant_id", variantIds);

  return {
    ...product,
    inventoryLevels: inventoryLevels ?? [],
    variantLocations: variantLocations ?? [],
    bandcampMappings: bandcampMappings ?? [],
  };
}

// Rule #1: Use productUpdate (NOT productSet) for edits
export async function updateProduct(
  productId: string,
  rawData: {
    title?: string;
    descriptionHtml?: string;
    vendor?: string;
    productType?: string;
    tags?: string[];
    status?: "active" | "draft" | "archived";
  },
) {
  await requireAuth();

  const data = updateProductSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Fetch the product to get its Shopify ID
  const { data: product, error: fetchError } = await serviceClient
    .from("warehouse_products")
    .select("shopify_product_id")
    .eq("id", productId)
    .single();

  if (fetchError || !product) throw new Error("Product not found");

  // Update Shopify if connected
  if (product.shopify_product_id) {
    const { productUpdate: shopifyUpdate } = await import("@/lib/clients/shopify");
    await shopifyUpdate({
      id: product.shopify_product_id,
      ...(data.title !== undefined && { title: data.title }),
      ...(data.descriptionHtml !== undefined && { descriptionHtml: data.descriptionHtml }),
      ...(data.vendor !== undefined && { vendor: data.vendor }),
      ...(data.productType !== undefined && { productType: data.productType }),
      ...(data.tags !== undefined && { tags: data.tags }),
      ...(data.status !== undefined && {
        status: data.status.toUpperCase() as "ACTIVE" | "DRAFT" | "ARCHIVED",
      }),
    });
  }

  // Update local DB
  const dbUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.title !== undefined) dbUpdate.title = data.title;
  if (data.vendor !== undefined) dbUpdate.vendor = data.vendor;
  if (data.productType !== undefined) dbUpdate.product_type = data.productType;
  if (data.tags !== undefined) dbUpdate.tags = data.tags;
  if (data.status !== undefined) dbUpdate.status = data.status;

  const { error: updateError } = await serviceClient
    .from("warehouse_products")
    .update(dbUpdate)
    .eq("id", productId);

  if (updateError) throw new Error(`Failed to update product: ${updateError.message}`);

  return { success: true };
}

// Rule #1: Use productVariantsBulkUpdate (NOT productSet) for variant edits
export async function updateVariants(
  productId: string,
  rawVariants: Array<{
    id: string;
    shopifyVariantId: string;
    price?: string;
    compareAtPrice?: string | null;
    weight?: number;
    weightUnit?: string;
    barcode?: string | null;
  }>,
) {
  await requireAuth();

  const variants = z.array(updateVariantSchema).parse(rawVariants);
  const serviceClient = createServiceRoleClient();

  // Fetch product Shopify ID
  const { data: product, error: fetchError } = await serviceClient
    .from("warehouse_products")
    .select("shopify_product_id")
    .eq("id", productId)
    .single();

  if (fetchError || !product) throw new Error("Product not found");

  // Update Shopify if connected (barcode syncs; weightUnit is local-only)
  if (product.shopify_product_id) {
    const { productVariantsBulkUpdate: shopifyBulkUpdate } = await import("@/lib/clients/shopify");
    await shopifyBulkUpdate(
      product.shopify_product_id,
      variants.map((v) => ({
        id: v.shopifyVariantId,
        ...(v.price !== undefined && { price: v.price }),
        ...(v.compareAtPrice !== undefined && { compareAtPrice: v.compareAtPrice }),
        ...(v.weight !== undefined && { weight: v.weight }),
        ...(v.barcode !== undefined && { barcode: v.barcode }),
      })),
    );
  }

  // Update local DB per variant
  for (const v of variants) {
    const dbUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (v.price !== undefined) dbUpdate.price = Number.parseFloat(v.price);
    if (v.compareAtPrice !== undefined) {
      dbUpdate.compare_at_price =
        v.compareAtPrice !== null ? Number.parseFloat(v.compareAtPrice) : null;
    }
    if (v.weight !== undefined) dbUpdate.weight = v.weight;
    if (v.weightUnit !== undefined) dbUpdate.weight_unit = v.weightUnit;
    if (v.barcode !== undefined) dbUpdate.barcode = v.barcode;

    await serviceClient.from("warehouse_product_variants").update(dbUpdate).eq("id", v.id);
  }

  return { success: true };
}

export async function getClientReleases(rawFilters?: { page?: number; pageSize?: 25 | 50 | 100 }) {
  const { supabase } = await requireAuth();
  // Validate filters (pagination reserved for future use)
  clientReleasesFiltersSchema.parse(rawFilters ?? {});

  // RLS automatically scopes to client's org via anon key
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch pre-orders
  const { data: preorders, error: preorderError } = await supabase
    .from("warehouse_product_variants")
    .select(
      `
      id, sku, title, street_date, is_preorder,
      warehouse_products!inner (id, title, status, org_id,
        warehouse_product_images (id, src, alt, position)
      ),
      warehouse_inventory_levels (available, committed, incoming)
    `,
    )
    .eq("is_preorder", true)
    .order("street_date", { ascending: true });

  if (preorderError) throw new Error(`Failed to fetch pre-orders: ${preorderError.message}`);

  // Fetch new releases (street_date within last 30 days)
  const { data: newReleases, error: releaseError } = await supabase
    .from("warehouse_product_variants")
    .select(
      `
      id, sku, title, street_date, is_preorder,
      warehouse_products!inner (id, title, status, org_id,
        warehouse_product_images (id, src, alt, position)
      ),
      warehouse_inventory_levels (available, committed, incoming)
    `,
    )
    .eq("is_preorder", false)
    .gte("street_date", thirtyDaysAgo)
    .lte("street_date", now.toISOString())
    .order("street_date", { ascending: false });

  if (releaseError) throw new Error(`Failed to fetch new releases: ${releaseError.message}`);

  return {
    preorders: preorders ?? [],
    newReleases: newReleases ?? [],
  };
}
