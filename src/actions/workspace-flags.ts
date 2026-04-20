"use server";

// Phase 7.3 — Workspace feature-flag admin server actions.
//
// Read + write workspaces.flags safely:
//   - listWorkspaceFlags()   — current flags for the caller's workspace
//   - updateWorkspaceFlag()  — single key/value update with Zod validation
//
// Writes go through workspaceFlagsSchema (strict) so a typo in a key
// returns a 4xx instead of silently never taking effect. Cache invalidated
// after every successful write so the next request reads the new value.

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import {
  invalidateWorkspaceFlags,
  parseWorkspaceFlags,
  type WorkspaceFlags,
} from "@/lib/server/workspace-flags";

/**
 * Read the current workspace's flags. Lenient — returns whatever's in the
 * column without strict-mode validation. Use for displaying current values.
 */
export async function listWorkspaceFlags(): Promise<WorkspaceFlags> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("workspaces")
    .select("flags")
    .eq("id", workspaceId)
    .maybeSingle();
  return (data?.flags ?? {}) as WorkspaceFlags;
}

/**
 * Update a single flag key. Validates the FULL flags blob against the
 * strict Zod schema before persisting — so a typo or out-of-range value
 * returns an error rather than silently breaking strategy logic.
 *
 * Pass `value: null` to delete the key (jsonb removal).
 */
export async function updateWorkspaceFlag(input: {
  key: keyof WorkspaceFlags;
  value: unknown;
}): Promise<{ ok: true; flags: WorkspaceFlags }> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();

  const { data: current } = await supabase
    .from("workspaces")
    .select("flags")
    .eq("id", workspaceId)
    .maybeSingle();
  const currentFlags = (current?.flags ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...currentFlags };
  if (input.value === null || input.value === undefined) {
    delete next[input.key as string];
  } else {
    next[input.key as string] = input.value;
  }

  // Strict-validate the resulting blob. Throws if any key is unknown / any
  // value is wrong shape. Better to fail loudly than write a broken flag.
  const validated = parseWorkspaceFlags(next);

  const { error } = await supabase
    .from("workspaces")
    .update({ flags: validated })
    .eq("id", workspaceId);
  if (error) throw new Error(`updateWorkspaceFlag: ${error.message}`);

  invalidateWorkspaceFlags(workspaceId);
  revalidatePath("/admin/settings/feature-flags");
  return { ok: true, flags: validated };
}
