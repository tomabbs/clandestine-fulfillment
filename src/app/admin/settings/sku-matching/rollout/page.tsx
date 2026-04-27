import { ShieldAlert } from "lucide-react";
import {
  type AutonomousRolloutHealth,
  getAutonomousRolloutHealth,
} from "@/actions/sku-autonomous-rollout";
import { requireStaff } from "@/lib/server/auth-context";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { RolloutClient } from "./rollout-client";

// Phase 7 Slice 7.D — staff rollout surface for the autonomous SKU matcher.
//
// Gated behind `sku_autonomous_ui_enabled`: until an operator flips the
// flag the route renders an "off" message so mistaken link clicks during
// the rollout window don't leak canary / telemetry internals. The page is
// a server component that does the single `getAutonomousRolloutHealth()`
// read and hands the result to `<RolloutClient>`; all mutations
// (`createAutonomousCanaryReview`, `resolveAutonomousCanaryReview`) are
// invoked from the client via `useTransition` + `router.refresh()` so the
// server render stays the source of truth after every write.

export default async function AutonomousRolloutPage() {
  let bootstrap: AutonomousRolloutHealth;
  try {
    const { workspaceId } = await requireStaff();
    const flags = await getWorkspaceFlags(workspaceId);

    if (flags.sku_autonomous_ui_enabled !== true) {
      return (
        <div className="p-6">
          <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
            The autonomous SKU matching rollout surface is disabled for this workspace. Enable
            <code className="mx-1 rounded bg-muted px-1 font-mono text-xs">
              sku_autonomous_ui_enabled
            </code>
            in Feature Flags to review rollout health, canary reviews, and linkage metrics.
          </div>
        </div>
      );
    }

    bootstrap = await getAutonomousRolloutHealth();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to load autonomous rollout health.</p>
              <p className="mt-1 break-words text-destructive/90">{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <RolloutClient bootstrap={bootstrap} />;
}
