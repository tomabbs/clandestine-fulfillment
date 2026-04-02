"use server";

import { z } from "zod";
import { sendPortalInviteEmail } from "@/lib/clients/resend-client";
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
type InvitedUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  created_at: string;
};

export type InviteUserResult =
  | { success: true; user: InvitedUser }
  | { success: false; code: string; error: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireAdmin(role: string) {
  if (role !== "admin" && role !== "super_admin") {
    throw new Error("Only admins can manage users");
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function getUsers(filters?: { search?: string }) {
  let userRecord: { role: string; workspace_id: string };
  try {
    const auth = await requireAuth();
    userRecord = auth.userRecord;
    requireAdmin(userRecord.role);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      return [];
    }
    throw error;
  }

  const serviceClient = createServiceRoleClient();

  let query = serviceClient
    .from("users")
    .select("id, auth_user_id, email, name, role, org_id, created_at")
    .eq("workspace_id", userRecord.workspace_id)
    .order("created_at", { ascending: false });

  if (filters?.search) {
    query = query.or(`email.ilike.%${filters.search}%,name.ilike.%${filters.search}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch users: ${error.message}`);

  return data ?? [];
}

export async function inviteUser(input: InviteUserInput): Promise<InviteUserResult> {
  try {
    const { userRecord } = await requireAuth();
    requireAdmin(userRecord.role);

    const parsedResult = inviteUserSchema.safeParse(input);
    if (!parsedResult.success) {
      return {
        success: false,
        code: "INVALID_INPUT",
        error: "Please provide a valid email, name, and role.",
      };
    }
    const parsed = parsedResult.data;
    const serviceClient = createServiceRoleClient();

    // Client roles require orgId
    if ((CLIENT_ROLES as readonly string[]).includes(parsed.role) && !parsed.orgId) {
      return {
        success: false,
        code: "ORG_REQUIRED",
        error: "Client roles require an organization.",
      };
    }

    // Check for duplicate email in this workspace
    const { data: existingUser, error: existingUserError } = await serviceClient
      .from("users")
      .select("id")
      .eq("email", parsed.email)
      .eq("workspace_id", userRecord.workspace_id)
      .maybeSingle();

    if (existingUserError) {
      return {
        success: false,
        code: "USER_LOOKUP_FAILED",
        error: `Failed to check existing users: ${existingUserError.message}`,
      };
    }

    if (existingUser) {
      return {
        success: false,
        code: "USER_EXISTS",
        error: "A user with this email already exists in this workspace.",
      };
    }

    // If this email is already linked in another workspace, we cannot safely reuse auth_user_id
    // because users.auth_user_id is globally unique in this schema.
    {
      const { data: authLookup, error: authLookupError } = await serviceClient
        .from("users")
        .select("id")
        .eq("email", parsed.email)
        .neq("workspace_id", userRecord.workspace_id)
        .maybeSingle();
      if (authLookupError) {
        return {
          success: false,
          code: "AUTH_LOOKUP_FAILED",
          error: `Failed to check auth user: ${authLookupError.message}`,
        };
      }
      if (authLookup) {
        return {
          success: false,
          code: "EMAIL_IN_OTHER_WORKSPACE",
          error:
            "This email is already assigned in another workspace. Use a different email or move the existing user.",
        };
      }
    }

    // Create auth user and generate invite link.
    // IMPORTANT: Use type "magiclink" NOT "invite" — Supabase's generateLink with
    // type "invite" still sends the default Supabase invite email as a side effect,
    // even though the docs say it shouldn't. "magiclink" generates the link without
    // triggering any Supabase-hosted email. We send our own branded email via Resend.
    //
    // NOTE: .trim() is critical — if NEXT_PUBLIC_APP_URL has a trailing newline
    // (common when copy-pasted into Vercel env vars), the redirect_to URL becomes
    // "https://domain.com\n/auth/callback" which Supabase rejects as an invalid
    // redirect URL (shows as %0A in the link). Always trim before use.
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();

    // First, create the auth user if they don't exist yet
    let authUserId: string;
    const { data: existingAuthUsers } = await serviceClient.auth.admin.listUsers();
    const existingAuthUser = existingAuthUsers?.users?.find(
      (u) => u.email?.toLowerCase() === parsed.email.toLowerCase(),
    );

    if (existingAuthUser) {
      authUserId = existingAuthUser.id;
    } else {
      // Create a new auth user (without sending any email)
      const { data: newAuthUser, error: createAuthError } =
        await serviceClient.auth.admin.createUser({
          email: parsed.email,
          email_confirm: false,
          user_metadata: { full_name: parsed.name },
        });
      if (createAuthError || !newAuthUser.user) {
        return {
          success: false,
          code: "AUTH_USER_CREATE_FAILED",
          error: `Failed to create auth user: ${createAuthError?.message ?? "unknown"}`,
        };
      }
      authUserId = newAuthUser.user.id;
    }

    // Generate a magic link for the user (does NOT send any email)
    const linkResult = await serviceClient.auth.admin.generateLink({
      type: "magiclink",
      email: parsed.email,
      options: {
        redirectTo: `${appUrl}/auth/callback`,
      },
    });

    if (linkResult.error) {
      const msg = linkResult.error.message;
      const lower = msg.toLowerCase();
      if (lower.includes("rate limit")) {
        return {
          success: false,
          code: "INVITE_RATE_LIMITED",
          error:
            "Invite generation is temporarily rate-limited. Please wait a few minutes and try again.",
        };
      }
      return {
        success: false,
        code: "INVITE_LINK_FAILED",
        error: `Failed to generate invite link: ${msg}`,
      };
    }

    let inviteLink = linkResult.data.properties?.action_link;
    if (!inviteLink) {
      return {
        success: false,
        code: "INVITE_LINK_MISSING",
        error: "Invite link was generated without an action URL.",
      };
    }

    // Supabase generateLink sometimes encodes redirect_to as just the Site URL,
    // stripping the /auth/callback path. Also strip any %0A (encoded newline)
    // that may appear if NEXT_PUBLIC_APP_URL had a trailing newline in env.
    // Always rewrite redirect_to to the clean canonical callback URL.
    try {
      const linkUrl = new URL(inviteLink);
      const currentRedirect = linkUrl.searchParams.get("redirect_to") ?? "";
      // Strip encoded newlines (%0A / %0a) from whatever Supabase generated
      const cleanedRedirect = currentRedirect.replace(/%0[Aa]/g, "");
      const expectedCallback = `${appUrl}/auth/callback`;
      // Rewrite if missing /auth/callback OR if the cleaned value differs from expected
      if (!cleanedRedirect.includes("/auth/callback") || cleanedRedirect !== expectedCallback) {
        linkUrl.searchParams.set("redirect_to", expectedCallback);
        inviteLink = linkUrl.toString();
      }
    } catch {
      // URL parse failed — use link as-is
    }

    // Insert users table row
    const { data: created, error: insertError } = await serviceClient
      .from("users")
      .insert({
        auth_user_id: authUserId,
        email: parsed.email,
        name: parsed.name,
        role: parsed.role,
        workspace_id: userRecord.workspace_id,
        org_id: parsed.orgId ?? null,
      })
      .select("id, email, name, role, created_at")
      .single();

    if (insertError) {
      return {
        success: false,
        code: "USER_CREATE_FAILED",
        error: `Failed to create user: ${insertError.message}`,
      };
    }

    // Auto-add client emails to support routing
    if (parsed.orgId && (CLIENT_ROLES as readonly string[]).includes(parsed.role)) {
      await serviceClient.from("support_email_mappings").upsert(
        { workspace_id: userRecord.workspace_id, email_address: parsed.email.toLowerCase(), org_id: parsed.orgId, is_active: true },
        { onConflict: "workspace_id,email_address", ignoreDuplicates: true },
      );
    }

    try {
      await sendPortalInviteEmail({
        to: parsed.email,
        inviteLink,
        inviteeName: parsed.name,
        inviterName: userRecord.name ?? userRecord.email ?? null,
      });
    } catch (emailError) {
      // Best-effort rollback to keep retry path clean if email delivery fails.
      try {
        await serviceClient.from("users").delete().eq("id", created.id);
      } catch {}
      try {
        await serviceClient.auth.admin.deleteUser(authUserId);
      } catch {}
      const msg = emailError instanceof Error ? emailError.message : String(emailError);
      return {
        success: false,
        code: "INVITE_EMAIL_FAILED",
        error: `Failed to send invite email via Resend: ${msg}`,
      };
    }

    return { success: true, user: created as InvitedUser };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      code: "UNEXPECTED",
      error: `Unexpected invite failure: ${msg}`,
    };
  }
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
    .select("auth_user_id")
    .eq("id", parsed.userId)
    .eq("workspace_id", userRecord.workspace_id)
    .single();

  if (!target) throw new Error("User not found");

  // Check current ban status from Supabase Auth
  const { data: authUser } = await serviceClient.auth.admin.getUserById(target.auth_user_id);
  const currentlyBanned = !!authUser?.user?.banned_until;
  const newActive = currentlyBanned; // if banned, toggling makes active; if active, toggling bans

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
