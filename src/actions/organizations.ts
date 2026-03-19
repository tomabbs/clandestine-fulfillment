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
  Array<{ id: string; name: string; slug: string }>
> {
  const { userRecord } = await requireAuth();
  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("organizations")
    .select("id, name, slug")
    .eq("workspace_id", userRecord.workspace_id)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to fetch organizations: ${error.message}`);
  return (data ?? []) as Array<{ id: string; name: string; slug: string }>;
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
