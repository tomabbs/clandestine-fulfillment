"use server";

import { z } from "zod";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { CLIENT_ROLES, STAFF_ROLES } from "@/lib/shared/constants";

const ALL_ROLES = [...STAFF_ROLES, ...CLIENT_ROLES] as const;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(ALL_ROLES),
  orgId: z.string().uuid().optional(),
});

const updateRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(ALL_ROLES),
});

const deactivateSchema = z.object({
  userId: z.string().uuid(),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireAdmin(role: string) {
  if (role !== "admin" && role !== "super_admin") {
    throw new Error("Only admins can manage users");
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function getUsers(filters?: { search?: string }) {
  const { userRecord } = await requireAuth();
  requireAdmin(userRecord.role);

  const serviceClient = createServiceRoleClient();

  let query = serviceClient
    .from("users")
    .select("id, auth_user_id, email, name, role, org_id, is_active, created_at")
    .eq("workspace_id", userRecord.workspace_id)
    .order("created_at", { ascending: false });

  if (filters?.search) {
    query = query.or(`email.ilike.%${filters.search}%,name.ilike.%${filters.search}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch users: ${error.message}`);

  return data ?? [];
}

export async function inviteUser(input: InviteUserInput) {
  const { userRecord } = await requireAuth();
  requireAdmin(userRecord.role);

  const parsed = inviteUserSchema.parse(input);
  const serviceClient = createServiceRoleClient();

  // Client roles require orgId
  if ((CLIENT_ROLES as readonly string[]).includes(parsed.role) && !parsed.orgId) {
    throw new Error("Client roles require an organization");
  }

  // Check for duplicate email
  const { data: existingUser } = await serviceClient
    .from("users")
    .select("id")
    .eq("email", parsed.email)
    .eq("workspace_id", userRecord.workspace_id)
    .maybeSingle();

  if (existingUser) {
    throw new Error("A user with this email already exists");
  }

  // Create auth user via Supabase Admin API
  const { data: authData, error: authError } = await serviceClient.auth.admin.inviteUserByEmail(
    parsed.email,
    { data: { full_name: parsed.name } },
  );

  if (authError) throw new Error(`Failed to send invite: ${authError.message}`);
  if (!authData.user) throw new Error("No auth user returned from invite");

  // Insert users table row
  const { data: created, error: insertError } = await serviceClient
    .from("users")
    .insert({
      auth_user_id: authData.user.id,
      email: parsed.email,
      name: parsed.name,
      role: parsed.role,
      workspace_id: userRecord.workspace_id,
      org_id: parsed.orgId ?? null,
    })
    .select("id, email, name, role, is_active, created_at")
    .single();

  if (insertError) throw new Error(`Failed to create user: ${insertError.message}`);

  return created;
}

export async function updateUserRole(input: { userId: string; role: string }) {
  const { userRecord } = await requireAuth();
  requireAdmin(userRecord.role);

  const parsed = updateRoleSchema.parse(input);

  // Prevent self-demotion
  if (parsed.userId === userRecord.id) {
    const isDowngrade =
      (userRecord.role === "admin" || userRecord.role === "super_admin") &&
      parsed.role !== "admin" &&
      parsed.role !== "super_admin";
    if (isDowngrade) {
      throw new Error("Cannot demote yourself");
    }
  }

  const serviceClient = createServiceRoleClient();

  const { data, error } = await serviceClient
    .from("users")
    .update({ role: parsed.role })
    .eq("id", parsed.userId)
    .eq("workspace_id", userRecord.workspace_id)
    .select("id, role")
    .single();

  if (error) throw new Error(`Failed to update role: ${error.message}`);
  return data;
}

export async function deactivateUser(input: { userId: string }) {
  const { userRecord } = await requireAuth();
  requireAdmin(userRecord.role);

  const parsed = deactivateSchema.parse(input);

  if (parsed.userId === userRecord.id) {
    throw new Error("Cannot deactivate yourself");
  }

  const serviceClient = createServiceRoleClient();

  // Get the auth_user_id to ban at auth level
  const { data: target } = await serviceClient
    .from("users")
    .select("auth_user_id, is_active")
    .eq("id", parsed.userId)
    .eq("workspace_id", userRecord.workspace_id)
    .single();

  if (!target) throw new Error("User not found");

  // Toggle active status
  const newActive = !target.is_active;

  // Update users table
  const { error: updateError } = await serviceClient
    .from("users")
    .update({ is_active: newActive })
    .eq("id", parsed.userId);

  if (updateError) throw new Error(`Failed to update user: ${updateError.message}`);

  // Ban/unban at Supabase Auth level
  await serviceClient.auth.admin.updateUserById(target.auth_user_id, {
    ban_duration: newActive ? "none" : "876000h",
  });

  return { id: parsed.userId, is_active: newActive };
}

/** Remove a client user from their organization (sets org_id to null). */
export async function removeClientUser(userId: string) {
  const { userRecord } = await requireAuth();
  requireAdmin(userRecord.role);

  const serviceClient = createServiceRoleClient();

  const { error } = await serviceClient
    .from("users")
    .update({ org_id: null, role: "client" })
    .eq("id", userId)
    .eq("workspace_id", userRecord.workspace_id);

  if (error) throw new Error(`Failed to remove user: ${error.message}`);
  return { success: true };
}
