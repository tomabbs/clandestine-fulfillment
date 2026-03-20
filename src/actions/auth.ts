"use server";

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
