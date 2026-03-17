"use client";

import { ChevronLeft, ChevronRight, Package } from "lucide-react";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
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

type OrderRow = Awaited<ReturnType<typeof getOrders>>["orders"][number];

const SOURCE_COLORS: Record<string, string> = {
  shopify: "bg-green-100 text-green-800",
  bandcamp: "bg-blue-100 text-blue-800",
  woocommerce: "bg-purple-100 text-purple-800",
  squarespace: "bg-yellow-100 text-yellow-800",
  manual: "bg-gray-100 text-gray-800",
};

export default function AdminOrdersPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: 25,
    status: "",
    source: "",
    search: "",
    orgId: "",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.orders.list(filters),
    queryFn: () => getOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.orders.detail(expandedId ?? ""),
    queryFn: () => getOrderDetail(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search order/customer..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <select
          value={filters.source}
          onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All sources</option>
          <option value="shopify">Shopify</option>
          <option value="bandcamp">Bandcamp</option>
          <option value="woocommerce">WooCommerce</option>
          <option value="squarespace">Squarespace</option>
          <option value="manual">Manual</option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="ready_to_ship">Ready to Ship</option>
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.orders ?? []).map((order: OrderRow) => {
              const orgName =
                (order as OrderRow & { organizations?: { name: string } }).organizations?.name ??
                "—";
              return (
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
                    <TableCell>{order.customer_name ?? "—"}</TableCell>
                    <TableCell className="text-sm">{orgName}</TableCell>
                    <TableCell>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${SOURCE_COLORS[order.source] ?? "bg-gray-100"}`}
                      >
                        {order.source}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={order.fulfillment_status} />
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : "—"}
                    </TableCell>
                  </TableRow>

                  {expandedId === order.id && (
                    <TableRow key={`${order.id}-detail`}>
                      <TableCell colSpan={7} className="bg-muted/30 p-4">
                        {detailLoading ? (
                          <Skeleton className="h-32 w-full" />
                        ) : detail ? (
                          <OrderDetailExpanded detail={detail} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
            {(data?.orders ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages} ({data?.total ?? 0} total)
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page >= totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderDetailExpanded({ detail }: { detail: Awaited<ReturnType<typeof getOrderDetail>> }) {
  return (
    <div className="grid grid-cols-2 gap-6">
      <div>
        <h4 className="text-sm font-semibold mb-2">Line Items</h4>
        <div className="space-y-1 text-sm">
          {detail.items.map((item) => (
            <div key={item.id} className="flex justify-between">
              <span>
                <span className="font-mono text-xs text-muted-foreground">{item.sku}</span>{" "}
                {item.title ?? ""}
              </span>
              <span className="font-mono">
                x{item.quantity}
                {item.price != null && ` · $${Number(item.price).toFixed(2)}`}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h4 className="text-sm font-semibold mb-2">Shipments</h4>
        {detail.shipments.length === 0 ? (
          <p className="text-muted-foreground text-sm">No shipments yet</p>
        ) : (
          <div className="space-y-3">
            {detail.shipments.map((s) => (
              <div key={s.id} className="border rounded-lg p-3">
                <TrackingTimeline
                  shipmentId={s.id}
                  trackingNumber={s.tracking_number}
                  carrier={s.carrier}
                  fetchEvents={getTrackingEvents}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const config: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
  > = {
    pending: { variant: "outline", label: "Pending" },
    ready_to_ship: { variant: "secondary", label: "Ready to Ship" },
    shipped: { variant: "default", label: "Shipped" },
    delivered: { variant: "default", label: "Delivered" },
  };
  const c = config[status ?? ""] ?? { variant: "outline" as const, label: status ?? "—" };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
