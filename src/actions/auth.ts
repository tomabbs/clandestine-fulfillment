"use server";

import { requireAuth } from "@/lib/server/auth-context";

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
}> {
  const { userRecord, isStaff } = await requireAuth();
  return {
    workspaceId: userRecord.workspace_id,
    orgId: userRecord.org_id,
    isStaff,
    userId: userRecord.id,
    userName: userRecord.name ?? userRecord.email ?? "Unknown",
  };
}
