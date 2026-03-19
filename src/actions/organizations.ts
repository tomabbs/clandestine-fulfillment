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
