"use server";

import { requireStaff } from "@/lib/server/auth-context";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

// ── Overview ──────────────────────────────────────────────────────────────────

export async function getDiscogsOverview() {
  await requireStaff();
  const supabase = await createServerSupabaseClient();

  const [creds, listings, orders, messages] = await Promise.all([
    supabase.from("discogs_credentials").select("id, username, created_at").single(),
    supabase.from("discogs_listings").select("id, status"),
    supabase
      .from("mailorder_orders")
      .select("id, fulfillment_status")
      .eq("source", "clandestine_discogs"),
    supabase.from("discogs_order_messages").select("id", { count: "exact", head: true }),
  ]);

  return {
    hasCredentials: !!creds.data,
    username: creds.data?.username ?? null,
    activeListings: (listings.data ?? []).filter((l) => l.status === "For Sale").length,
    totalOrders: orders.data?.length ?? 0,
    unfulfilledOrders: (orders.data ?? []).filter((o) => o.fulfillment_status === "unfulfilled")
      .length,
    totalMessages: messages.count ?? 0,
  };
}

// ── Credentials ───────────────────────────────────────────────────────────────

export async function getDiscogsCredentials() {
  await requireStaff();
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("discogs_credentials")
    .select("id, username, user_id, currency, default_condition, created_at, updated_at")
    .single();
  return { credentials: data ?? null };
}

export async function saveDiscogsCredentials(params: { accessToken: string; username: string }) {
  await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!workspace) throw new Error("No workspace found");

  await supabase.from("discogs_credentials").upsert(
    {
      workspace_id: workspace.id,
      username: params.username,
      access_token: params.accessToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );

  return { success: true };
}

// ── Product Matching ──────────────────────────────────────────────────────────

export async function getProductMappings(filters: { search?: string; status?: string }) {
  await requireStaff();
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("discogs_product_mappings")
    .select(`
      id, discogs_release_id, discogs_release_url, match_method, match_confidence,
      is_active, condition, listing_price, created_at,
      warehouse_product_variants!inner(sku, title),
      warehouse_products(title, vendor)
    `)
    .order("created_at", { ascending: false })
    .limit(50);

  if (filters.status === "pending") query = query.eq("is_active", false);
  if (filters.status === "active") query = query.eq("is_active", true);

  const { data } = await query;
  return { mappings: data ?? [] };
}

export async function confirmMapping(mappingId: string) {
  await requireStaff();
  const supabase = createServiceRoleClient();
  await supabase
    .from("discogs_product_mappings")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", mappingId);
  return { success: true };
}

export async function rejectMapping(mappingId: string) {
  await requireStaff();
  const supabase = createServiceRoleClient();
  await supabase.from("discogs_product_mappings").delete().eq("id", mappingId);
  return { success: true };
}
