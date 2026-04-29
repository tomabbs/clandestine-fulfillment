"use server";

/**
 * Order Pages Transition Phase 4a — staff-gated read over the canonical
 * `preorder_pending_orders` view.
 *
 * Surface for the parity diagnostics tab (and Phase 6 follow-up
 * /admin/preorders refresh). Lifts both Direct + ShipStation Mirror rows
 * through one PostgREST call so a Direct vs Mirror discrepancy is
 * obvious at the data layer.
 */

import { requireStaff } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export interface PreorderPendingRow {
  surface: "direct" | "shipstation_mirror";
  orderId: string;
  workspaceId: string;
  orgId: string | null;
  orderNumber: string | null;
  customerEmail: string | null;
  customerName: string | null;
  orderCreatedAt: string;
  preorderReleaseDate: string | null;
  preorderState: string | null;
  fulfillmentStatus: string | null;
  shipstationOrderStatus: string | null;
}

export interface PreorderPendingResult {
  rows: PreorderPendingRow[];
  countsBySurface: { direct: number; shipstation_mirror: number };
}

export async function getPreorderPending(opts?: {
  /** Cap on rows returned. Defaults to 500. */
  limit?: number;
}): Promise<PreorderPendingResult> {
  const { workspaceId } = await requireStaff();
  const supabase = createServiceRoleClient();
  const limit = Math.min(2000, Math.max(1, opts?.limit ?? 500));

  const { data, error } = await supabase
    .from("preorder_pending_orders")
    .select(
      "surface, order_id, workspace_id, org_id, order_number, customer_email, customer_name, order_created_at, preorder_release_date, preorder_state, fulfillment_status, shipstation_order_status",
    )
    .eq("workspace_id", workspaceId)
    .order("order_created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`getPreorderPending failed: ${error.message}`);
  }

  const counts = { direct: 0, shipstation_mirror: 0 } as PreorderPendingResult["countsBySurface"];
  const rows: PreorderPendingRow[] = [];
  for (const r of data ?? []) {
    const surface = (r as { surface: "direct" | "shipstation_mirror" }).surface;
    if (surface === "direct") counts.direct += 1;
    else counts.shipstation_mirror += 1;
    rows.push({
      surface,
      orderId: (r as { order_id: string }).order_id,
      workspaceId: (r as { workspace_id: string }).workspace_id,
      orgId: (r as { org_id: string | null }).org_id ?? null,
      orderNumber: (r as { order_number: string | null }).order_number ?? null,
      customerEmail: (r as { customer_email: string | null }).customer_email ?? null,
      customerName: (r as { customer_name: string | null }).customer_name ?? null,
      orderCreatedAt: (r as { order_created_at: string }).order_created_at,
      preorderReleaseDate:
        (r as { preorder_release_date: string | null }).preorder_release_date ?? null,
      preorderState: (r as { preorder_state: string | null }).preorder_state ?? null,
      fulfillmentStatus: (r as { fulfillment_status: string | null }).fulfillment_status ?? null,
      shipstationOrderStatus:
        (r as { shipstation_order_status: string | null }).shipstation_order_status ?? null,
    });
  }
  return { rows, countsBySurface: counts };
}
