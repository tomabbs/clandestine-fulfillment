import { ShieldAlert } from "lucide-react";
import {
  type ListClientStockExceptionsResult,
  listClientStockExceptions,
} from "@/actions/portal-stock-exceptions";
import { requireClient } from "@/lib/server/auth-context";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { StockExceptionsClient } from "./stock-exceptions-client";

// Phase 6 Slice 6.F — client-facing "stock exceptions" page.
//
// Surfaces identity rows in `client_stock_exception` state: the
// autonomous matcher identified a client's remote listing as one of
// their warehouse variants, but warehouse ATP is 0 while the remote
// channel still lists positive stock. Clients see these so they can
// correct the mis-listed availability on their storefront before it
// produces oversells.
//
// Gated behind `client_stock_exception_reports_enabled` (workspace
// flag). Until an operator flips the flag, the route renders a
// "reports disabled" message so we don't surprise the client with
// unfamiliar data. Org scoping is enforced in two layers: the RLS
// policy `client_select_identity_matches` (migration 20260428000001)
// and the explicit `org_id=:caller.orgId` filter inside
// `listClientStockExceptions`.

export default async function PortalStockExceptionsPage() {
  let bootstrap: ListClientStockExceptionsResult;
  try {
    const { workspaceId } = await requireClient();
    const flags = await getWorkspaceFlags(workspaceId);

    if (flags.client_stock_exception_reports_enabled !== true) {
      return (
        <div className="p-6">
          <div className="space-y-2 rounded-md border bg-card p-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Stock exceptions reporting is disabled.</p>
            <p>
              Your operations partner has not enabled exception reporting for your account yet.
              Reach out to support if you'd like us to turn it on.
            </p>
          </div>
        </div>
      );
    }

    bootstrap = await listClientStockExceptions({ limit: 25, offset: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to load stock exceptions.</p>
              <p className="mt-1 break-words text-destructive/90">{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <StockExceptionsClient bootstrap={bootstrap} />;
}
