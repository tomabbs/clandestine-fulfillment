import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientRole, StaffRole } from "@/lib/shared/constants";
import { STAFF_ROLES } from "@/lib/shared/constants";

export interface AuthContext {
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  authUserId: string;
  userRecord: {
    id: string;
    workspace_id: string;
    org_id: string | null;
    role: StaffRole | ClientRole;
    email: string | null;
    full_name: string | null;
  };
  isStaff: boolean;
}

/**
 * Shared auth helper for Server Actions.
 * Returns the authenticated user's workspace_id, org_id, and role.
 * Uses service_role to look up the user record (bypasses RLS).
 */
export async function requireAuth(): Promise<AuthContext> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();
  const { data: userRecord, error } = await serviceClient
    .from("users")
    .select("id, workspace_id, org_id, role, email, full_name")
    .eq("auth_user_id", user.id)
    .single();

  if (error || !userRecord) throw new Error("User record not found");
  if (!userRecord.workspace_id) throw new Error("User has no workspace assigned");

  const isStaff = (STAFF_ROLES as readonly string[]).includes(userRecord.role);

  return {
    supabase,
    authUserId: user.id,
    userRecord: userRecord as AuthContext["userRecord"],
    isStaff,
  };
}

/**
 * Resolve all workspace IDs from the database.
 * For Trigger.dev cron tasks that must operate across all workspaces.
 * Pass in the service-role Supabase client already created in the task.
 */
export async function getAllWorkspaceIds(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string[]> {
  const { data, error } = await supabase.from("workspaces").select("id");
  if (error) throw new Error(`Failed to fetch workspaces: ${error.message}`);
  return (data ?? []).map((w) => w.id);
}
