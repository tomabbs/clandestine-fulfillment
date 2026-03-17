"use server";

import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { type AutoMatchSuggestion, computeMatchSuggestions } from "@/lib/shared/store-match";
import type { WarehouseShipstationStore } from "@/lib/shared/types";

// === Types ===

export type { AutoMatchSuggestion };

export interface StoreMappingRow extends WarehouseShipstationStore {
  org_name: string | null;
}

// === Server Actions ===

async function requireAuth() {
  const supabase = await createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Unauthorized");
  return userData.user;
}

export async function getStoreMappings(workspaceId: string): Promise<StoreMappingRow[]> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: stores, error } = await serviceClient
    .from("warehouse_shipstation_stores")
    .select("*, organizations(name)")
    .eq("workspace_id", workspaceId)
    .order("store_name", { ascending: true });

  if (error) throw new Error(`Failed to fetch store mappings: ${error.message}`);

  return (stores ?? []).map((s) => {
    const org = s.organizations as unknown as { name: string } | null;
    return {
      ...s,
      org_name: org?.name ?? null,
      organizations: undefined,
    } as StoreMappingRow;
  });
}

export async function syncStoresFromShipStation(workspaceId: string): Promise<{ synced: number }> {
  await requireAuth();

  const { fetchStores } = await import("@/lib/clients/shipstation");
  const apiStores = await fetchStores();

  const serviceClient = createServiceRoleClient();

  let synced = 0;
  for (const store of apiStores) {
    const { error } = await serviceClient.from("warehouse_shipstation_stores").upsert(
      {
        workspace_id: workspaceId,
        store_id: store.storeId,
        store_name: store.storeName,
        marketplace_name: store.marketplaceName,
      },
      { onConflict: "workspace_id,store_id" },
    );

    if (error) throw new Error(`Failed to upsert store ${store.storeId}: ${error.message}`);
    synced++;
  }

  return { synced };
}

export async function autoMatchStores(workspaceId: string): Promise<AutoMatchSuggestion[]> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: unmapped, error: storeError } = await serviceClient
    .from("warehouse_shipstation_stores")
    .select("id, store_name")
    .eq("workspace_id", workspaceId)
    .is("org_id", null);

  if (storeError) throw new Error(`Failed to fetch unmapped stores: ${storeError.message}`);
  if (!unmapped?.length) return [];

  const { data: orgs, error: orgError } = await serviceClient
    .from("organizations")
    .select("id, name")
    .eq("workspace_id", workspaceId);

  if (orgError) throw new Error(`Failed to fetch organizations: ${orgError.message}`);
  if (!orgs?.length) return [];

  return computeMatchSuggestions(
    unmapped as Array<{ id: string; store_name: string | null }>,
    orgs as Array<{ id: string; name: string }>,
  );
}

export async function updateStoreMapping(storeId: string, orgId: string): Promise<void> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { error } = await serviceClient
    .from("warehouse_shipstation_stores")
    .update({ org_id: orgId })
    .eq("id", storeId);

  if (error) throw new Error(`Failed to update store mapping: ${error.message}`);
}

export async function unmapStore(storeId: string): Promise<void> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { error } = await serviceClient
    .from("warehouse_shipstation_stores")
    .update({ org_id: null })
    .eq("id", storeId);

  if (error) throw new Error(`Failed to unmap store: ${error.message}`);
}
