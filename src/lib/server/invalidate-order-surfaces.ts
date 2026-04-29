/**
 * Order Pages Transition Phase 0 — centralized invalidation helper.
 *
 * Every mutation that touches `warehouse_orders`, `warehouse_order_items`,
 * `warehouse_shipments`, `warehouse_tracking_events`, `order_mirror_links`
 * (Phase 2), `platform_fulfillment_writebacks` (Phase 5b), the route mode
 * flag, or any direct-order ingestion path MUST call this helper instead
 * of inlining `revalidatePath` / `revalidateTag` / `queryClient.invalidateQueries`.
 *
 * The CI guard at `scripts/ci-checks/orders-no-direct-revalidate.sh`
 * enforces this — `revalidatePath('/admin/orders'` outside this file and
 * the route-mode flip action fails CI.
 *
 * The plan documents the invalidation map at
 * `docs/system_map/CACHE_ARCHITECTURE.md` (Cache Contract Addendum). Keep
 * this module's `OrderSurfaceKind` set in lockstep with that doc.
 */

import { revalidatePath } from "next/cache";

export type OrderSurfaceKind =
  | "direct.list"
  | "direct.detail"
  | "mirror.list"
  | "mirror.detail"
  | "mirrorLinks"
  | "holds"
  | "preorderDashboard"
  | "transitionDiagnostics"
  | "writebackStatus";

export interface InvalidateOrderSurfacesOptions {
  workspaceId: string;
  warehouseOrderId?: string;
  shipstationOrderId?: string;
  kinds: OrderSurfaceKind[];
}

/**
 * Server-side invalidation of order-related surfaces. Call from Server
 * Actions and Trigger tasks via the service-role client; safe to call
 * from anywhere that already runs server-side.
 *
 * Notes:
 * - We intentionally call `revalidatePath` only — React Query keys are
 *   invalidated client-side via `useAppQuery` consumers reacting to the
 *   server response; this helper is the SERVER half of the contract.
 * - `holds` invalidates `/admin/orders/holds`. `direct.list` /
 *   `direct.detail` cover `/admin/orders` once the route flip lands;
 *   pre-flip they additionally cover `/admin/orders-legacy`.
 * - `transitionDiagnostics` covers the new `/admin/orders/diagnostics`
 *   page added in Phase 0.
 * - The function is best-effort — `revalidatePath` failures are
 *   swallowed because the next request will re-render anyway.
 */
export async function invalidateOrderSurfaces(opts: InvalidateOrderSurfacesOptions): Promise<void> {
  const paths = new Set<string>();

  for (const kind of opts.kinds) {
    switch (kind) {
      case "direct.list":
      case "direct.detail":
        paths.add("/admin/orders");
        paths.add("/admin/orders-legacy");
        break;
      case "mirror.list":
      case "mirror.detail":
        paths.add("/admin/orders");
        paths.add("/admin/orders/shipstation");
        break;
      case "mirrorLinks":
        paths.add("/admin/orders");
        paths.add("/admin/orders/shipstation");
        paths.add("/admin/orders/diagnostics");
        break;
      case "holds":
        paths.add("/admin/orders/holds");
        break;
      case "preorderDashboard":
        paths.add("/admin/preorders");
        break;
      case "transitionDiagnostics":
        paths.add("/admin/orders/diagnostics");
        break;
      case "writebackStatus":
        paths.add("/admin/orders");
        if (opts.warehouseOrderId) {
          paths.add(`/admin/orders/${opts.warehouseOrderId}`);
        }
        break;
      default: {
        const _exhaustive: never = kind;
        void _exhaustive;
      }
    }
  }

  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch {
      // best-effort
    }
  }
}
