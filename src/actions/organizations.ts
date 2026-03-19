"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const createOrgSchema = z.object({
  name: z.string().min(1).max(200),
  billingEmail: z.string().email().optional(),
});

/**
 * Get all organizations for the authenticated user's workspace.
 */
export async function getOrganizations(): Promise<
  Array<{ id: string; name: string; slug: string; parent_org_id: string | null }>
> {
  const { userRecord } = await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("organizations")
    .select("id, name, slug, parent_org_id")
    .eq("workspace_id", userRecord.workspace_id)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to fetch organizations: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    name: string;
    slug: string;
    parent_org_id: string | null;
  }>;
}

/**
 * Create a new organization in the authenticated user's workspace.
 */
export async function createOrganization(rawData: {
  name: string;
  billingEmail?: string;
}): Promise<{ id: string; name: string; slug: string }> {
  const { userRecord } = await requireAuth();
  const data = createOrgSchema.parse(rawData);
  const serviceClient = createServiceRoleClient();

  const slug = data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const { data: org, error } = await serviceClient
    .from("organizations")
    .insert({
      workspace_id: userRecord.workspace_id,
      name: data.name,
      slug,
      billing_email: data.billingEmail ?? null,
    })
    .select("id, name, slug")
    .single();

  if (error) throw new Error(`Failed to create organization: ${error.message}`);
  return org as { id: string; name: string; slug: string };
}

// === Org hierarchy ===

export async function setParentOrganization(
  orgId: string,
  parentOrgId: string | null,
): Promise<void> {
  const { userRecord } = await requireAuth();
  if (userRecord.role !== "admin" && userRecord.role !== "super_admin") {
    throw new Error("Only admins can set parent organizations");
  }
  if (orgId === parentOrgId) throw new Error("An organization cannot be its own parent");

  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("organizations")
    .update({ parent_org_id: parentOrgId })
    .eq("id", orgId);

  if (error) throw new Error(`Failed to set parent: ${error.message}`);
}

export async function getChildOrganizations(
  parentOrgId: string,
): Promise<Array<{ id: string; name: string; slug: string }>> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("organizations")
    .select("id, name, slug")
    .eq("parent_org_id", parentOrgId)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to fetch children: ${error.message}`);
  return (data ?? []) as Array<{ id: string; name: string; slug: string }>;
}

// === Org merge ===

/** All tables with an org_id column that must be reassigned during merge. */
const ORG_TABLES = [
  "warehouse_products",
  "warehouse_shipments",
  "warehouse_orders",
  "warehouse_inbound_shipments",
  "warehouse_billing_snapshots",
  "warehouse_billing_adjustments",
  "warehouse_inventory_levels",
  "warehouse_shipstation_stores",
  "warehouse_review_queue",
  "bandcamp_connections",
  "client_store_connections",
  "support_conversations",
  "support_email_mappings",
  "portal_admin_settings",
  "users",
  "organization_aliases",
] as const;

export interface MergePreview {
  sourceOrg: { id: string; name: string };
  targetOrg: { id: string; name: string };
  affectedRows: Record<string, number>;
  totalAffected: number;
}

/**
 * Preview what a merge would affect without making changes.
 */
export async function previewMerge(
  sourceOrgId: string,
  targetOrgId: string,
): Promise<MergePreview> {
  const { userRecord } = await requireAuth();
  if (userRecord.role !== "admin" && userRecord.role !== "super_admin") {
    throw new Error("Only admins can merge organizations");
  }

  const serviceClient = createServiceRoleClient();

  const [sourceRes, targetRes] = await Promise.all([
    serviceClient.from("organizations").select("id, name").eq("id", sourceOrgId).single(),
    serviceClient.from("organizations").select("id, name").eq("id", targetOrgId).single(),
  ]);

  if (!sourceRes.data) throw new Error("Source organization not found");
  if (!targetRes.data) throw new Error("Target organization not found");

  const affectedRows: Record<string, number> = {};
  let totalAffected = 0;

  for (const table of ORG_TABLES) {
    const { count } = await serviceClient
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("org_id", sourceOrgId);
    const n = count ?? 0;
    if (n > 0) {
      affectedRows[table] = n;
      totalAffected += n;
    }
  }

  return {
    sourceOrg: sourceRes.data as { id: string; name: string },
    targetOrg: targetRes.data as { id: string; name: string },
    affectedRows,
    totalAffected,
  };
}

/**
 * Merge source organization into target. Reassigns all records then
 * deletes the source org. This is irreversible.
 */
export async function mergeOrganizations(
  sourceOrgId: string,
  targetOrgId: string,
): Promise<{ merged: number }> {
  const { userRecord } = await requireAuth();
  if (userRecord.role !== "admin" && userRecord.role !== "super_admin") {
    throw new Error("Only admins can merge organizations");
  }
  if (sourceOrgId === targetOrgId) throw new Error("Cannot merge an organization into itself");

  const serviceClient = createServiceRoleClient();

  // Verify both exist
  const [sourceRes, targetRes] = await Promise.all([
    serviceClient.from("organizations").select("id").eq("id", sourceOrgId).single(),
    serviceClient.from("organizations").select("id").eq("id", targetOrgId).single(),
  ]);
  if (!sourceRes.data) throw new Error("Source organization not found");
  if (!targetRes.data) throw new Error("Target organization not found");

  let totalMerged = 0;

  // Reassign all records from source to target
  for (const table of ORG_TABLES) {
    // Count first, then update
    const { count } = await serviceClient
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("org_id", sourceOrgId);

    if ((count ?? 0) > 0) {
      await serviceClient
        .from(table)
        .update({ org_id: targetOrgId } as Record<string, unknown>)
        .eq("org_id", sourceOrgId);
      totalMerged += count ?? 0;
    }
  }

  // Move child organizations too
  await serviceClient
    .from("organizations")
    .update({ parent_org_id: targetOrgId })
    .eq("parent_org_id", sourceOrgId);

  // Delete the source org (now orphaned — all FKs reassigned)
  const { error: deleteError } = await serviceClient
    .from("organizations")
    .delete()
    .eq("id", sourceOrgId);

  if (deleteError) {
    throw new Error(
      `Failed to delete source org after merge: ${deleteError.message}. Records were already reassigned to target.`,
    );
  }

  return { merged: totalMerged };
}

// === Organization Aliases ===

export interface OrgAlias {
  id: string;
  org_id: string;
  alias_name: string;
  source: string | null;
  created_at: string;
}

/**
 * Add an alias for an organization (e.g. "Pirate Ship name", "ShipStation store name").
 */
export async function addAlias(
  orgId: string,
  aliasName: string,
  source?: string,
): Promise<OrgAlias> {
  const { userRecord } = await requireAuth();
  if (userRecord.role !== "admin" && userRecord.role !== "super_admin") {
    throw new Error("Only admins can manage aliases");
  }

  const trimmed = aliasName.trim();
  if (!trimmed) throw new Error("Alias name cannot be empty");

  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("organization_aliases")
    .insert({
      org_id: orgId,
      alias_name: trimmed,
      source: source ?? null,
      workspace_id: userRecord.workspace_id,
    })
    .select("id, org_id, alias_name, source, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(`Alias "${trimmed}" is already in use`);
    }
    throw new Error(`Failed to add alias: ${error.message}`);
  }

  return data as OrgAlias;
}

/**
 * Remove an alias by ID.
 */
export async function removeAlias(aliasId: string): Promise<void> {
  const { userRecord } = await requireAuth();
  if (userRecord.role !== "admin" && userRecord.role !== "super_admin") {
    throw new Error("Only admins can manage aliases");
  }

  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient.from("organization_aliases").delete().eq("id", aliasId);

  if (error) throw new Error(`Failed to remove alias: ${error.message}`);
}

/**
 * Get all aliases for a single organization.
 */
export async function getAliases(orgId: string): Promise<OrgAlias[]> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("organization_aliases")
    .select("id, org_id, alias_name, source, created_at")
    .eq("org_id", orgId)
    .order("alias_name", { ascending: true });

  if (error) throw new Error(`Failed to fetch aliases: ${error.message}`);
  return (data ?? []) as OrgAlias[];
}

/**
 * Get all aliases across all organizations in the workspace.
 * Returns a map of lowercase alias_name → org_id for fast lookup.
 */
export async function getAllAliasMap(): Promise<Map<string, string>> {
  const { userRecord } = await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("organization_aliases")
    .select("alias_name, org_id")
    .eq("workspace_id", userRecord.workspace_id);

  if (error) throw new Error(`Failed to fetch aliases: ${error.message}`);

  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set((row.alias_name as string).toLowerCase(), row.org_id as string);
  }
  return map;
}

/**
 * Find an organization by name or alias (case-insensitive).
 * Used by import matching to resolve client names from external sources.
 *
 * This is a server-only function (no auth required) for use in Trigger tasks.
 */
export async function findOrgByNameOrAlias(
  name: string,
  workspaceId: string,
  supabase?: ReturnType<typeof createServiceRoleClient>,
): Promise<{ orgId: string; matchMethod: "name" | "alias" } | null> {
  const client = supabase ?? createServiceRoleClient();
  const trimmed = name.trim();
  if (!trimmed) return null;

  // Try exact org name match first (case-insensitive)
  const { data: orgMatch } = await client
    .from("organizations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("name", trimmed)
    .limit(1)
    .maybeSingle();

  if (orgMatch) {
    return { orgId: orgMatch.id, matchMethod: "name" };
  }

  // Try alias match (case-insensitive via the LOWER index)
  const { data: aliasMatch } = await client
    .from("organization_aliases")
    .select("org_id")
    .eq("workspace_id", workspaceId)
    .ilike("alias_name", trimmed)
    .limit(1)
    .maybeSingle();

  if (aliasMatch) {
    return { orgId: aliasMatch.org_id as string, matchMethod: "alias" };
  }

  return null;
}
