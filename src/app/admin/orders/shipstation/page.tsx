// Order Pages Transition Phase 0 — explicit ShipStation Mirror surface.
//
// This route is the long-term home of the existing OrdersCockpit (the
// ShipStation-backed view). Phase 0 introduces the route as a STABLE
// alias for the cockpit so staff have a permanent landing page that does
// not move around as the route-mode flag flips. /admin/orders is still
// the primary surface; this is the explicit "mirror" view.
//
// Phase 6 finishes the split — the route flip there only changes which
// view renders at /admin/orders. This `/shipstation` route is unchanged
// across the entire transition, so deep-links to it never break.

import Link from "next/link";
import { requireStaff } from "@/lib/server/auth-context";
import { OrdersCockpit } from "../_components/orders-cockpit";

export const dynamic = "force-dynamic";

export default async function AdminOrdersShipstationMirrorPage() {
  const { workspaceId } = await requireStaff();

  return (
    <>
      <ShipstationMirrorBanner />
      <OrdersCockpit workspaceId={workspaceId} />
    </>
  );
}

function ShipstationMirrorBanner() {
  return (
    <div className="border-b bg-slate-50 px-4 py-2 text-sm text-slate-800 dark:bg-slate-900 dark:text-slate-200">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">ShipStation Mirror</span>
        <span className="opacity-80">
          Orders sourced from the ShipStation cockpit pipeline. Use this view for active label
          buying, scan-to-verify, and ShipStation-specific operations during the transition.
        </span>
        <Link
          href="/admin/orders"
          className="ml-auto underline underline-offset-2 hover:text-slate-600 dark:hover:text-slate-100"
        >
          ← Back to Direct Orders
        </Link>
        <Link
          href="/admin/orders/diagnostics"
          className="underline underline-offset-2 hover:text-slate-600 dark:hover:text-slate-100"
        >
          Diagnostics
        </Link>
      </div>
    </div>
  );
}
