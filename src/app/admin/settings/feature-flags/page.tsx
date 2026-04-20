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

import { listWorkspaceFlags } from "@/actions/workspace-flags";
import { FeatureFlagsForm } from "./_feature-flags-form";

export const dynamic = "force-dynamic";

export default async function FeatureFlagsPage() {
  const flags = await listWorkspaceFlags();
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
