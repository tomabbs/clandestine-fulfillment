"use server";

import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

import type { BandcampConnection, BandcampProductMapping } from "@/lib/shared/types";

// Rule #48: No Server Action may call the Bandcamp API directly.
// Force Sync MUST enqueue via Trigger task through the shared bandcampQueue.

export async function triggerBandcampSync(workspaceId: string): Promise<{ taskRunId: string }> {
  const supabase = await createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Unauthorized");

  // Dynamic import to avoid bundling trigger SDK in client
  const { tasks } = await import("@trigger.dev/sdk");
  const handle = await tasks.trigger("bandcamp-sync", { workspaceId });

  return { taskRunId: handle.id };
}

export async function getBandcampAccounts(workspaceId: string): Promise<
  Array<
    BandcampConnection & {
      memberArtistCount: number;
      merchItemCount: number;
    }
  >
> {
  const supabase = await createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();

  const { data: connections, error } = await serviceClient
    .from("bandcamp_connections")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch Bandcamp accounts: ${error.message}`);

  // Get mapping counts per connection's org
  const results = await Promise.all(
    (connections ?? []).map(async (conn) => {
      const cache = conn.member_bands_cache as Record<string, unknown> | null;
      const memberBands = (cache?.member_bands as unknown[]) ?? [];

      const { count } = await serviceClient
        .from("bandcamp_product_mappings")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);

      return {
        ...conn,
        memberArtistCount: memberBands.length,
        merchItemCount: count ?? 0,
      } as BandcampConnection & { memberArtistCount: number; merchItemCount: number };
    }),
  );

  return results;
}

export async function getBandcampMappings(
  orgId: string,
): Promise<Array<BandcampProductMapping & { variant_sku: string; variant_title: string | null }>> {
  const supabase = await createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();

  const { data: mappings, error } = await serviceClient
    .from("bandcamp_product_mappings")
    .select("*, warehouse_product_variants(sku, title)")
    .eq("workspace_id", orgId);

  if (error) throw new Error(`Failed to fetch Bandcamp mappings: ${error.message}`);

  return (mappings ?? []).map((m) => {
    const variant = m.warehouse_product_variants as unknown as {
      sku: string;
      title: string | null;
    } | null;
    return {
      ...m,
      variant_sku: variant?.sku ?? "",
      variant_title: variant?.title ?? null,
      warehouse_product_variants: undefined,
    } as BandcampProductMapping & { variant_sku: string; variant_title: string | null };
  });
}
