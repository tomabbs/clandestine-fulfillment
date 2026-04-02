"use client";

import { Package } from "lucide-react";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { useState } from "react";
import { getClientShipments, getShipmentItems, getTrackingEvents } from "@/actions/orders";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ShipmentRow = Awaited<ReturnType<typeof getClientShipments>>["shipments"][number];

export default function PortalShippingPage() {
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, status: "", carrier: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.shipments.list({ ...filters, portal: true }),
    queryFn: () => getClientShipments(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: expandedItems, isLoading: itemsLoading } = useAppQuery({
    queryKey: ["shipment-items", expandedId],
    queryFn: () => getShipmentItems(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });


  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Shipping</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by carrier..."
          value={filters.carrier}
          onChange={(e) => setFilters((f) => ({ ...f, carrier: e.target.value, page: 1 }))}
          className="w-48"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="shipped">Shipped</option>
          <option value="in_transit">In Transit</option>
          <option value="out_for_delivery">Out for Delivery</option>
          <option value="delivered">Delivered</option>
          <option value="exception">Exception</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tracking</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Ship Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Weight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.shipments ?? []).map((shipment: ShipmentRow) => {
              const orderNumber = (
                shipment as ShipmentRow & {
                  warehouse_orders?: { order_number?: string | null } | null;
                }
              ).warehouse_orders?.order_number ?? null;
              const labelSource = (shipment as ShipmentRow & { label_source?: string | null })
                .label_source;
              const customerCharged = (
                shipment as ShipmentRow & { customer_shipping_charged?: number | null }
              ).customer_shipping_charged ?? null;
              const postage = shipment.shipping_cost ?? null;
              const shippingGap =
                customerCharged != null && postage != null ? customerCharged - postage : null;

              return (
              <>
                <TableRow
                  key={shipment.id}
                  className="cursor-pointer"
                  onClick={() =>
                    setExpandedId((prev) => (prev === shipment.id ? null : shipment.id))
                  }
                >
                  <TableCell className="font-mono text-xs">
                    {shipment.tracking_number ?? "—"}
                  </TableCell>

                  {/* Order reference — links back to fulfillment page */}
                  <TableCell>
                    {orderNumber ? (
                      <a
                        href={`/portal/fulfillment?search=${encodeURIComponent(orderNumber)}`}
                        className="font-mono text-xs text-blue-600 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {orderNumber}
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Carrier + label source badge */}
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span>{shipment.carrier ?? "—"}</span>
                      {labelSource === "shipstation" && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-1 rounded">SS</span>
                      )}
                      {labelSource === "easypost" && (
                        <span className="text-xs bg-green-100 text-green-700 px-1 rounded">EP</span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell className="text-sm">
                    {shipment.ship_date ? new Date(shipment.ship_date + "T12:00:00").toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <ShipmentStatusBadge status={shipment.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {shipment.weight ? `${shipment.weight} lbs` : "—"}
                  </TableCell>
                </TableRow>

                {expandedId === shipment.id && (
                  <TableRow key={`${shipment.id}-detail`}>
                    <TableCell colSpan={6} className="bg-muted/30 p-4">
                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <h4 className="text-sm font-semibold mb-2">Items</h4>
                          {itemsLoading ? (
                            <Skeleton className="h-16 w-full" />
                          ) : !expandedItems || expandedItems.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No items recorded</p>
                          ) : (
                            <div className="space-y-1 text-sm">
                              {expandedItems.map((item) => (
                                <div key={item.id} className="flex justify-between">
                                  <span>
                                    <span className="font-mono text-xs text-muted-foreground">
                                      {item.sku}
                                    </span>{" "}
                                    {item.product_title ?? ""}
                                  </span>
                                  <span className="font-mono">x{item.quantity}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Shipping cost comparison — helps clients evaluate platform pricing */}
                          {(customerCharged != null || postage != null) && (
                            <div className="mt-3 text-sm space-y-0.5">
                              {customerCharged != null && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Customer paid</span>
                                  <span className="font-mono">${customerCharged.toFixed(2)}</span>
                                </div>
                              )}
                              {postage != null && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Postage</span>
                                  <span className="font-mono">${postage.toFixed(2)}</span>
                                </div>
                              )}
                              {shippingGap != null && (
                                <div
                                  className={`flex justify-between font-medium border-t pt-0.5 ${
                                    shippingGap >= 0 ? "text-green-700" : "text-red-600"
                                  }`}
                                >
                                  <span>Difference</span>
                                  <span className="font-mono">
                                    {shippingGap >= 0 ? "+" : ""}
                                    {shippingGap.toFixed(2)}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        <div>
                          <h4 className="text-sm font-semibold mb-2">Tracking</h4>
                          <TrackingTimeline
                            shipmentId={shipment.id}
                            trackingNumber={shipment.tracking_number}
                            carrier={shipment.carrier}
                            fetchEvents={getTrackingEvents}
                          />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
              );
            })}
            {data?.shipments.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No shipments found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </div>
  );
}

function ShipmentStatusBadge({ status }: { status: string }) {
  const config: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
  > = {
    shipped: { variant: "secondary", label: "Shipped" },
    in_transit: { variant: "secondary", label: "In Transit" },
    out_for_delivery: { variant: "default", label: "Out for Delivery" },
    delivered: { variant: "default", label: "Delivered" },
    exception: { variant: "destructive", label: "Exception" },
  };
  const c = config[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
