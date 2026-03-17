"use server";

import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { parseOnboardingState } from "@/lib/shared/onboarding";

export async function getPortalDashboard() {
  const supabase = await createServerSupabaseClient();

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name, onboarding_state")
    .limit(1)
    .single();

  const org = orgs;
  const orgId = org?.id;
  const onboardingSteps = parseOnboardingState(
    (org?.onboarding_state as Record<string, unknown>) ?? null,
  );

  const [variantCount, inventorySum, inboundCount, supportCount] = await Promise.all([
    supabase.from("warehouse_product_variants").select("id", { count: "exact", head: true }),
    supabase.from("warehouse_inventory_levels").select("available"),
    supabase
      .from("warehouse_inbound_shipments")
      .select("id", { count: "exact", head: true })
      .in("status", ["expected", "arrived", "checking_in"]),
    supabase
      .from("support_conversations")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "waiting_on_staff"]),
  ]);

  const totalAvailable = (inventorySum.data ?? []).reduce(
    (sum, row) => sum + (row.available as number),
    0,
  );

  const { data: recentActivity } = await supabase
    .from("warehouse_inventory_activity")
    .select("id, sku, delta, source, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: connections } = await supabase
    .from("client_store_connections")
    .select("id, platform, store_url, connection_status, last_webhook_at, last_poll_at")
    .eq("connection_status", "active");

  return {
    orgName: org?.name ?? "Your Organization",
    orgId,
    onboardingSteps,
    stats: {
      totalSkus: variantCount.count ?? 0,
      totalAvailable,
      pendingInbound: inboundCount.count ?? 0,
      openSupport: supportCount.count ?? 0,
    },
    recentActivity: recentActivity ?? [],
    connections: connections ?? [],
  };
}
