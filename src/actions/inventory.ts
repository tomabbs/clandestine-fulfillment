"use server";

import { z } from "zod/v4";
import { requireAuth, requireClient, requireStaff } from "@/lib/server/auth-context";
import { recordInventoryChange } from "@/lib/server/record-inventory-change";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

const adjustInventorySchema = z.object({
  sku: z.string().min(1),
  delta: z.number().int(),
  reason: z.string().min(1),
});

// === Shared helpers (used by getInventoryDetail and getClientInventoryActivity) ===

const SOURCE_LABELS: Record<string, string> = {
  shopify: "Shopify order",
  bandcamp: "Bandcamp sale",
  squarespace: "Squarespace order",
  woocommerce: "WooCommerce order",
  shipstation: "ShipStation order",
  manual: "Manual adjustment",
  inbound: "Inbound shipment",
  preorder: "Pre-order allocation",
  backfill: "Inventory backfill",
  baseline_import: "Baseline count import",
  label_order: "Label order",
  manual_inventory_count: "Manual inventory count",
  cycle_count: "Cycle count",
  inventory_activate: "Shopify inventory activation",
  reconcile: "Inventory reconciliation",
};

function getSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function getReferenceId(source: string, metadata: Record<string, unknown>): string | null {
  if (source === "inbound" && metadata.inbound_shipment_id) {
    return `Inbound #${String(metadata.inbound_shipment_id).slice(0, 8)}`;
  }
  if (
    (source === "shopify" ||
      source === "woocommerce" ||
      source === "squarespace" ||
      source === "shipstation") &&
    metadata.order_id
  ) {
    return `Order ${metadata.order_id}`;
  }
  if (source === "bandcamp" && metadata.bandcamp_item_id) {
    return `Bandcamp item ${metadata.bandcamp_item_id}`;
  }
  if (source === "manual" && metadata.reason) {
    return String(metadata.reason);
  }
  if (source === "baseline_import" && metadata.cycle_id) {
    return `Baseline ${String(metadata.cycle_id)}`;
  }
  if (source === "label_order" && metadata.order_number) {
    return `Label order ${String(metadata.order_number)}`;
  }
  return null;
}

// === Types ===

interface InventoryFilters {
  orgId?: string;
  format?: string;
  status?: string;
  stockFilter?: "in_stock" | "out_of_stock";
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
  safetyStock: number | null;
  imageSrc: string | null;
  bandcampUrl: string | null;
  status: string;
  // Per-row count session indicators (Sunday UX polish slug ws3-ux-polish-sunday).
  // Lets staff scan the inventory list and see which SKUs are mid-count
  // without expanding the row. Populated for staff queries only — we never
  // surface internal staff workflow state to clients.
  countStatus: "idle" | "count_in_progress" | null;
  countStartedAt: string | null;
  countStartedByName: string | null;
}

interface InventoryListResult {
  rows: InventoryRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface ActivityItem {
  id: string;
  delta: number;
  source: string;
  sourceLabel: string;
  referenceId: string | null;
  previousQuantity: number | null;
  newQuantity: number | null;
  correlationId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
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
  recentActivity: ActivityItem[];
  bandcampUrl: string | null;
}

export interface ActivityFilters {
  sku?: string;
  source?: string;
  dateRange?: "7d" | "30d" | "90d" | "all";
  page?: number;
  pageSize?: number;
}

export interface ActivityRow extends ActivityItem {
  sku: string;
}

export interface ActivityResult {
  rows: ActivityRow[];
  total: number;
  page: number;
  pageSize: number;
}

// === Server Actions ===

/**
 * Query warehouse_inventory_levels JOIN warehouse_product_variants JOIN warehouse_products.
 * Paginated, filterable by org, format, status.
 * Queries POSTGRES not Redis (Redis is for per-SKU realtime, not paginated table views).
 */
export async function getInventoryLevels(
  filters: InventoryFilters = {},
  options: { bypassRls?: boolean } = {},
): Promise<InventoryListResult> {
  const supabase = options.bypassRls
    ? createServiceRoleClient()
    : await createServerSupabaseClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  // Build query: inventory_levels → variants → products → orgs
  // count_status / count_started_at / users:count_started_by drive the
  // per-row "Counting…" indicator (slug ws3-ux-polish-sunday). The embedded
  // users join works because the FK on warehouse_inventory_levels.count_started_by
  // → public.users(id) was added in migration 20260418000001.
  let query = supabase.from("warehouse_inventory_levels").select(
    `
      id,
      variant_id,
      sku,
      available,
      committed,
      incoming,
      safety_stock,
      count_status,
      count_started_at,
      users:count_started_by ( id, name ),
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
  if (filters.stockFilter === "in_stock") {
    query = query.gt("available", 0);
  } else if (filters.stockFilter === "out_of_stock") {
    query = query.eq("available", 0);
  }

  query = query.range(offset, offset + pageSize - 1).order("sku", { ascending: true });

  let { data, error, count } = await query;

  // Some PostgREST versions reject deep nested OR logic trees. Fall back to SKU-only search.
  if (error && filters.search && error.message.includes("failed to parse logic tree")) {
    let fallbackQuery = supabase.from("warehouse_inventory_levels").select(
      `
      id,
      variant_id,
      sku,
      available,
      committed,
      incoming,
      safety_stock,
      count_status,
      count_started_at,
      users:count_started_by ( id, name ),
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
      fallbackQuery = fallbackQuery.eq(
        "warehouse_product_variants.warehouse_products.org_id",
        filters.orgId,
      );
    }
    if (filters.format) {
      fallbackQuery = fallbackQuery.eq("warehouse_product_variants.format_name", filters.format);
    }
    if (filters.status) {
      fallbackQuery = fallbackQuery.eq(
        "warehouse_product_variants.warehouse_products.status",
        filters.status,
      );
    }
    fallbackQuery = fallbackQuery
      .ilike("sku", `%${filters.search}%`)
      .range(offset, offset + pageSize - 1)
      .order("sku", { ascending: true });

    const fallback = await fallbackQuery;
    data = fallback.data;
    error = fallback.error;
    count = fallback.count;
  }

  if (error) {
    throw new Error(`Failed to fetch inventory levels: ${error.message}`);
  }

  const rows: InventoryRow[] = (data ?? []).map((row: Record<string, unknown>) => {
    const variant = row.warehouse_product_variants as Record<string, unknown>;
    const product = variant.warehouse_products as Record<string, unknown>;
    const org = product.organizations as Record<string, unknown>;
    const images = product.images as Array<Record<string, unknown>>;
    const firstImage = images?.[0];
    const startedBy = row.users as { id?: string; name?: string | null } | null;

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
      safetyStock: (row.safety_stock as number | null) ?? null,
      imageSrc: (firstImage?.src as string) ?? null,
      bandcampUrl: variant.bandcamp_url as string | null,
      status: product.status as string,
      countStatus: (row.count_status as InventoryRow["countStatus"] | undefined) ?? null,
      countStartedAt: (row.count_started_at as string | null) ?? null,
      countStartedByName: startedBy?.name ?? null,
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
  const validated = adjustInventorySchema.parse({ sku, delta, reason });
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
    sku: validated.sku,
    delta: validated.delta,
    source: "manual",
    correlationId,
    metadata: { reason: validated.reason, adjusted_by: user.id },
  });

  return { success: result.success, newQuantity: result.newQuantity };
}

/**
 * Single SKU detail: warehouse level, locations, recent activity.
 */
export async function getInventoryDetail(sku: string): Promise<InventoryDetailResult> {
  const { userRecord } = await requireAuth();
  const supabase = await createServerSupabaseClient();

  const { data: levelData, error: levelError } = await supabase
    .from("warehouse_inventory_levels")
    .select("sku, available, committed, incoming, variant_id")
    .eq("sku", sku)
    .eq("workspace_id", userRecord.workspace_id)
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

  // Fetch recent activity (last 20) with enriched fields
  const { data: activityData } = await supabase
    .from("warehouse_inventory_activity")
    .select(
      "id, delta, source, correlation_id, previous_quantity, new_quantity, created_at, metadata",
    )
    .eq("sku", sku)
    .eq("is_synthetic", false)
    .order("created_at", { ascending: false })
    .limit(20);

  const recentActivity: ActivityItem[] = (activityData ?? []).map((a: Record<string, unknown>) => {
    const meta = (a.metadata as Record<string, unknown>) ?? {};
    const src = a.source as string;
    return {
      id: a.id as string,
      delta: a.delta as number,
      source: src,
      sourceLabel: getSourceLabel(src),
      referenceId: getReferenceId(src, meta),
      previousQuantity: a.previous_quantity as number | null,
      newQuantity: a.new_quantity as number | null,
      correlationId: a.correlation_id as string,
      createdAt: a.created_at as string,
      metadata: meta,
    };
  });

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

/**
 * Update a variant's format_name. This is product metadata, not an inventory
 * mutation, so it goes through a direct DB update (not recordInventoryChange).
 */
export async function updateVariantFormat(
  variantId: string,
  formatName: string,
): Promise<{ success: boolean }> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("warehouse_product_variants")
    .update({ format_name: formatName })
    .eq("id", variantId);

  if (error) throw new Error(`Failed to update variant format: ${error.message}`);
  return { success: true };
}

/**
 * Portal-scoped inventory levels.
 *
 * Starts from warehouse_product_variants (NOT warehouse_inventory_levels) so
 * that zero-stock variants without an inventory_levels row are still visible.
 * warehouse_inventory_levels is LEFT-JOINed (no !inner) — available/committed/
 * incoming are coalesced to 0 when the row is absent.
 *
 * Uses service role to bypass RLS — explicit org_id filter on warehouse_products
 * provides data isolation safely. Never leaks cross-org data.
 */
export async function getClientInventoryLevels(
  filters: Omit<InventoryFilters, "orgId"> = {},
): Promise<InventoryListResult> {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  // Start from variants so zero-stock items are included.
  // warehouse_inventory_levels uses regular embedding (no !inner) = LEFT JOIN.
  let query = supabase.from("warehouse_product_variants").select(
    `
      id,
      sku,
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
      ),
      warehouse_inventory_levels (
        available,
        committed,
        incoming,
        safety_stock
      )
    `,
    { count: "exact" },
  );

  // Data isolation: only this client's products.
  query = query.eq("warehouse_products.org_id", orgId);

  if (filters.format) {
    query = query.eq("format_name", filters.format);
  }
  if (filters.status) {
    query = query.eq("warehouse_products.status", filters.status);
  }
  if (filters.search) {
    query = query.or(
      `sku.ilike.%${filters.search}%,warehouse_products.title.ilike.%${filters.search}%`,
    );
  }

  query = query.range(offset, offset + pageSize - 1).order("sku", { ascending: true });

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to fetch client inventory levels: ${error.message}`);
  }

  const rows: InventoryRow[] = (data ?? []).map((row: Record<string, unknown>) => {
    const product = row.warehouse_products as Record<string, unknown>;
    const org = product.organizations as Record<string, unknown>;
    const images = product.images as Array<Record<string, unknown>>;
    const firstImage = images?.[0];
    // LEFT JOIN result: array of 0 or 1 rows
    const levels = row.warehouse_inventory_levels as Array<Record<string, unknown>>;
    const level = levels?.[0] ?? null;

    return {
      variantId: row.id as string,
      sku: row.sku as string,
      productTitle: product.title as string,
      variantTitle: row.title as string | null,
      orgId: product.org_id as string | null,
      orgName: org?.name as string | null,
      formatName: row.format_name as string | null,
      available: (level?.available as number) ?? 0,
      committed: (level?.committed as number) ?? 0,
      incoming: (level?.incoming as number) ?? 0,
      safetyStock: (level?.safety_stock as number | null) ?? null,
      imageSrc: (firstImage?.src as string) ?? null,
      bandcampUrl: row.bandcamp_url as string | null,
      status: product.status as string,
      countStatus: null,
      countStartedAt: null,
      countStartedByName: null,
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
 * Update the safety buffer for a single SKU.
 * Pass null to revert to the workspace default.
 */
export async function updateInventoryBuffer(
  sku: string,
  safetyStock: number | null,
): Promise<{ success: boolean }> {
  const { workspaceId } = await requireStaff();
  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("warehouse_inventory_levels")
    .update({ safety_stock: safetyStock, updated_at: new Date().toISOString() })
    .eq("sku", sku)
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(`Failed to update buffer: ${error.message}`);
  return { success: true };
}

/**
 * Update the workspace-wide default safety buffer (default: 3 units).
 * Individual SKU overrides (set via updateInventoryBuffer) take precedence.
 */
export async function updateWorkspaceDefaultBuffer(
  workspaceId: string,
  defaultSafetyStock: number,
): Promise<{ success: boolean }> {
  const { workspaceId: authWorkspaceId } = await requireStaff();
  if (workspaceId !== authWorkspaceId) throw new Error("Workspace mismatch");

  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("workspaces")
    .update({ default_safety_stock: defaultSafetyStock })
    .eq("id", workspaceId);

  if (error) throw new Error(`Failed to update workspace buffer: ${error.message}`);
  return { success: true };
}

/**
 * Export inventory to CSV. Returns the CSV string for client-side download.
 * Staff-only. Supports all the same filters as getInventoryLevels.
 */
export async function exportInventoryCsv(filters: {
  orgId?: string;
  stockFilter?: "in_stock" | "out_of_stock";
  format?: string;
  status?: string;
  search?: string;
}): Promise<string> {
  await requireStaff();
  const result = await getInventoryLevels(
    { ...filters, page: 1, pageSize: 10000 },
    { bypassRls: true },
  );

  const header = "SKU,Product,Label,Format,Status,Available,Committed,Incoming,Safety Stock";
  const lines = result.rows.map((row) => {
    const safeTitle = `"${(row.productTitle ?? "").replace(/"/g, '""')}"`;
    const safeOrg = `"${(row.orgName ?? "").replace(/"/g, '""')}"`;
    return [
      row.sku,
      safeTitle,
      safeOrg,
      row.formatName ?? "",
      row.status,
      row.available,
      row.committed,
      row.incoming,
      (row as { safetyStock?: number | null }).safetyStock ?? "",
    ].join(",");
  });

  return [header, ...lines].join("\n");
}

// === Client Inventory Activity ===

/**
 * Org-scoped inventory activity feed for the client portal.
 * Uses service role after scoping to the authenticated client's org.
 * Defence-in-depth: RLS policy also blocks cross-org reads.
 *
 * workspace_id is included in the query filter so Postgres uses the
 * idx_inventory_activity_ws_date_sku index (leading edge: workspace_id).
 */
export async function getClientInventoryActivity(
  filters: ActivityFilters = {},
): Promise<ActivityResult> {
  const { orgId, workspaceId } = await requireClient();
  const supabase = createServiceRoleClient();

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const { data: skuRows } = await supabase
    .from("warehouse_inventory_levels")
    .select("sku")
    .eq("org_id", orgId);

  const orgSkus = (skuRows ?? []).map((r) => r.sku);
  if (orgSkus.length === 0) {
    return { rows: [], total: 0, page, pageSize };
  }

  let query = supabase
    .from("warehouse_inventory_activity")
    .select(
      "id, sku, delta, source, correlation_id, previous_quantity, new_quantity, metadata, created_at",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .in("sku", orgSkus)
    .eq("is_synthetic", false)
    .order("created_at", { ascending: false });

  if (filters.sku) {
    query = query.ilike("sku", `%${filters.sku}%`);
  }
  if (filters.source) {
    query = query.eq("source", filters.source);
  }
  if (filters.dateRange && filters.dateRange !== "all") {
    const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "30d" ? 30 : 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", since);
  }

  const { data, count, error } = await query.range(offset, offset + pageSize - 1);
  if (error) throw new Error(`Failed to fetch activity: ${error.message}`);

  const rows: ActivityRow[] = (data ?? []).map((a: Record<string, unknown>) => {
    const meta = (a.metadata as Record<string, unknown>) ?? {};
    const src = a.source as string;
    return {
      id: a.id as string,
      sku: a.sku as string,
      delta: a.delta as number,
      source: src,
      sourceLabel: getSourceLabel(src),
      referenceId: getReferenceId(src, meta),
      previousQuantity: a.previous_quantity as number | null,
      newQuantity: a.new_quantity as number | null,
      correlationId: a.correlation_id as string,
      createdAt: a.created_at as string,
      metadata: meta,
    };
  });

  return { rows, total: count ?? 0, page, pageSize };
}

/**
 * Export the client's inventory activity as CSV.
 * Capped at 2,000 rows — Server Actions run in Vercel Serverless Functions
 * (1 GB RAM, 15s timeout). Building a large CSV string in memory risks OOM.
 * For larger exports, a streaming Route Handler at /api/export-activity is
 * the correct long-term solution.
 */
export async function exportClientInventoryActivity(
  filters: Omit<ActivityFilters, "page" | "pageSize"> = {},
): Promise<string> {
  const { orgId, workspaceId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { data: skuRows } = await supabase
    .from("warehouse_inventory_levels")
    .select("sku")
    .eq("org_id", orgId);

  const orgSkus = (skuRows ?? []).map((r) => r.sku);
  if (orgSkus.length === 0) return "Date,SKU,Change,Before,After,Cause,Reference\n";

  let query = supabase
    .from("warehouse_inventory_activity")
    .select("id, sku, delta, source, previous_quantity, new_quantity, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .in("sku", orgSkus)
    .eq("is_synthetic", false)
    .order("created_at", { ascending: false })
    .limit(2_000);

  if (filters.sku) query = query.ilike("sku", `%${filters.sku}%`);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.dateRange && filters.dateRange !== "all") {
    const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "30d" ? 30 : 90;
    query = query.gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString());
  }

  const { data, error } = await query;
  if (error) throw new Error(`Export failed: ${error.message}`);

  const header = "Date,SKU,Change,Before,After,Cause,Reference";
  const csvRows = (data ?? []).map((a: Record<string, unknown>) => {
    const meta = (a.metadata as Record<string, unknown>) ?? {};
    const src = a.source as string;
    const ref = getReferenceId(src, meta) ?? "";
    return [
      new Date(a.created_at as string).toISOString(),
      a.sku,
      a.delta,
      a.previous_quantity ?? "",
      a.new_quantity ?? "",
      getSourceLabel(src),
      `"${ref.replace(/"/g, '""')}"`,
    ].join(",");
  });

  return [header, ...csvRows].join("\n");
}
