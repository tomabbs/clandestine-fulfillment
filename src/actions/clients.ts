"use server";

import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { CLIENT_ROLES } from "@/lib/shared/constants";
import { parseOnboardingState } from "@/lib/shared/onboarding";

export interface ClientStats {
  id: string;
  name: string;
  slug: string;
  billingEmail: string | null;
  productCount: number;
  variantCount: number;
  shipmentsThisMonth: number;
  lastBillingTotal: number | null;
  stripeStatus: "connected" | "none";
  createdAt: string;
}

export interface GetClientsResult {
  clients: ClientStats[];
  total: number;
  totalProducts: number;
  totalShipmentsThisMonth: number;
  unmatchedShipments: number;
  page: number;
  pageSize: number;
}

export interface ClientPresenceSummary {
  online: boolean;
  onlineCount: number;
  lastSeenAt: string | null;
}

export async function getClients(filters?: {
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<GetClientsResult> {
  // Staff-only — service role bypasses RLS so all orgs are always visible
  // regardless of which session's JWT is present. Admin middleware already
  // gates unauthenticated access; requireStaff() enforces role.
  await requireStaff();
  const supabase = createServiceRoleClient();
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("organizations")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filters?.search) query = query.ilike("name", `%${filters.search}%`);

  const { data: orgs, count } = await query;
  if (!orgs || orgs.length === 0) {
    // Still need unmatched shipments even with no orgs
    const { count: unmatchedCount } = await supabase
      .from("warehouse_shipments")
      .select("id", { count: "exact", head: true })
      .is("org_id", null);

    return {
      clients: [],
      total: 0,
      totalProducts: 0,
      totalShipmentsThisMonth: 0,
      unmatchedShipments: unmatchedCount ?? 0,
      page,
      pageSize,
    };
  }

  const orgIds = orgs.map((o) => o.id);

  // Current month boundaries
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
    999,
  ).toISOString();

  // Batch queries in parallel
  const [productRows, variantRows, shipmentRows, billingRows, unmatchedResult] = await Promise.all([
    // Product counts per org
    supabase.from("warehouse_products").select("org_id").in("org_id", orgIds),
    // Variant counts per org (via product join)
    supabase
      .from("warehouse_product_variants")
      .select("id, warehouse_products!inner(org_id)")
      .in("warehouse_products.org_id", orgIds),
    // Shipments this month per org
    supabase
      .from("warehouse_shipments")
      .select("org_id")
      .in("org_id", orgIds)
      .gte("ship_date", monthStart)
      .lte("ship_date", monthEnd),
    // Latest billing snapshot per org
    supabase
      .from("warehouse_billing_snapshots")
      .select("org_id, grand_total, stripe_invoice_id, created_at")
      .in("org_id", orgIds)
      .order("created_at", { ascending: false }),
    // Unmatched shipments (org_id IS NULL)
    supabase
      .from("warehouse_shipments")
      .select("id", { count: "exact", head: true })
      .is("org_id", null),
  ]);

  // Aggregate product counts
  const productsByOrg = new Map<string, number>();
  for (const p of productRows.data ?? []) {
    productsByOrg.set(p.org_id, (productsByOrg.get(p.org_id) ?? 0) + 1);
  }

  // Aggregate variant counts
  const variantsByOrg = new Map<string, number>();
  for (const v of variantRows.data ?? []) {
    const orgId = (v.warehouse_products as unknown as { org_id: string }).org_id;
    variantsByOrg.set(orgId, (variantsByOrg.get(orgId) ?? 0) + 1);
  }

  // Aggregate shipment counts
  const shipmentsByOrg = new Map<string, number>();
  for (const s of shipmentRows.data ?? []) {
    if (s.org_id) {
      shipmentsByOrg.set(s.org_id, (shipmentsByOrg.get(s.org_id) ?? 0) + 1);
    }
  }

  // Latest billing per org (first occurrence wins since sorted desc)
  const latestBillingByOrg = new Map<
    string,
    { grand_total: number; stripe_invoice_id: string | null }
  >();
  for (const b of billingRows.data ?? []) {
    if (!latestBillingByOrg.has(b.org_id)) {
      latestBillingByOrg.set(b.org_id, {
        grand_total: b.grand_total,
        stripe_invoice_id: b.stripe_invoice_id,
      });
    }
  }

  const clients: ClientStats[] = orgs.map((org) => {
    const billing = latestBillingByOrg.get(org.id);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      billingEmail: org.billing_email,
      productCount: productsByOrg.get(org.id) ?? 0,
      variantCount: variantsByOrg.get(org.id) ?? 0,
      shipmentsThisMonth: shipmentsByOrg.get(org.id) ?? 0,
      lastBillingTotal: billing?.grand_total ?? null,
      stripeStatus: billing?.stripe_invoice_id ? "connected" : "none",
      createdAt: org.created_at,
    };
  });

  let totalProducts = 0;
  let totalShipmentsThisMonth = 0;
  for (const c of clients) {
    totalProducts += c.productCount;
    totalShipmentsThisMonth += c.shipmentsThisMonth;
  }

  return {
    clients,
    total: count ?? 0,
    totalProducts,
    totalShipmentsThisMonth,
    unmatchedShipments: unmatchedResult.count ?? 0,
    page,
    pageSize,
  };
}

export async function getClientPresenceSummary(input: {
  orgIds: string[];
  onlineUserIds?: string[];
}): Promise<{ byOrg: Record<string, ClientPresenceSummary> }> {
  const supabase = await createServerSupabaseClient();
  const orgIds = input.orgIds ?? [];
  const onlineUserIds = new Set(input.onlineUserIds ?? []);

  if (orgIds.length === 0) {
    return { byOrg: {} };
  }

  const { data: users, error } = await supabase
    .from("users")
    .select("id, org_id, role, last_seen_at")
    .in("org_id", orgIds)
    .in("role", [...CLIENT_ROLES]);

  if (error) {
    throw new Error(`Failed to load client presence summary: ${error.message}`);
  }

  const byOrg: Record<string, ClientPresenceSummary> = {};
  for (const orgId of orgIds) {
    byOrg[orgId] = { online: false, onlineCount: 0, lastSeenAt: null };
  }

  for (const user of users ?? []) {
    if (!user.org_id) continue;
    const current = byOrg[user.org_id] ?? { online: false, onlineCount: 0, lastSeenAt: null };

    const isOnline = onlineUserIds.has(user.id);
    if (isOnline) {
      current.online = true;
      current.onlineCount += 1;
    }

    if (user.last_seen_at && (!current.lastSeenAt || user.last_seen_at > current.lastSeenAt)) {
      current.lastSeenAt = user.last_seen_at;
    }

    byOrg[user.org_id] = current;
  }

  return { byOrg };
}

export interface MonthlySales {
  month: string;
  units: number;
  revenue: number;
  cost: number;
  margin_pct: number;
}

export interface ClientSupportHistoryRow {
  id: string;
  subject: string;
  status: string;
  updated_at: string;
  assigned_name: string | null;
  message_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
}

export async function getClientSupportHistory(orgId: string): Promise<ClientSupportHistoryRow[]> {
  const supabase = await createServerSupabaseClient();

  const { data: conversations, error: conversationError } = await supabase
    .from("support_conversations")
    .select(
      "id, subject, status, updated_at, assigned_user:users!support_conversations_assigned_to_fkey(name)",
    )
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (conversationError) {
    throw new Error(`Failed to load support history: ${conversationError.message}`);
  }
  if (!conversations || conversations.length === 0) {
    return [];
  }

  const conversationIds = conversations.map((conversation) => conversation.id);
  const { data: messages, error: messageError } = await supabase
    .from("support_messages")
    .select("conversation_id, body, created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false });

  if (messageError) {
    throw new Error(`Failed to load support messages: ${messageError.message}`);
  }

  const messageStats = new Map<
    string,
    { count: number; lastPreview: string | null; lastAt: string | null }
  >();

  for (const message of messages ?? []) {
    const current = messageStats.get(message.conversation_id) ?? {
      count: 0,
      lastPreview: null,
      lastAt: null,
    };
    current.count += 1;
    if (!current.lastAt || message.created_at > current.lastAt) {
      current.lastAt = message.created_at;
      current.lastPreview = message.body?.slice(0, 140) ?? null;
    }
    messageStats.set(message.conversation_id, current);
  }

  return conversations.map((conversation) => {
    const assignedRaw = conversation.assigned_user as unknown;
    const assignedName = Array.isArray(assignedRaw)
      ? ((assignedRaw[0] as { name?: string } | undefined)?.name ?? null)
      : ((assignedRaw as { name?: string } | null)?.name ?? null);
    const stats = messageStats.get(conversation.id);
    return {
      id: conversation.id,
      subject: conversation.subject,
      status: conversation.status,
      updated_at: conversation.updated_at,
      assigned_name: assignedName,
      message_count: stats?.count ?? 0,
      last_message_preview: stats?.lastPreview ?? null,
      last_message_at: stats?.lastAt ?? null,
    };
  });
}

export async function getClientDetail(orgId: string) {
  const supabase = await createServerSupabaseClient();

  const { data: org } = await supabase.from("organizations").select("*").eq("id", orgId).single();
  if (!org) return null;

  const steps = parseOnboardingState((org.onboarding_state as Record<string, unknown>) ?? null);

  const [products, variants, shipments] = await Promise.all([
    supabase
      .from("warehouse_products")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
    supabase
      .from("warehouse_product_variants")
      .select("id, warehouse_products!inner(org_id)")
      .eq("warehouse_products.org_id", orgId),
    supabase
      .from("warehouse_shipments")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
  ]);

  return {
    org,
    onboardingSteps: steps,
    productCount: products.count ?? 0,
    variantCount: variants.data?.length ?? 0,
    shipmentCount: shipments.count ?? 0,
  };
}

// ─── Tab 1: Products ─────────────────────────────────────────────────────────

export async function getClientProducts(orgId: string, filters?: { search?: string }) {
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_products")
    .select("id, title, vendor, product_type, status, created_at")
    .eq("org_id", orgId)
    .order("title", { ascending: true });

  if (filters?.search) {
    query = query.or(`title.ilike.%${filters.search}%,vendor.ilike.%${filters.search}%`);
  }

  const { data: products } = await query;
  if (!products || products.length === 0) return [];

  const productIds = products.map((p) => p.id);
  const { data: variantRows } = await supabase
    .from("warehouse_product_variants")
    .select("product_id")
    .in("product_id", productIds);

  const variantCounts = new Map<string, number>();
  for (const v of variantRows ?? []) {
    variantCounts.set(v.product_id, (variantCounts.get(v.product_id) ?? 0) + 1);
  }

  return products.map((p) => ({
    ...p,
    variant_count: variantCounts.get(p.id) ?? 0,
  }));
}

// ─── Tab 2: Shipments ────────────────────────────────────────────────────────

export async function getClientShipments(orgId: string, filters?: { status?: string }) {
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("warehouse_shipments")
    .select(
      "id, order_id, tracking_number, carrier, service, ship_date, status, shipping_cost, voided",
    )
    .eq("org_id", orgId)
    .eq("voided", false)
    .order("ship_date", { ascending: false })
    .limit(200);

  if (filters?.status) {
    query = query.eq("status", filters.status);
  }

  const { data: shipmentRows } = await query;
  if (!shipmentRows || shipmentRows.length === 0) return [];

  const orderIds = Array.from(
    new Set(shipmentRows.map((s) => s.order_id).filter(Boolean)),
  ) as string[];
  const orderMap = new Map<string, string>();
  if (orderIds.length > 0) {
    const { data: orders } = await supabase
      .from("warehouse_orders")
      .select("id, order_number")
      .in("id", orderIds);
    for (const o of orders ?? []) {
      if (o.order_number) orderMap.set(o.id, o.order_number);
    }
  }

  return shipmentRows.map((s) => ({
    ...s,
    order_number: s.order_id ? (orderMap.get(s.order_id) ?? null) : null,
  }));
}

// ─── Tab 3: Sales ────────────────────────────────────────────────────────────

export async function getClientSales(orgId: string) {
  const supabase = await createServerSupabaseClient();

  const { data: orders } = await supabase
    .from("warehouse_orders")
    .select("id, total_price, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (!orders || orders.length === 0) {
    return { months: [] as MonthlySales[], totalUnits: 0, totalRevenue: 0 };
  }

  const orderIds = orders.map((o) => o.id);

  const [itemsResult, shipmentsResult] = await Promise.all([
    supabase
      .from("warehouse_order_items")
      .select("order_id, quantity, price")
      .in("order_id", orderIds),
    supabase
      .from("warehouse_shipments")
      .select("ship_date, shipping_cost")
      .eq("org_id", orgId)
      .eq("voided", false),
  ]);

  const monthMap = new Map<string, { units: number; revenue: number; cost: number }>();

  const orderDateMap = new Map<string, string>();
  for (const o of orders) {
    orderDateMap.set(o.id, o.created_at.slice(0, 7));
  }

  for (const item of itemsResult.data ?? []) {
    const month = orderDateMap.get(item.order_id);
    if (!month) continue;
    const entry = monthMap.get(month) ?? { units: 0, revenue: 0, cost: 0 };
    entry.units += item.quantity;
    entry.revenue += (item.price ?? 0) * item.quantity;
    monthMap.set(month, entry);
  }

  for (const s of shipmentsResult.data ?? []) {
    if (!s.ship_date || !s.shipping_cost) continue;
    const month = s.ship_date.slice(0, 7);
    const entry = monthMap.get(month) ?? { units: 0, revenue: 0, cost: 0 };
    entry.cost += Number(s.shipping_cost);
    monthMap.set(month, entry);
  }

  const months: MonthlySales[] = Array.from(monthMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, data]) => ({
      month,
      units: data.units,
      revenue: Math.round(data.revenue * 100) / 100,
      cost: Math.round(data.cost * 100) / 100,
      margin_pct:
        data.revenue > 0
          ? Math.round(((data.revenue - data.cost) / data.revenue) * 10000) / 100
          : 0,
    }));

  const totalUnits = months.reduce((sum, m) => sum + m.units, 0);
  const totalRevenue = Math.round(months.reduce((sum, m) => sum + m.revenue, 0) * 100) / 100;

  return { months, totalUnits, totalRevenue };
}

// ─── Tab 4: Billing ──────────────────────────────────────────────────────────

export async function getClientBilling(orgId: string) {
  const supabase = await createServerSupabaseClient();

  const { data } = await supabase
    .from("warehouse_billing_snapshots")
    .select("id, billing_period, grand_total, status, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  return data ?? [];
}

// ─── Tab 5: Stores ───────────────────────────────────────────────────────────

export async function getClientStores(orgId: string) {
  const supabase = await createServerSupabaseClient();

  // Legacy Bandcamp/ShipStation store entries
  const { data: legacyStores } = await supabase
    .from("warehouse_shipstation_stores")
    .select("id, store_name, marketplace_name, store_id, created_at")
    .eq("org_id", orgId)
    .order("store_name");

  // New OAuth store connections (Shopify, WooCommerce, Squarespace, Discogs)
  const { data: clientConnections } = await supabase
    .from("client_store_connections")
    .select("id, platform, store_url, connection_status, created_at, last_poll_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  return {
    legacy: legacyStores ?? [],
    connections: clientConnections ?? [],
  };
}

// ─── Tab 6: Settings ─────────────────────────────────────────────────────────

export async function getClientSettings(orgId: string) {
  const supabase = await createServerSupabaseClient();

  const [orgResult, portalResult, rulesResult] = await Promise.all([
    supabase.from("organizations").select("*").eq("id", orgId).single(),
    supabase.from("portal_admin_settings").select("settings").eq("org_id", orgId).single(),
    supabase
      .from("warehouse_billing_rules")
      .select("rule_name, rule_type, amount, is_active")
      .eq("is_active", true)
      .order("rule_name"),
  ]);

  return {
    org: orgResult.data,
    portalSettings: (portalResult.data?.settings as Record<string, unknown>) ?? {},
    billingRules: rulesResult.data ?? [],
  };
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export async function createClient(data: { name: string; slug: string; billingEmail?: string }) {
  const supabase = await createServerSupabaseClient();

  // Get workspace ID
  const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!workspace) throw new Error("No workspace found");

  const { data: org, error } = await supabase
    .from("organizations")
    .insert({
      workspace_id: workspace.id,
      name: data.name,
      slug: data.slug,
      billing_email: data.billingEmail ?? null,
      onboarding_state: {},
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create org: ${error.message}`);

  // Create default portal settings
  await supabase.from("portal_admin_settings").insert({
    workspace_id: workspace.id,
    org_id: org.id,
    settings: {},
  });

  return { orgId: org.id };
}

export async function updateClient(
  orgId: string,
  data: Partial<{
    name: string;
    billing_email: string | null;
    pirate_ship_name: string | null;
    shopify_vendor_name: string | null;
    stripe_customer_id: string | null;
    service_type: string | null;
    storage_fee_waived: boolean;
    warehouse_grace_period_ends_at: string | null;
  }>,
) {
  const supabase = await createServerSupabaseClient();
  await supabase.from("organizations").update(data).eq("id", orgId);
  return { success: true };
}

/** Get users linked to this organization (client portal users). */
export async function getClientUsers(orgId: string): Promise<
  Array<{
    id: string;
    email: string | null;
    name: string | null;
    role: string;
    created_at: string;
  }>
> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, email, name, role, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch client users: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    email: string | null;
    name: string | null;
    role: string;
    created_at: string;
  }>;
}

export async function updateOnboardingStep(orgId: string, step: string, completed: boolean) {
  const supabase = await createServerSupabaseClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", orgId)
    .single();

  const state = ((org?.onboarding_state as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  state[step] = completed;

  await supabase.from("organizations").update({ onboarding_state: state }).eq("id", orgId);
  return { success: true };
}

// === Support email mappings per client ===

export async function getClientSupportEmails(orgId: string) {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("support_email_mappings")
    .select("id, email_address, is_active, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

export async function addClientSupportEmail(orgId: string, email: string) {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("support_email_mappings").upsert(
    { workspace_id: workspaceId, email_address: email.toLowerCase().trim(), org_id: orgId, is_active: true },
    { onConflict: "workspace_id,email_address" },
  );
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function removeClientSupportEmail(mappingId: string) {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("support_email_mappings").delete().eq("id", mappingId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
