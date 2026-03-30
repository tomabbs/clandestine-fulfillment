"use server";

import { fetchOrders, type ShipStationOrder } from "@/lib/clients/shipstation";
import { requireStaff } from "@/lib/server/auth-context";

export type { ShipStationOrder };

export interface ShipStationOrderFilters {
  status?: string; // 'awaiting_shipment' | 'shipped' | 'awaiting_payment' | 'all'
  page?: number;
  pageSize?: number;
}

/**
 * Fetch live ShipStation orders directly from the ShipStation API.
 * Staff-only. No DB read/write — data is always current.
 *
 * Used by the ShipStation Orders page as the team's working order queue
 * during the bridge period (until Shopify app approval + EasyPost transition).
 */
export async function getShipStationOrders(filters: ShipStationOrderFilters = {}) {
  await requireStaff();
  return fetchOrders({
    orderStatus: filters.status ?? "awaiting_shipment",
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? 500,
  });
}
