"use server";

import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { type AutoMatchSuggestion, computeMatchSuggestions } from "@/lib/shared/store-match";
import type { WarehouseShipstationStore } from "@/lib/shared/types";

// === Types ===

export type { AutoMatchSuggestion };

export interface StoreMappingRow extends WarehouseShipstationStore {
  org_name: string | null;
}

export interface StoreMappingsResult {
  stores: StoreMappingRow[];
  orgs: Array<{ id: string; name: string }>;
}

// === Server Actions ===

async function requireAuth() {
  const supabase = await createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Unauthorized");
  return userData.user;
}

export async function getStoreMappings(workspaceId: string): Promise<StoreMappingsResult> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const [storesResult, orgsResult] = await Promise.all([
    serviceClient
      .from("warehouse_shipstation_stores")
      .select("*, organizations(name)")
      .eq("workspace_id", workspaceId)
      .order("store_name", { ascending: true }),
    serviceClient
      .from("organizations")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .order("name", { ascending: true }),
  ]);

  if (storesResult.error) throw new Error(`Failed to fetch store mappings: ${storesResult.error.message}`);
  if (orgsResult.error) throw new Error(`Failed to fetch organizations: ${orgsResult.error.message}`);

  const stores = (storesResult.data ?? []).map((s) => {
    const org = s.organizations as unknown as { name: string } | null;
    return {
      ...s,
      org_name: org?.name ?? null,
      organizations: undefined,
    } as StoreMappingRow;
  });

  return {
    stores,
    orgs: (orgsResult.data ?? []) as Array<{ id: string; name: string }>,
  };
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

  // Fetch aliases for enhanced matching
  const { data: aliases } = await serviceClient
    .from("organization_aliases")
    .select("org_id, alias_name")
    .eq("workspace_id", workspaceId);

  return computeMatchSuggestions(
    unmapped as Array<{ id: string; store_name: string | null }>,
    orgs as Array<{ id: string; name: string }>,
    (aliases ?? []) as Array<{ org_id: string; alias_name: string }>,
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

/**
 * Re-process shipments that have no org_id by re-running org matching.
 * Uses the same match-shipment-org logic as the ingest pipeline.
 */
export async function reprocessUnmatchedShipments(
  workspaceId: string,
): Promise<{ total: number; matched: number }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: unmatched } = await serviceClient
    .from("warehouse_shipments")
    .select("id, shipstation_shipment_id")
    .eq("workspace_id", workspaceId)
    .is("org_id", null)
    .limit(200);

  if (!unmatched || unmatched.length === 0) return { total: 0, matched: 0 };

  let matched = 0;

  for (const shipment of unmatched) {
    // Look up the ShipStation store_id from label_data or try to match by items
    const { data: items } = await serviceClient
      .from("warehouse_shipment_items")
      .select("sku")
      .eq("shipment_id", shipment.id);

    const skus = (items ?? []).map((i) => i.sku).filter(Boolean);

    // Try SKU-based matching: find variant → product → org_id
    if (skus.length > 0) {
      const { data: variants } = await serviceClient
        .from("warehouse_product_variants")
        .select("sku, warehouse_products!inner(org_id)")
        .in("sku", skus);

      if (variants && variants.length > 0) {
        const orgCounts: Record<string, number> = {};
        for (const v of variants) {
          const product = v.warehouse_products as unknown as { org_id: string } | null;
          if (product?.org_id) {
            orgCounts[product.org_id] = (orgCounts[product.org_id] ?? 0) + 1;
          }
        }

        let bestOrgId: string | null = null;
        let bestCount = 0;
        for (const [orgId, count] of Object.entries(orgCounts)) {
          if (count > bestCount) {
            bestOrgId = orgId;
            bestCount = count;
          }
        }

        if (bestOrgId) {
          await serviceClient
            .from("warehouse_shipments")
            .update({ org_id: bestOrgId, updated_at: new Date().toISOString() })
            .eq("id", shipment.id);
          matched++;
        }
      }
    }
  }

  return { total: unmatched.length, matched };
}
