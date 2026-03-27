import type { User as AuthUser } from "@supabase/supabase-js";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientRole, StaffRole } from "@/lib/shared/constants";
import { CLIENT_ROLES, STAFF_ROLES } from "@/lib/shared/constants";

export interface AuthContext {
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  authUserId: string;
  userRecord: {
    id: string;
    workspace_id: string;
    org_id: string | null;
    role: StaffRole | ClientRole;
    email: string | null;
    name: string | null;
  };
  isStaff: boolean;
}

type UserRecord = AuthContext["userRecord"];

const USER_SELECT = "id, workspace_id, org_id, role, email, name" as const;

/**
 * Shared auth helper for Server Actions.
 * Returns the authenticated user's workspace_id, org_id, and role.
 * Auto-provisions a users row if the auth user has none (first login).
 */
export async function requireAuth(): Promise<AuthContext> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();
  const userRecord = await getOrCreateUserRecord(serviceClient, user);

  if (!userRecord.workspace_id) throw new Error("User has no workspace assigned");

  const isStaff = (STAFF_ROLES as readonly string[]).includes(userRecord.role);

  return {
    supabase,
    authUserId: user.id,
    userRecord,
    isStaff,
  };
}

/**
 * Look up the users row for an auth user. If none exists, auto-provision one
 * with the default workspace and an appropriate role (admin for first user,
 * label_staff for subsequent).
 */
export async function getOrCreateUserRecord(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  authUser: AuthUser,
): Promise<UserRecord> {
  // Try to find existing record
  const { data: existing } = await serviceClient
    .from("users")
    .select(USER_SELECT)
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  if (existing) return existing as UserRecord;

  // No record — auto-provision
  const { data: workspace } = await serviceClient.from("workspaces").select("id").limit(1).single();

  if (!workspace) throw new Error("No workspace exists. Seed the database first.");

  // First user in the workspace gets admin, others get label_staff
  const { count } = await serviceClient
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id);

  const role: StaffRole = (count ?? 0) === 0 ? "admin" : "label_staff";

  const displayName =
    (authUser.user_metadata?.full_name as string) ??
    (authUser.user_metadata?.name as string) ??
    null;

  const { data: created, error: insertError } = await serviceClient
    .from("users")
    .insert({
      auth_user_id: authUser.id,
      email: authUser.email ?? "",
      name: displayName,
      role,
      workspace_id: workspace.id,
      org_id: null,
    })
    .select(USER_SELECT)
    .single();

  if (insertError) throw new Error(`Failed to create user record: ${insertError.message}`);

  return created as UserRecord;
}

/**
 * Resolve all workspace IDs from the database.
 * For Trigger.dev cron tasks that must operate across all workspaces.
 */
export async function getAllWorkspaceIds(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string[]> {
  const { data, error } = await supabase.from("workspaces").select("id");
  if (error) throw new Error(`Failed to fetch workspaces: ${error.message}`);
  return (data ?? []).map((w) => w.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Request-scoped helpers (C14 fix: use anon-key request client, NOT service role)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the authenticated user's basic info.
 * Uses request-scoped cookie client — throws if unauthenticated.
 */
export async function getAuthUser(): Promise<{
  userId: string;
  authId: string;
  email: string | undefined;
}> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) throw new Error("Authentication required");

  const { data: profile } = await supabase
    .from("users")
    .select("id")
    .eq("auth_user_id", user.id)
    .single();

  if (!profile) throw new Error("User profile not found");

  return { userId: profile.id, authId: user.id, email: user.email };
}

/**
 * Require staff access.
 * Uses request-scoped cookie client — throws if unauthenticated or non-staff.
 */
export async function requireStaff(): Promise<{
  userId: string;
  workspaceId: string;
}> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) throw new Error("Authentication required");

  const { data: profile } = await supabase
    .from("users")
    .select("id, role, workspace_id")
    .eq("auth_user_id", user.id)
    .single();

  if (!profile) throw new Error("User profile not found");

  if (!(STAFF_ROLES as readonly string[]).includes(profile.role)) {
    throw new Error("Staff access required");
  }

  return { userId: profile.id, workspaceId: profile.workspace_id };
}

/**
 * Require client (non-staff) access.
 * Uses request-scoped cookie client — throws if unauthenticated or non-client.
 */
export async function requireClient(): Promise<{
  userId: string;
  orgId: string;
  workspaceId: string;
}> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) throw new Error("Authentication required");

  const { data: profile } = await supabase
    .from("users")
    .select("id, role, org_id, workspace_id")
    .eq("auth_user_id", user.id)
    .single();

  if (!profile) throw new Error("User profile not found");

  if (!(CLIENT_ROLES as readonly string[]).includes(profile.role) || !profile.org_id) {
    throw new Error("Client access required");
  }

  return {
    userId: profile.id,
    orgId: profile.org_id,
    workspaceId: profile.workspace_id,
  };
}
