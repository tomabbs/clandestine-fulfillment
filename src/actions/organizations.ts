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
  let userRecord: Awaited<ReturnType<typeof requireAuth>>["userRecord"];
  try {
    const auth = await requireAuth();
    userRecord = auth.userRecord;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      return [];
    }
    throw error;
  }

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
//
// HRD-36 (2026-04-23): The previous TS-only implementation had six confirmed bugs:
//   (1) Five org_id-bearing tables missing from the per-table allow-list
//       (mailorder_orders, oauth_states, shipstation_orders, sku_sync_conflicts,
//        warehouse_billing_rule_overrides) — two NOT NULL FKs hard-blocked the source-org
//       DELETE; three nullable FKs silently orphaned rows.
//   (2) Silent failures inside the loop (the `.update()` `error` was never checked).
//   (3) Not transactional (Rule #64) — each PostgREST call was its own HTTP request,
//       so a mid-loop crash left a half-merged org with no rollback.
//   (4) previewMerge underreported affected rows for the same reason as (1).
//   (5) warehouse_inventory_levels.org_id is auto-derived by trigger (Rule #21) — the
//       prior code worked only because warehouse_products happened to come first in
//       the array; ordering was undocumented and fragile.
//   (6) UNIQUE-constraint collisions were not pre-checked (e.g. portal_admin_settings,
//       warehouse_billing_snapshots, client_store_connections, organization_aliases),
//       and bug (2) silently swallowed the resulting 23505s.
//
// Both Server Actions now delegate to PL/pgSQL RPCs defined in
// supabase/migrations/20260423000001_org_merge_rpc.sql:
//   - preview_merge_organizations(p_source uuid, p_target uuid) → jsonb
//   - merge_organizations_txn(p_source uuid, p_target uuid)     → int (rows reassigned)

export interface MergeCollision {
  table: string;
  constraint: string;
  key: Record<string, unknown>;
  source_row_id: string | null;
  target_row_id: string | null;
}

export interface MergePreview {
  sourceOrg: { id: string; name: string };
  targetOrg: { id: string; name: string };
  affectedRows: Record<string, number>;
  totalAffected: number;
  collisions: MergeCollision[];
}

interface MergePreviewRpcResponse {
  source_name: string;
  target_name: string;
  affected_rows: Record<string, number>;
  total_affected: number;
  collisions: MergeCollision[];
}

/**
 * Preview what a merge would affect without making changes.
 *
 * Returns per-table row counts and UNIQUE-constraint collisions. If `collisions`
 * is non-empty, `mergeOrganizations` will refuse to run until the operator resolves
 * each conflict manually (typically by deleting the duplicate row on the source
 * side, or merging its data into the target row).
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

  const { data, error } = await serviceClient.rpc("preview_merge_organizations", {
    p_source_org_id: sourceOrgId,
    p_target_org_id: targetOrgId,
  });

  if (error) {
    throw new Error(translateMergeError(error.message));
  }
  if (!data) {
    throw new Error("preview_merge_organizations returned empty payload");
  }

  const payload = data as MergePreviewRpcResponse;
  return {
    sourceOrg: { id: sourceOrgId, name: payload.source_name },
    targetOrg: { id: targetOrgId, name: payload.target_name },
    affectedRows: payload.affected_rows ?? {},
    totalAffected: payload.total_affected ?? 0,
    collisions: payload.collisions ?? [],
  };
}

/**
 * Merge source organization into target. Reassigns every org_id-bearing row in
 * a single Postgres transaction (Rule #64), then deletes the source org row.
 *
 * Aborts cleanly on UNIQUE-constraint collisions (Bug 6 from the HRD-36 audit) —
 * the RPC re-checks collisions inside the transaction to close the gap between
 * preview and confirm.
 *
 * This action is irreversible.
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

  const { data, error } = await serviceClient.rpc("merge_organizations_txn", {
    p_source_org_id: sourceOrgId,
    p_target_org_id: targetOrgId,
  });

  if (error) {
    throw new Error(translateMergeError(error.message));
  }

  return { merged: (data as number | null) ?? 0 };
}

/**
 * Map raw Postgres error messages from the merge RPCs to operator-friendly text.
 * The RPCs raise structured `prefix: detail` errors so the UI can branch on the prefix.
 */
function translateMergeError(message: string): string {
  if (message.includes("merge_invalid_input")) {
    return "Invalid merge request: source and target must both be set and different.";
  }
  if (message.includes("merge_source_not_found")) {
    return "Source organization not found.";
  }
  if (message.includes("merge_target_not_found")) {
    return "Target organization not found.";
  }
  if (message.includes("merge_workspace_mismatch")) {
    return "Source and target organizations are in different workspaces. Cross-workspace merges are not supported.";
  }
  if (message.includes("merge_collisions_present")) {
    return `Merge blocked by UNIQUE-constraint collisions. Resolve duplicates before retrying. Details: ${message}`;
  }
  if (message.includes("merge_delete_failed")) {
    return `Reassignment succeeded but final delete failed (orphan foreign key). ${message}`;
  }
  return `Merge failed: ${message}`;
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
