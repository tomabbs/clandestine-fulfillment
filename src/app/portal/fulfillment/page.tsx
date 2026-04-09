"use client";

import { CheckCircle, Package } from "lucide-react";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
import { Badge } from "@/components/ui/badge";
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

type OrderRow = Awaited<ReturnType<typeof getOrders>>["orders"][number];

export default function PortalFulfillmentPage() {
  const [filters, setFilters] = useState({ page: 1, pageSize: 50, status: "", search: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.orders.list({ ...filters, portal: true }),
    queryFn: () => getOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.orders.detail(expandedId ?? ""),
    queryFn: () => getOrderDetail(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Fulfillment</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search order number..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="unfulfilled">Unfulfilled</option>
          <option value="fulfilled">Fulfilled</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <>
          {data && data.total > 0 && (
            <PaginationBar
              page={filters.page}
              pageSize={filters.pageSize}
              total={data.total}
              onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
              onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
            />
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.orders ?? []).map((order: OrderRow) => (
                <>
                  <TableRow
                    key={order.id}
                    className="cursor-pointer"
                    onClick={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{order.order_number ?? "—"}</span>
                        {order.is_preorder && (
                          <Badge variant="secondary" className="text-xs">
                            Pre-Order
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(order.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{order.customer_name ?? order.customer_email ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {Array.isArray(order.line_items) ? order.line_items.length : 0} item(s)
                    </TableCell>
                    <TableCell>
                      <FulfillmentStatusBadge status={order.fulfillment_status} />
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : "—"}
                    </TableCell>
                  </TableRow>

                  {expandedId === order.id && (
                    <TableRow key={`${order.id}-detail`}>
                      <TableCell colSpan={6} className="bg-muted/30 p-4">
                        {detailLoading ? (
                          <Skeleton className="h-32 w-full" />
                        ) : detail ? (
                          <OrderExpandedDetail detail={detail} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))}
              {(data?.orders ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    No fulfillment orders found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </>
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

function FulfillmentStatusBadge({ status }: { status: string | null }) {
  const config: Record<string, { variant: "default" | "secondary" | "outline"; label: string }> = {
    unfulfilled: { variant: "outline", label: "Unfulfilled" },
    fulfilled: { variant: "default", label: "Fulfilled" },
    shipped: { variant: "secondary", label: "Shipped" },
    delivered: { variant: "default", label: "Delivered" },
  };
  const c = config[status ?? "unfulfilled"] ?? {
    variant: "outline" as const,
    label: status ?? "Unknown",
  };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

function OrderExpandedDetail({ detail }: { detail: Awaited<ReturnType<typeof getOrderDetail>> }) {
  const { order, items, shipments } = detail;
  if (!order) return null;

  const isBandcamp = (order as { source?: string }).source === "bandcamp";
  const fulfillmentStatus = (order as { fulfillment_status?: string | null }).fulfillment_status;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Column 1: Line Items */}
      <div>
        <h4 className="text-sm font-semibold mb-2">Line Items</h4>
        <div className="space-y-1 text-sm">
          {items.map((item) => (
            <div key={item.id} className="flex justify-between">
              <span>
                <span className="font-mono text-xs text-muted-foreground">{item.sku}</span>{" "}
                {item.title ?? ""}
              </span>
              <span className="font-mono">x{item.quantity}</span>
            </div>
          ))}
          {items.length === 0 && <p className="text-muted-foreground">No items</p>}
        </div>
      </div>

      {/* Column 2: Status + Shipments */}
      <div className="space-y-4">
        {/* Section A: Bandcamp Platform Status */}
        {isBandcamp && (
          <div>
            <h4 className="text-sm font-semibold mb-1">Bandcamp Status</h4>
            {fulfillmentStatus === "fulfilled" ? (
              <Badge variant="default" className="gap-1">
                <CheckCircle className="h-3 w-3" /> Fulfilled on Bandcamp
              </Badge>
            ) : (
              <Badge variant="outline">Unfulfilled on Bandcamp</Badge>
            )}
          </div>
        )}

        {/* Section B: Shipment & Tracking */}
        <div>
          <h4 className="text-sm font-semibold mb-2">Shipment & Tracking</h4>
          {shipments.length > 0 ? (
            <div className="space-y-3">
              {shipments.map((s) => (
                <div key={s.id} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-xs text-muted-foreground truncate">
                      {s.tracking_number ?? "No tracking number"}
                    </span>
                    <a
                      href={`/portal/shipping?search=${encodeURIComponent(s.tracking_number ?? "")}`}
                      className="text-xs text-blue-600 hover:underline shrink-0 ml-2"
                    >
                      Shipping details →
                    </a>
                  </div>
                  <TrackingTimeline
                    shipmentId={s.id}
                    trackingNumber={s.tracking_number}
                    carrier={s.carrier}
                    fetchEvents={getTrackingEvents}
                  />
                </div>
              ))}
            </div>
          ) : fulfillmentStatus === "fulfilled" ? (
            <p className="text-sm text-muted-foreground">
              Fulfilled — tracking not available in this system.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Not yet shipped.</p>
          )}
        </div>
      </div>
    </div>
  );
}
