"use server";

import { z } from "zod";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";

const credentialsSchema = z
  .object({
    apiKey: z.string().min(1, "API key is required"),
    apiSecret: z.string().optional(),
  })
  .strict();

/**
 * Rule #19: Client credential submission uses service_role.
 * Validates the authenticated user's org_id matches the target connection,
 * then writes credentials via service_role client (bypassing staff-only RLS).
 */
export async function submitClientStoreCredentials(
  connectionId: string,
  credentials: { apiKey: string; apiSecret?: string },
) {
  if (!connectionId) {
    throw new Error("Connection ID is required");
  }

  const parsed = credentialsSchema.parse(credentials);

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const serviceClient = createServiceRoleClient();

  // Look up the connection to get its org_id
  const { data: connection } = await serviceClient
    .from("client_store_connections")
    .select("org_id")
    .eq("id", connectionId)
    .single();

  if (!connection) {
    throw new Error("Connection not found");
  }

  // Look up the user's org_id
  const { data: userRecord } = await serviceClient
    .from("users")
    .select("org_id")
    .eq("auth_user_id", user.id)
    .single();

  if (!userRecord) {
    throw new Error("User record not found");
  }

  if (userRecord.org_id !== connection.org_id) {
    throw new Error("You do not have permission to modify this connection");
  }

  // Write credentials via service_role (bypasses staff-only RLS)
  const updateData: Record<string, string> = {
    api_key: parsed.apiKey,
  };

  if (parsed.apiSecret) {
    updateData.api_secret = parsed.apiSecret;
  }

  const { error } = await serviceClient
    .from("client_store_connections")
    .update(updateData)
    .eq("id", connectionId);

  if (error) {
    throw new Error(`Failed to update credentials: ${error.message}`);
  }

  return { success: true };
}
