"use server";

import { z } from "zod/v4";
import { requireClient } from "@/lib/server/auth-context";
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
  cost: z.number().nullable().optional(),
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

function isUnauthorizedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.toLowerCase().includes("unauthorized");
}

// === Inline single-field updates (for editable table cells) ===

const PRODUCT_EDITABLE_FIELDS = ["title", "vendor", "product_type", "status"] as const;
type ProductEditableField = (typeof PRODUCT_EDITABLE_FIELDS)[number];

const VARIANT_EDITABLE_FIELDS = [
  "sku",
  "price",
  "cost",
  "compare_at_price",
  "barcode",
  "format_name",
] as const;
type VariantEditableField = (typeof VARIANT_EDITABLE_FIELDS)[number];

export async function updateProductField(
  productId: string,
  field: string,
  value: string | null,
): Promise<void> {
  await requireAuth();
  if (!PRODUCT_EDITABLE_FIELDS.includes(field as ProductEditableField)) {
    throw new Error(`Field "${field}" is not editable`);
  }
  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("warehouse_products")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("id", productId);
  if (error) throw new Error(`Failed to update ${field}: ${error.message}`);
}

export async function updateVariantField(
  variantId: string,
  field: string,
  value: string | number | null,
): Promise<void> {
  await requireAuth();
  if (!VARIANT_EDITABLE_FIELDS.includes(field as VariantEditableField)) {
    throw new Error(`Field "${field}" is not editable`);
  }
  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("warehouse_product_variants")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("id", variantId);
  if (error) throw new Error(`Failed to update ${field}: ${error.message}`);
}

// === Server Actions ===

/**
 * Search product variants by SKU or title for inbound item selection.
 * Returns variants with their parent product title, format, and current stock.
 */
export async function searchProductVariants(query: string): Promise<
  Array<{
    variantId: string;
    productTitle: string;
    sku: string;
    format: string | null;
    currentStock: number | null;
  }>
> {
  // Autocomplete can fire during initial hydration; fail-soft instead of surfacing server errors.
  try {
    await requireAuth();
  } catch {
    return [];
  }
  if (!query || query.length < 2) return [];

  const serviceClient = createServiceRoleClient();
  const term = `%${query}%`;

  const { data: variants } = await serviceClient
    .from("warehouse_product_variants")
    .select("id, sku, title, format_name, warehouse_products!inner(title)")
    .or(`sku.ilike.${term},title.ilike.${term},warehouse_products.title.ilike.${term}`)
    .limit(20);

  if (!variants) return [];

  // Get inventory levels for matched variants
  const variantIds = variants.map((v) => v.id);
  const { data: levels } = await serviceClient
    .from("warehouse_inventory_levels")
    .select("variant_id, available")
    .in("variant_id", variantIds);

  const stockMap = new Map((levels ?? []).map((l) => [l.variant_id, l.available]));

  return variants.map((v) => {
    const product = v.warehouse_products as unknown as { title: string };
    return {
      variantId: v.id,
      productTitle: product?.title ?? v.title ?? "",
      sku: v.sku,
      format: v.format_name,
      currentStock: stockMap.get(v.id) ?? null,
    };
  });
}

export async function getProducts(rawFilters: ProductFilters) {
  const filters = productFiltersSchema.parse(rawFilters);
  try {
    await requireAuth();
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return {
        products: [],
        total: 0,
        page: filters.page,
        pageSize: filters.pageSize,
      };
    }
    throw error;
  }
  const serviceClient = createServiceRoleClient();

  const offset = (filters.page - 1) * filters.pageSize;

  // Base query with variant + image + inventory joins
  let query = serviceClient
    .from("warehouse_products")
    .select(
      `
      *,
      warehouse_product_variants (id, sku, title, price, cost, format_name, is_preorder, street_date, bandcamp_url),
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
  if (filters.missingCost) {
    products = products.filter((p) => {
      const variants = p.warehouse_product_variants as Array<{ cost: number | null }>;
      return variants?.some((v) => v.cost == null || v.cost === 0);
    });
  }

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
      cost: number | null;
    }>;
    const first = vs[0] ?? null;
    const inventoryTotal = vs.reduce((sum, v) => sum + (inventoryByVariant[v.id] ?? 0), 0);
    return {
      ...p,
      bandcampMappings,
      firstVariantId: first?.id ?? null,
      firstVariantSku: first?.sku ?? null,
      firstVariantPrice: first?.price ?? null,
      firstVariantCost: first?.cost ?? null,
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
  try {
    await requireAuth();
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return {
        totalProducts: 0,
        totalVariants: 0,
        missingCostCount: 0,
      };
    }
    throw error;
  }
  const sc = createServiceRoleClient();
  const { count: totalProducts } = await sc
    .from("warehouse_products")
    .select("id", { count: "exact", head: true });
  const { count: totalVariants } = await sc
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true });
  const { count: missingCostCount } = await sc
    .from("warehouse_product_variants")
    .select("id", { count: "exact", head: true })
    .or("cost.is.null,cost.eq.0");
  return {
    totalProducts: totalProducts ?? 0,
    totalVariants: totalVariants ?? 0,
    missingCostCount: missingCostCount ?? 0,
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
        id, sku, title, price, cost, compare_at_price, barcode, weight, weight_unit,
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
    if (v.cost !== undefined) dbUpdate.cost = v.cost;
    if (v.weight !== undefined) dbUpdate.weight = v.weight;
    if (v.weightUnit !== undefined) dbUpdate.weight_unit = v.weightUnit;
    if (v.barcode !== undefined) dbUpdate.barcode = v.barcode;

    await serviceClient.from("warehouse_product_variants").update(dbUpdate).eq("id", v.id);
  }

  return { success: true };
}

export async function getClientReleases(rawFilters?: { page?: number; pageSize?: 25 | 50 | 100 }) {
  // Use service role client + explicit org filter — never rely on RLS alone
  // because staff users who also have access to the portal would see all orgs.
  let orgId: string;
  try {
    const clientCtx = await requireClient();
    orgId = clientCtx.orgId;
  } catch (error) {
    if (isUnauthorizedError(error)) return { preorders: [], newReleases: [] };
    throw error;
  }

  clientReleasesFiltersSchema.parse(rawFilters ?? {});

  const supabase = createServiceRoleClient();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const SELECT = `
    id, sku, title, street_date, is_preorder,
    warehouse_products!inner (id, title, status, org_id,
      warehouse_product_images (id, src, alt, position)
    ),
    warehouse_inventory_levels (available, committed, incoming)
  `;

  const { data: preorders, error: preorderError } = await supabase
    .from("warehouse_product_variants")
    .select(SELECT)
    .eq("is_preorder", true)
    .eq("warehouse_products.org_id", orgId)
    .order("street_date", { ascending: true });

  if (preorderError) throw new Error(`Failed to fetch pre-orders: ${preorderError.message}`);

  const { data: newReleases, error: releaseError } = await supabase
    .from("warehouse_product_variants")
    .select(SELECT)
    .eq("is_preorder", false)
    .eq("warehouse_products.org_id", orgId)
    .gte("street_date", thirtyDaysAgo)
    .lte("street_date", now.toISOString())
    .order("street_date", { ascending: false });

  if (releaseError) throw new Error(`Failed to fetch new releases: ${releaseError.message}`);

  return { preorders: preorders ?? [], newReleases: newReleases ?? [] };
}
