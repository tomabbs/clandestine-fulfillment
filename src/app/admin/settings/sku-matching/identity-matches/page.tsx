import { ShieldAlert } from "lucide-react";
import {
  type ListIdentityMatchesResult,
  listIdentityMatches,
} from "@/actions/sku-identity-matches";
import { requireStaff } from "@/lib/server/auth-context";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { IdentityMatchesClient } from "./identity-matches-client";

// Phase 6 Slice 6.E — staff read surface for
// `client_store_product_identity_matches` + `sku_outcome_transitions`.
//
// Gated behind `sku_autonomous_ui_enabled`: until an operator flips the
// flag, the route renders an "off" message so mistaken link clicks
// during the rollout window don't leak identity internals. The page is
// a server component that bootstraps the first 50 rows so the client
// has a meaningful render target on first paint; subsequent paging /
// filter refetches are owned by `IdentityMatchesClient` via
// `useAppQuery`.

export default async function IdentityMatchesPage() {
  let bootstrap: ListIdentityMatchesResult;
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
            in Feature Flags to view identity matches and their transition history.
          </div>
        </div>
      );
    }

    bootstrap = await listIdentityMatches({ limit: 50, offset: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to load identity matches.</p>
              <p className="mt-1 break-words text-destructive/90">{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <IdentityMatchesClient bootstrap={bootstrap} />;
}
