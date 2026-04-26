import { ShieldAlert } from "lucide-react";
import { type ListAutonomousRunsResult, listAutonomousRuns } from "@/actions/sku-autonomous-runs";
import { requireStaff } from "@/lib/server/auth-context";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { AutonomousRunsClient } from "./autonomous-runs-client";

// Phase 6 Slice 6.B — staff read surface for sku_autonomous_runs +
// sku_autonomous_decisions. Gated behind `sku_autonomous_ui_enabled`; until
// an operator flips that flag the page renders an "off" message so mistaken
// link clicks during the rollout don't leak run internals. The page is a
// server component that bootstraps the first 25 runs and defers subsequent
// paging / filter refetches to the client component via useAppQuery.

export default async function AutonomousRunsPage() {
  let bootstrap: ListAutonomousRunsResult;
  try {
    const { workspaceId } = await requireStaff();
    const flags = await getWorkspaceFlags(workspaceId);

    if (flags.sku_autonomous_ui_enabled !== true) {
      return (
        <div className="p-6">
          <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
            The autonomous SKU matching read surface is disabled for this workspace. Enable
            <code className="mx-1 rounded bg-muted px-1 font-mono text-xs">
              sku_autonomous_ui_enabled
            </code>
            in Feature Flags to view autonomous runs and decisions.
          </div>
        </div>
      );
    }

    bootstrap = await listAutonomousRuns({ limit: 25, offset: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to load autonomous runs.</p>
              <p className="mt-1 break-words text-destructive/90">{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <AutonomousRunsClient bootstrap={bootstrap} />;
}
