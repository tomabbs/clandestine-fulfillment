"use server";

import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";

// === Types ===

interface InventoryFilters {
  orgId?: string;
  format?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

interface InventoryRow {
  variantId: string;
  sku: string;
  productTitle: string;
  variantTitle: string | null;
  orgId: string | null;
  orgName: string | null;
  formatName: string | null;
  available: number;
  committed: number;
  incoming: number;
  imageSrc: string | null;
  bandcampUrl: string | null;
  status: string;
}

interface InventoryListResult {
  rows: InventoryRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface InventoryDetailResult {
  level: {
    sku: string;
    available: number;
    committed: number;
    incoming: number;
  };
  locations: Array<{
    locationId: string;
    locationName: string;
    locationType: string;
    quantity: number;
  }>;
  recentActivity: Array<{
    id: string;
    delta: number;
    source: string;
    correlationId: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>;
  bandcampUrl: string | null;
}

// === Server Actions ===

/**
 * Query warehouse_inventory_levels JOIN warehouse_product_variants JOIN warehouse_products.
 * Paginated, filterable by org, format, status.
 * Queries POSTGRES not Redis (Redis is for per-SKU realtime, not paginated table views).
 */
export async function getInventoryLevels(
  filters: InventoryFilters = {},
): Promise<InventoryListResult> {
  const supabase = await createServerSupabaseClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const offset = (page - 1) * pageSize;

  // Build query: inventory_levels → variants → products → orgs
  let query = supabase.from("warehouse_inventory_levels").select(
    `
      id,
      variant_id,
      sku,
      available,
      committed,
      incoming,
      warehouse_product_variants!inner (
        id,
        product_id,
        title,
        format_name,
        bandcamp_url,
        warehouse_products!inner (
          id,
          title,
          status,
          org_id,
          images,
          organizations!inner (
            id,
            name
          )
        )
      )
    `,
    { count: "exact" },
  );

  if (filters.orgId) {
    query = query.eq("warehouse_product_variants.warehouse_products.org_id", filters.orgId);
  }
  if (filters.format) {
    query = query.eq("warehouse_product_variants.format_name", filters.format);
  }
  if (filters.status) {
    query = query.eq("warehouse_product_variants.warehouse_products.status", filters.status);
  }
  if (filters.search) {
    query = query.or(
      `sku.ilike.%${filters.search}%,warehouse_product_variants.warehouse_products.title.ilike.%${filters.search}%`,
    );
  }

  query = query.range(offset, offset + pageSize - 1).order("sku", { ascending: true });

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch inventory levels: ${error.message}`);
  }

  const rows: InventoryRow[] = (data ?? []).map((row: Record<string, unknown>) => {
    const variant = row.warehouse_product_variants as Record<string, unknown>;
    const product = variant.warehouse_products as Record<string, unknown>;
    const org = product.organizations as Record<string, unknown>;
    const images = product.images as Array<Record<string, unknown>>;
    const firstImage = images?.[0];

    return {
      variantId: variant.id as string,
      sku: row.sku as string,
      productTitle: product.title as string,
      variantTitle: variant.title as string | null,
      orgId: product.org_id as string | null,
      orgName: org?.name as string | null,
      formatName: variant.format_name as string | null,
      available: row.available as number,
      committed: row.committed as number,
      incoming: row.incoming as number,
      imageSrc: (firstImage?.src as string) ?? null,
      bandcampUrl: variant.bandcamp_url as string | null,
      status: product.status as string,
    };
  });

  return {
    rows,
    total: count ?? 0,
    page,
    pageSize,
  };
}

/**
 * Manual inventory adjustment. Calls recordInventoryChange with source='manual'.
 * Generates correlationId from user + timestamp.
 */
export async function adjustInventory(
  sku: string,
  delta: number,
  reason: string,
): Promise<{ success: boolean; newQuantity: number | null }> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Get workspace_id from user record
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("workspace_id")
    .eq("auth_user_id", user.id)
    .single();
  if (userError || !userData) throw new Error("Failed to resolve workspace");

  const correlationId = `manual:${user.id}:${Date.now()}`;

  const result = await recordInventoryChange({
    workspaceId: userData.workspace_id,
    sku,
    delta,
    source: "manual",
    correlationId,
    metadata: { reason, adjusted_by: user.id },
  });

  return { success: result.success, newQuantity: result.newQuantity };
}

/**
 * Single SKU detail: warehouse level, locations, recent activity.
 */
export async function getInventoryDetail(sku: string): Promise<InventoryDetailResult> {
  const supabase = await createServerSupabaseClient();

  // Fetch inventory level
  const { data: levelData, error: levelError } = await supabase
    .from("warehouse_inventory_levels")
    .select("sku, available, committed, incoming, variant_id")
    .eq("sku", sku)
    .single();

  if (levelError || !levelData) {
    throw new Error(`Inventory level not found for SKU: ${sku}`);
  }

  // Fetch variant for bandcamp_url
  const { data: variantData } = await supabase
    .from("warehouse_product_variants")
    .select("bandcamp_url")
    .eq("id", levelData.variant_id)
    .single();

  // Fetch locations
  const { data: locationData } = await supabase
    .from("warehouse_variant_locations")
    .select(
      `
      quantity,
      location_id,
      warehouse_locations!inner (
        id,
        name,
        location_type
      )
    `,
    )
    .eq("variant_id", levelData.variant_id);

  const locations = (locationData ?? []).map((loc: Record<string, unknown>) => {
    const wl = loc.warehouse_locations as Record<string, unknown>;
    return {
      locationId: loc.location_id as string,
      locationName: wl.name as string,
      locationType: wl.location_type as string,
      quantity: loc.quantity as number,
    };
  });

  // Fetch recent activity (last 20)
  const { data: activityData } = await supabase
    .from("warehouse_inventory_activity")
    .select("id, delta, source, correlation_id, created_at, metadata")
    .eq("sku", sku)
    .order("created_at", { ascending: false })
    .limit(20);

  const recentActivity = (activityData ?? []).map((a: Record<string, unknown>) => ({
    id: a.id as string,
    delta: a.delta as number,
    source: a.source as string,
    correlationId: a.correlation_id as string,
    createdAt: a.created_at as string,
    metadata: a.metadata as Record<string, unknown>,
  }));

  return {
    level: {
      sku: levelData.sku,
      available: levelData.available,
      committed: levelData.committed,
      incoming: levelData.incoming,
    },
    locations,
    recentActivity,
    bandcampUrl: variantData?.bandcamp_url ?? null,
  };
}
