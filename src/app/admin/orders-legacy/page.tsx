// Phase 2.3 — direct route for the legacy multi-source orders view.
// Reachable by URL only; no sidebar entry. Kept available during cutover so
// ops can compare the two surfaces and fall back if needed. Phase 6 cutover
// removes this route entirely after the new cockpit is verified.
//
// Phase 6.3 — per-row CreateLabelPanel is gated by:
//   canPrintLegacyLabels = !shipstation_unified_shipping || staff_diagnostics
//
// i.e. label printing in the legacy view is only allowed when the cockpit
// hasn't taken over OR ops has explicitly opted into "diagnostic mode" via
// workspaces.flags.staff_diagnostics. After cutover staff has to use the new
// cockpit unless they flip staff_diagnostics for an explicit reason.

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/server/auth-context";
import { getWorkspaceFlags } from "@/lib/server/workspace-flags";
import { LegacyOrdersView } from "./_legacy-orders-view";

export default async function AdminOrdersLegacyPage() {
  let workspaceId: string;
  try {
    const ctx = await requireStaff();
    workspaceId = ctx.workspaceId;
  } catch {
    redirect("/login");
  }
  const flags = await getWorkspaceFlags(workspaceId);
  const canPrintLegacyLabels = !flags.shipstation_unified_shipping || !!flags.staff_diagnostics;
  return <LegacyOrdersView canPrintLegacyLabels={canPrintLegacyLabels} />;
}
