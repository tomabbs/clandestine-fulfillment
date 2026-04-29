// Phase 2.3 + 2.4 — Flag-gated entry to /admin/orders.
// Order Pages Transition Phase 0 — `orders_route_mode` becomes the
// canonical control. Legacy `shipstation_unified_shipping` is the fallback
// when `orders_route_mode` is unset (most workspaces today).
//
// Effective routing logic:
//   1. workspaces.flags.orders_route_mode='direct'             → LegacyOrdersView (becomes Direct in Phase 6)
//   2. workspaces.flags.orders_route_mode='shipstation_mirror' → OrdersCockpit (rollback path)
//   3. orders_route_mode UNSET, shipstation_unified_shipping=TRUE  → OrdersCockpit (legacy default)
//   4. orders_route_mode UNSET, shipstation_unified_shipping=FALSE → LegacyOrdersView (legacy default)
//
// The transition banner is always shown so staff know they are on the
// transitional surface and can find the diagnostics page + the rollback
// switch.

import Link from "next/link";
import { requireStaff } from "@/lib/server/auth-context";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { LegacyOrdersView } from "../orders-legacy/_legacy-orders-view";
import { DirectOrdersView } from "./_components/direct-orders-view";
import { OrdersCockpit } from "./_components/orders-cockpit";

// Auth-gated + reads cookies via requireStaff() → never statically renderable.
// `force-dynamic` is doubly important post-Phase-0 because the route mode
// flag must be re-read on every request — App Router's default ISR/data
// cache would otherwise silently honor a stale flag mid-incident, producing
// a non-functional rollback that creates false confidence.
export const dynamic = "force-dynamic";

export default async function AdminOrdersPage() {
  const { workspaceId } = await requireStaff();
  const flags = await getWorkspaceFlags(workspaceId);

  const routeMode = flags.orders_route_mode ?? null;
  const showCockpit =
    routeMode === "shipstation_mirror" ||
    (routeMode === null && (flags.shipstation_unified_shipping ?? false));

  // Phase 3 — when staff explicitly opts a workspace into `direct`, render
  // the new Direct Orders view. The legacy view stays as the fallback so
  // workspaces without the explicit opt-in continue to see the cockpit /
  // legacy multi-source UI exactly as today.
  const showDirect = routeMode === "direct";

  return (
    <>
      <OrdersTransitionBanner mode={showCockpit ? "shipstation_mirror" : "direct"} />
      {showCockpit ? (
        <OrdersCockpit workspaceId={workspaceId} />
      ) : showDirect ? (
        <DirectOrdersView workspaceId={workspaceId} />
      ) : (
        <LegacyOrdersView canPrintLegacyLabels />
      )}
    </>
  );
}

function OrdersTransitionBanner({ mode }: { mode: "direct" | "shipstation_mirror" }) {
  const message =
    mode === "direct"
      ? "Direct order data from platform-native sync. Parity in progress — use ShipStation Mirror for active label workflows during transition."
      : "ShipStation cockpit. Direct Orders are coming online at /admin/orders (rollback active per workspace).";

  return (
    <div className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">Order Pages Transition</span>
        <span className="opacity-90">{message}</span>
        <Link
          href="/admin/orders/diagnostics"
          className="ml-auto underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-100"
        >
          Open transition diagnostics →
        </Link>
        <Link
          href="/admin/orders/shipstation"
          className="underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-100"
        >
          ShipStation Mirror
        </Link>
      </div>
    </div>
  );
}
