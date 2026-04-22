// Phase 2.3 + 2.4 — Flag-gated entry to /admin/orders.
//
// When workspaces.flags.shipstation_unified_shipping is TRUE → render the
//   new ShipStation-backed cockpit (Phase 2.2).
// When FALSE (default) → render the legacy multi-source view via import
//   shim. The legacy view is also reachable directly at /admin/orders-legacy
//   for ops use during cutover.
//
// Phase 6 cutover removes the import shim and turns this into a thin wrapper
// over <OrdersCockpit /> only.

import { requireStaff } from "@/lib/server/auth-context";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { LegacyOrdersView } from "../orders-legacy/_legacy-orders-view";
import { OrdersCockpit } from "./_components/orders-cockpit";

export default async function AdminOrdersPage() {
  const { workspaceId } = await requireStaff();
  const flags = await getWorkspaceFlags(workspaceId);

  if (flags.shipstation_unified_shipping) {
    // workspaceId is passed as a prop so OrdersCockpit can build scope-aware
    // v2 query keys without an extra round-trip to fetch auth context client-side.
    return <OrdersCockpit workspaceId={workspaceId} />;
  }
  // Phase 6.3 — pre-cutover (cockpit flag OFF): legacy view IS the active label
  // printing surface, so labels are always allowed there. After cutover the
  // shim is removed entirely (this branch becomes dead code).
  return <LegacyOrdersView canPrintLegacyLabels />;
}
