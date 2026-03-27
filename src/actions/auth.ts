"use server";

import { sendPortalInviteEmail } from "@/lib/clients/resend-client";
import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

/**
 * Returns the authenticated user's workspace and org context.
 * Used by client pages to resolve workspace_id instead of hardcoding.
 */
export async function getUserContext(): Promise<{
  workspaceId: string;
  orgId: string | null;
  isStaff: boolean;
  userId: string;
  userName: string;
  userRole: string;
}> {
  const { userRecord, isStaff } = await requireAuth();
  return {
    workspaceId: userRecord.workspace_id,
    orgId: userRecord.org_id,
    isStaff,
    userId: userRecord.id,
    userName: userRecord.name ?? userRecord.email ?? "Unknown",
    userRole: userRecord.role,
  };
}

export async function heartbeatPresence(currentPage: string): Promise<void> {
  let userRecord: Awaited<ReturnType<typeof requireAuth>>["userRecord"];
  try {
    const auth = await requireAuth();
    userRecord = auth.userRecord;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      // Best-effort tracker: ignore anonymous/transition states.
      return;
    }
    throw error;
  }
  const serviceClient = createServiceRoleClient();
  const now = new Date().toISOString();

  const { error } = await serviceClient
    .from("users")
    .update({ last_seen_at: now, last_seen_page: currentPage })
    .eq("id", userRecord.id);

  if (error) {
    if (
      error.message.includes("Could not find the 'last_seen_at' column") ||
      error.message.includes("Could not find the 'last_seen_page' column")
    ) {
      return;
    }
    throw new Error(`Failed to update user presence heartbeat: ${error.message}`);
  }
}

// ── Magic link for login page ──────────────────────────────────────────────

export type SendLoginLinkResult =
  | { success: true }
  | { success: false; code: string; error: string };

/**
 * Send a branded magic link to an existing client user.
 *
 * Uses admin.generateLink (same reliable path as the invite flow) so the
 * link is sent via Resend — not Supabase's own delivery. The client-side
 * signInWithOtp approach was unreliable because Supabase's newer PKCE flow
 * doesn't append tokens to the redirect URL in the expected format, and the
 * Supabase email is unbranded.
 */
export async function sendLoginMagicLink(email: string): Promise<SendLoginLinkResult> {
  const serviceClient = createServiceRoleClient();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();

  // Only allow sign-in for users that already exist in this workspace.
  const { data: existingUser } = await serviceClient
    .from("users")
    .select("id, name, email")
    .eq("email", email.toLowerCase().trim())
    .maybeSingle();

  if (!existingUser) {
    return {
      success: false,
      code: "USER_NOT_FOUND",
      error: "No account found for this email. Please contact your label administrator.",
    };
  }

  const linkResult = await serviceClient.auth.admin.generateLink({
    type: "magiclink",
    email: email.toLowerCase().trim(),
    options: {
      redirectTo: `${appUrl}/auth/callback`,
    },
  });

  if (linkResult.error) {
    const msg = linkResult.error.message;
    if (msg.toLowerCase().includes("rate")) {
      return {
        success: false,
        code: "RATE_LIMITED",
        error: "Too many sign-in requests. Please wait a few minutes and try again.",
      };
    }
    return {
      success: false,
      code: "LINK_FAILED",
      error: "Failed to generate sign-in link. Please try again.",
    };
  }

  let inviteLink = linkResult.data.properties?.action_link;
  if (!inviteLink) {
    return { success: false, code: "LINK_MISSING", error: "Failed to generate sign-in link." };
  }

  // Sanitize: strip %0A (encoded newline) and ensure correct redirect_to
  try {
    const linkUrl = new URL(inviteLink);
    const currentRedirect = linkUrl.searchParams.get("redirect_to") ?? "";
    const cleanedRedirect = currentRedirect.replace(/%0[Aa]/g, "");
    const expectedCallback = `${appUrl}/auth/callback`;
    if (!cleanedRedirect.includes("/auth/callback") || cleanedRedirect !== expectedCallback) {
      linkUrl.searchParams.set("redirect_to", expectedCallback);
      inviteLink = linkUrl.toString();
    }
  } catch {
    // URL parse failed — use as-is
  }

  try {
    await sendPortalInviteEmail({
      to: email,
      inviteLink,
      inviteeName: existingUser.name ?? undefined,
      inviterName: null,
    });
  } catch (emailError) {
    const msg = emailError instanceof Error ? emailError.message : String(emailError);
    return {
      success: false,
      code: "EMAIL_FAILED",
      error: `Failed to send sign-in email: ${msg}`,
    };
  }

  return { success: true };
}
