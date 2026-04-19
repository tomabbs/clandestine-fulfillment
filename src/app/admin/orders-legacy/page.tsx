// Phase 2.3 — direct route for the legacy multi-source orders view.
// Reachable by URL only; no sidebar entry. Kept available during cutover so
// ops can compare the two surfaces and fall back if needed. Phase 6 cutover
// removes this route entirely after the new cockpit is verified.

import { LegacyOrdersView } from "./_legacy-orders-view";

export default function AdminOrdersLegacyPage() {
  return <LegacyOrdersView />;
}
