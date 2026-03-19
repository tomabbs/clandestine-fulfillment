"use server";

import { z } from "zod/v4";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

import type { BandcampConnection, BandcampProductMapping } from "@/lib/shared/types";

// Rule #48: No Server Action may call the Bandcamp API directly.
// Force Sync MUST enqueue via Trigger task through the shared bandcampQueue.

// === Zod schemas (Rule #5) ===

const createConnectionSchema = z.object({
  workspaceId: z.string().uuid(),
  orgId: z.string().uuid(),
  bandId: z.number().int().positive(),
  bandName: z.string().min(1),
  bandUrl: z.string().url().nullable().optional(),
});

const deleteConnectionSchema = z.object({
  connectionId: z.string().uuid(),
});

// === Helper ===

async function requireAuth() {
  const supabase = await createServerSupabaseClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("Unauthorized");

  // Fetch the user's record to get org_id and workspace_id
  const serviceClient = createServiceRoleClient();
  const { data: userRecord, error: userError } = await serviceClient
    .from("users")
    .select("id, org_id, workspace_id")
    .eq("auth_user_id", authData.user.id)
    .single();

  if (userError || !userRecord) {
    throw new Error("User record not found");
  }

  return { supabase, user: authData.user, userRecord };
}

// === Connection management ===

export async function createBandcampConnection(rawData: {
  workspaceId: string;
  orgId: string;
  bandId: number;
  bandName: string;
  bandUrl?: string | null;
}): Promise<BandcampConnection> {
  await requireAuth();
  const data = createConnectionSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Verify the org exists and belongs to this workspace
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .select("id, workspace_id")
    .eq("id", data.orgId)
    .single();

  if (orgError || !org) throw new Error("Organization not found");
  if (org.workspace_id !== data.workspaceId)
    throw new Error("Organization does not belong to this workspace");

  const { data: connection, error } = await serviceClient
    .from("bandcamp_connections")
    .upsert(
      {
        workspace_id: data.workspaceId,
        org_id: data.orgId,
        band_id: data.bandId,
        band_name: data.bandName,
        band_url: data.bandUrl ?? null,
        is_active: true,
      },
      { onConflict: "workspace_id,band_id" },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to create Bandcamp connection: ${error.message}`);

  return connection as BandcampConnection;
}

export async function deleteBandcampConnection(rawData: {
  connectionId: string;
}): Promise<{ success: true }> {
  await requireAuth();
  const data = deleteConnectionSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  // Soft-delete: mark inactive rather than hard delete
  const { error } = await serviceClient
    .from("bandcamp_connections")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", data.connectionId);

  if (error) throw new Error(`Failed to delete Bandcamp connection: ${error.message}`);

  return { success: true };
}

export async function getOrganizationsForWorkspace(
  workspaceId: string,
): Promise<Array<{ id: string; name: string }>> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data: orgs, error } = await serviceClient
    .from("organizations")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to fetch organizations: ${error.message}`);

  return (orgs ?? []) as Array<{ id: string; name: string }>;
}

export async function triggerBandcampSync(workspaceId?: string): Promise<{ taskRunId: string }> {
  const { userRecord } = await requireAuth();
  const wsId = workspaceId ?? userRecord.workspace_id;

  // Dynamic import to avoid bundling trigger SDK in client
  const { tasks } = await import("@trigger.dev/sdk");
  const handle = await tasks.trigger("bandcamp-sync", { workspaceId: wsId });

  return { taskRunId: handle.id };
}

export async function getBandcampSyncStatus() {
  const { supabase, userRecord } = await requireAuth();
  const workspaceId = userRecord.workspace_id;

  const { data: recentLogs } = await supabase
    .from("channel_sync_log")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("channel", "bandcamp")
    .order("created_at", { ascending: false })
    .limit(20);

  const logs = recentLogs ?? [];

  // Derive last completed times per sync_type from logs
  const lastMerchSync = logs.find((l) => l.sync_type === "merch_sync" && l.status !== "started");
  const lastSalePoll = logs.find((l) => l.sync_type === "sale_poll" && l.status !== "started");
  const lastInventoryPush = logs.find(
    (l) => l.sync_type === "inventory_push" && l.status !== "started",
  );

  return {
    lastMerchSync: lastMerchSync?.completed_at ?? null,
    lastSalePoll: lastSalePoll?.completed_at ?? null,
    lastInventoryPush: lastInventoryPush?.completed_at ?? null,
    recentLogs: logs,
  };
}

export async function getBandcampAccounts(workspaceId: string): Promise<
  Array<
    BandcampConnection & {
      memberArtistCount: number;
      merchItemCount: number;
    }
  >
> {
  await requireAuth();
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
  await requireAuth();
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
