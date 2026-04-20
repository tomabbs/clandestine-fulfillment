// Phase 7.3 — Feature flag admin page.
//
// Single-workspace UX: render the current flags + provide flip controls
// for the most-used keys. Staff can also clear keys (jsonb removal).
// Writes go through updateWorkspaceFlag which validates the FULL flags
// blob via Zod — strict mode rejects typos so a misnamed flag returns an
// error instead of silently never taking effect.
//
// Sensitive flags (cutover-related) are tagged with a CONFIRM dialog
// pattern in the client component to prevent accidental clicks.

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { WorkspaceFlags } from "@/lib/server/workspace-flags";
import { FeatureFlagsForm } from "./_feature-flags-form";

export default async function FeatureFlagsPage() {
  // Wrap auth in try/catch — Next.js's force-dynamic + thrown async error
  // path produces a raw 500 instead of routing to the nearest error.tsx
  // boundary. Catching here lets us redirect to /login cleanly for the
  // unauthenticated case.
  let workspaceId: string;
  try {
    const ctx = await requireStaff();
    workspaceId = ctx.workspaceId;
  } catch {
    redirect("/login");
  }
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("workspaces")
    .select("flags")
    .eq("id", workspaceId)
    .maybeSingle();
  const flags = (data?.flags ?? {}) as WorkspaceFlags;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Workspace feature flags</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Per-workspace settings stored in <code className="text-xs">workspaces.flags</code> JSONB.
          All writes validated against the strict Zod schema in{" "}
          <code className="text-xs">src/lib/server/workspace-flags.ts</code> — typos rejected.
        </p>
      </div>
      <FeatureFlagsForm initialFlags={flags} />
    </div>
  );
}
