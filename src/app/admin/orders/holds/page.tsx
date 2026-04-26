import { ShieldAlert } from "lucide-react";
import { type ListOrderHoldsResult, listOrderHolds } from "@/actions/order-holds";
import { HoldsClient } from "./holds-client";

// Phase 6 Slice 6.D — staff page for orders currently under a Clandestine-
// initiated fulfillment hold (`warehouse_orders.fulfillment_hold='on_hold'`).
// Uses the Phase 3 release RPC wrapper via the Slice 6.C Server Actions. No
// feature flag — the autonomous-matching emergency-pause flag gates the
// FLOW of new holds, not staff access to resolve what already exists.

export default async function OrderHoldsPage() {
  let bootstrap: ListOrderHoldsResult;
  try {
    bootstrap = await listOrderHolds({ limit: 50, offset: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to load order holds.</p>
              <p className="mt-1 break-words text-destructive/90">{message}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <HoldsClient bootstrap={bootstrap} />;
}
