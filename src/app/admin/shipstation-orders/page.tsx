"use client";

import { ExternalLink, Loader2, Package, Search } from "lucide-react";
import { useState } from "react";
import { getShipStationOrders, type ShipStationOrder } from "@/actions/shipstation-orders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const STATUS_COLORS: Record<string, string> = {
  awaiting_shipment: "bg-yellow-100 text-yellow-800",
  awaiting_payment: "bg-orange-100 text-orange-800",
  shipped: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-700",
  on_hold: "bg-gray-100 text-gray-600",
};

const STATUS_OPTIONS = [
  { value: "awaiting_shipment", label: "Awaiting Shipment" },
  { value: "shipped", label: "Shipped" },
  { value: "awaiting_payment", label: "Awaiting Payment" },
  { value: "on_hold", label: "On Hold" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

function formatAddress(shipTo: ShipStationOrder["shipTo"]): string {
  if (!shipTo) return "—";
  const parts = [shipTo.name, shipTo.city, shipTo.state, shipTo.country].filter(Boolean);
  return parts.join(", ");
}

export default function ShipStationOrdersPage() {
  const [status, setStatus] = useState("awaiting_shipment");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading, error, refetch } = useAppQuery({
    queryKey: ["shipstation-orders", status],
    queryFn: () => getShipStationOrders({ status }),
    tier: CACHE_TIERS.REALTIME,
  });

  const orders = data?.orders ?? [];
  const total = data?.total ?? 0;

  const filtered = search
    ? orders.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
          (o.customerUsername ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (o.customerEmail ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (o.shipTo?.name ?? "").toLowerCase().includes(search.toLowerCase()),
      )
    : orders;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">ShipStation Orders</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Live order queue from ShipStation.
            {data && (
              <span className="ml-1">
                Showing {filtered.length} of {total} order{total !== 1 ? "s" : ""}.
                {total > 500 && (
                  <span className="text-amber-600 ml-1">
                    Results capped at 500 — use ShipStation filters to narrow.
                  </span>
                )}
              </span>
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search order / customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading orders from ShipStation…
        </div>
      ) : error ? (
        <div className="py-8 text-destructive text-sm">
          Failed to load orders: {(error as Error).message}
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Ship To</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Order Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    No orders found.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((order) => {
                  const isExpanded = expandedId === order.orderId;
                  const storeId = order.advancedOptions?.storeId ?? order.storeId;
                  return (
                    <>
                      <TableRow
                        key={order.orderId}
                        className="cursor-pointer"
                        onClick={() => setExpandedId(isExpanded ? null : order.orderId)}
                      >
                        <TableCell className="font-mono text-sm font-medium">
                          <a
                            href={`https://ship11.shipstation.com/orders/order-details/${order.orderId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {order.orderNumber}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </TableCell>
                        <TableCell className="text-sm">
                          <div>{order.shipTo?.name ?? order.customerUsername ?? "—"}</div>
                          {order.customerEmail && (
                            <div className="text-xs text-muted-foreground">
                              {order.customerEmail}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatAddress(order.shipTo)}
                        </TableCell>
                        <TableCell className="text-sm">
                          {order.items.length} item{order.items.length !== 1 ? "s" : ""}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`text-xs px-2 py-0.5 rounded font-medium ${
                              STATUS_COLORS[order.orderStatus] ?? "bg-gray-100 text-gray-700"
                            }`}
                          >
                            {order.orderStatus.replace(/_/g, " ")}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {order.amountPaid != null ? `$${order.amountPaid.toFixed(2)}` : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {order.orderDate ? new Date(order.orderDate).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <tr key={`${order.orderId}-detail`}>
                          <td colSpan={7} className="bg-muted/30 px-4 py-3">
                            <div className="space-y-3">
                              {/* Ship-to address */}
                              {order.shipTo && (
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                                    Ship To
                                  </p>
                                  <address className="text-sm not-italic space-y-0.5">
                                    {order.shipTo.name && (
                                      <div className="font-medium">{order.shipTo.name}</div>
                                    )}
                                    {order.shipTo.company && (
                                      <div className="text-muted-foreground">
                                        {order.shipTo.company}
                                      </div>
                                    )}
                                    {order.shipTo.street1 && (
                                      <div className="text-muted-foreground">
                                        {order.shipTo.street1}
                                      </div>
                                    )}
                                    {order.shipTo.street2 && (
                                      <div className="text-muted-foreground">
                                        {order.shipTo.street2}
                                      </div>
                                    )}
                                    {(order.shipTo.city ||
                                      order.shipTo.state ||
                                      order.shipTo.postalCode) && (
                                      <div className="text-muted-foreground">
                                        {[
                                          order.shipTo.city,
                                          order.shipTo.state,
                                          order.shipTo.postalCode,
                                        ]
                                          .filter(Boolean)
                                          .join(", ")}
                                      </div>
                                    )}
                                    {order.shipTo.country && order.shipTo.country !== "US" && (
                                      <div className="text-muted-foreground">
                                        {order.shipTo.country}
                                      </div>
                                    )}
                                  </address>
                                </div>
                              )}

                              {/* Line items */}
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                                  Items
                                </p>
                                <div className="space-y-1">
                                  {order.items.map((item, i) => (
                                    <div
                                      key={item.orderItemId ?? i}
                                      className="flex items-baseline justify-between gap-4 text-sm"
                                    >
                                      <div className="min-w-0">
                                        {item.sku && (
                                          <span className="font-mono text-xs text-muted-foreground mr-1.5">
                                            {item.sku}
                                          </span>
                                        )}
                                        <span>{item.name ?? "—"}</span>
                                      </div>
                                      <span className="font-mono text-xs shrink-0 text-right whitespace-nowrap">
                                        x{item.quantity}
                                        {item.unitPrice != null && (
                                          <span className="text-muted-foreground ml-1">
                                            · ${item.unitPrice.toFixed(2)}
                                          </span>
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {storeId && (
                                <p className="text-xs text-muted-foreground">Store ID: {storeId}</p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
