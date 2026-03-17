"use server";

import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { parseOnboardingState } from "@/lib/shared/onboarding";

export async function getClients(filters?: { search?: string; page?: number; pageSize?: number }) {
  const supabase = await createServerSupabaseClient();
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
  if (!orgs) return { clients: [], total: 0, page, pageSize };

  const orgIds = orgs.map((o) => o.id);

  // Get counts in parallel
  const [productCounts, _variantCounts, connectionCounts] = await Promise.all([
    supabase.from("warehouse_products").select("org_id").in("org_id", orgIds),
    supabase.from("warehouse_product_variants").select("product_id, workspace_id"),
    supabase
      .from("client_store_connections")
      .select("org_id, connection_status")
      .in("org_id", orgIds),
  ]);

  const productsByOrg = new Map<string, number>();
  for (const p of productCounts.data ?? []) {
    productsByOrg.set(p.org_id, (productsByOrg.get(p.org_id) ?? 0) + 1);
  }

  const activeConnsByOrg = new Map<string, number>();
  for (const c of connectionCounts.data ?? []) {
    if (c.connection_status === "active") {
      activeConnsByOrg.set(c.org_id, (activeConnsByOrg.get(c.org_id) ?? 0) + 1);
    }
  }

  const clients = orgs.map((org) => {
    const steps = parseOnboardingState((org.onboarding_state as Record<string, unknown>) ?? null);
    const completedSteps = steps.filter((s) => s.completed).length;
    const onboardingPct = Math.round((completedSteps / steps.length) * 100);

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      billingEmail: org.billing_email,
      productCount: productsByOrg.get(org.id) ?? 0,
      activeConnections: activeConnsByOrg.get(org.id) ?? 0,
      onboardingPct,
      createdAt: org.created_at,
    };
  });

  return { clients, total: count ?? 0, page, pageSize };
}

export async function getClientDetail(orgId: string) {
  const supabase = await createServerSupabaseClient();

  const { data: org } = await supabase.from("organizations").select("*").eq("id", orgId).single();
  if (!org) return null;

  const steps = parseOnboardingState((org.onboarding_state as Record<string, unknown>) ?? null);

  const [products, _variants, connections, snapshots, conversations] = await Promise.all([
    supabase
      .from("warehouse_products")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
    supabase.from("warehouse_product_variants").select("id, sku, warehouse_products!inner(org_id)"),
    supabase.from("client_store_connections").select("*").eq("org_id", orgId),
    supabase
      .from("warehouse_billing_snapshots")
      .select("id, billing_period, grand_total, status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("support_conversations")
      .select("id, subject, status, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  return {
    org,
    onboardingSteps: steps,
    productCount: products.count ?? 0,
    connections: connections.data ?? [],
    recentSnapshots: snapshots.data ?? [],
    recentConversations: conversations.data ?? [],
  };
}

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
    storage_fee_waived: boolean;
    warehouse_grace_period_ends_at: string | null;
  }>,
) {
  const supabase = await createServerSupabaseClient();
  await supabase.from("organizations").update(data).eq("id", orgId);
  return { success: true };
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
