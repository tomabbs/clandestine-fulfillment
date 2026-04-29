// Order Pages Transition Phase 0 — staff-only diagnostics for the
// transition. Read-only counts plus the per-workspace route-mode flip.
//
// `force-dynamic` because we always need a fresh count + the route mode
// flag is read on every render.

import {
  getOrderTransitionDiagnostics,
  type OrderTransitionDiagnostics,
} from "@/actions/order-transition-diagnostics";
import { requireStaff } from "@/lib/server/auth-context";
import { OrderTransitionDiagnosticsClient } from "./diagnostics-client";

export const dynamic = "force-dynamic";

export default async function OrderTransitionDiagnosticsPage() {
  const { workspaceId } = await requireStaff();
  let snapshot: OrderTransitionDiagnostics | null = null;
  let error: string | null = null;
  try {
    snapshot = await getOrderTransitionDiagnostics();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Order Pages Transition — Diagnostics</h1>
          <p className="text-sm text-muted-foreground">
            Workspace <code className="rounded bg-muted px-1 py-0.5 text-xs">{workspaceId}</code>
            {" — "}
            read-only snapshot of the Direct ↔ ShipStation Mirror transition. Use the rollback
            controls below to flip <code>orders_route_mode</code> per workspace during incidents.
          </p>
        </header>
        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <p className="font-medium">Failed to load diagnostics</p>
            <p className="mt-1 break-all opacity-90">{error}</p>
          </div>
        ) : snapshot ? (
          <OrderTransitionDiagnosticsClient snapshot={snapshot} />
        ) : null}
      </div>
    </div>
  );
}
