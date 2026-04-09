"use server";

import { requireClient } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { parseOnboardingState } from "@/lib/shared/onboarding";

export async function getPortalDashboard() {
  const { orgId } = await requireClient();
  const supabase = createServiceRoleClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, onboarding_state")
    .eq("id", orgId)
    .single();

  const onboardingSteps = parseOnboardingState(
    (org?.onboarding_state as Record<string, unknown>) ?? null,
  );

  const [variantCount, inventorySum, inboundCount, supportCount] = await Promise.all([
    supabase
      .from("warehouse_product_variants")
      .select("id", { count: "exact", head: true })
      .eq("warehouse_products.org_id", orgId),
    supabase.from("warehouse_inventory_levels").select("available").eq("org_id", orgId),
    supabase
      .from("warehouse_inbound_shipments")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .in("status", ["expected", "arrived", "checking_in"]),
    supabase
      .from("support_conversations")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .in("status", ["open", "waiting_on_staff"]),
  ]);

  const totalAvailable = (inventorySum.data ?? []).reduce(
    (sum, row) => sum + (row.available as number),
    0,
  );

  const { data: connections } = await supabase
    .from("client_store_connections")
    .select("id, platform, store_url, connection_status, last_webhook_at, last_poll_at")
    .eq("org_id", orgId)
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
    connections: connections ?? [],
  };
}
