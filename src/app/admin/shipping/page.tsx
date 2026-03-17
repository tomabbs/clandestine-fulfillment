"use client";

import { useCallback, useState } from "react";
import type { GetShipmentsFilters } from "@/actions/shipping";
import { getShipmentDetail, getShipments } from "@/actions/shipping";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ShipmentRow = Awaited<ReturnType<typeof getShipments>>["shipments"][number];
type ShipmentDetail = Awaited<ReturnType<typeof getShipmentDetail>>;

export default function ShippingPage() {
  const [filters, setFilters] = useState<GetShipmentsFilters>({
    page: 1,
    pageSize: 25,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.shipments.list(filters),
    queryFn: () => getShipments(filters),
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.shipments.detail(expandedId ?? ""),
    queryFn: () => getShipmentDetail(expandedId!),
    enabled: !!expandedId,
  });

  const handleFilterChange = useCallback((key: keyof GetShipmentsFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
    setExpandedId(null);
  }, []);

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shipping</h1>
        <p className="text-muted-foreground mt-1">
          {data ? `${data.total} shipments` : "Loading..."}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by org ID..."
          className="w-64"
          onChange={(e) => handleFilterChange("orgId", e.target.value)}
        />
        <Input
          type="date"
          placeholder="From"
          className="w-40"
          onChange={(e) => handleFilterChange("dateFrom", e.target.value)}
        />
        <Input
          type="date"
          placeholder="To"
          className="w-40"
          onChange={(e) => handleFilterChange("dateTo", e.target.value)}
        />
        <Input
          placeholder="Carrier..."
          className="w-40"
          onChange={(e) => handleFilterChange("carrier", e.target.value)}
        />
        <Input
          placeholder="Status..."
          className="w-40"
          onChange={(e) => handleFilterChange("status", e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Tracking Number</th>
              <th className="px-4 py-3 text-left font-medium">Carrier</th>
              <th className="px-4 py-3 text-left font-medium">Service</th>
              <th className="px-4 py-3 text-left font-medium">Ship Date</th>
              <th className="px-4 py-3 text-left font-medium">Organization</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            )}
            {data?.shipments.map((shipment: ShipmentRow) => (
              <ShipmentTableRow
                key={shipment.id}
                shipment={shipment}
                isExpanded={expandedId === shipment.id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === shipment.id ? null : shipment.id))
                }
                detail={expandedId === shipment.id ? detail : undefined}
                detailLoading={expandedId === shipment.id && detailLoading}
              />
            ))}
            {data && data.shipments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No shipments found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page === 1}
              onClick={() => setFilters((prev) => ({ ...prev, page: prev.page! - 1 }))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page === totalPages}
              onClick={() => setFilters((prev) => ({ ...prev, page: (prev.page ?? 1) + 1 }))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ShipmentTableRow({
  shipment,
  isExpanded,
  onToggle,
  detail,
  detailLoading,
}: {
  shipment: ShipmentRow;
  isExpanded: boolean;
  onToggle: () => void;
  detail: ShipmentDetail | undefined;
  detailLoading: boolean;
}) {
  const orgName =
    (shipment as ShipmentRow & { organizations?: { name: string } }).organizations?.name ?? "---";

  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-mono text-xs">{shipment.tracking_number ?? "---"}</td>
        <td className="px-4 py-3">{shipment.carrier ?? "---"}</td>
        <td className="px-4 py-3">{shipment.service ?? "---"}</td>
        <td className="px-4 py-3">
          {shipment.ship_date ? new Date(shipment.ship_date).toLocaleDateString() : "---"}
        </td>
        <td className="px-4 py-3">{orgName}</td>
        <td className="px-4 py-3">
          <StatusBadge status={shipment.status} />
        </td>
        <td className="px-4 py-3 text-right font-mono">
          {shipment.shipping_cost != null ? `$${shipment.shipping_cost.toFixed(2)}` : "---"}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b bg-muted/10">
          <td colSpan={7} className="px-6 py-4">
            {detailLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-4 w-40" />
              </div>
            ) : detail ? (
              <ShipmentExpandedDetail detail={detail} />
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

function ShipmentExpandedDetail({ detail }: { detail: ShipmentDetail }) {
  return (
    <div className="grid grid-cols-2 gap-6">
      {/* Items */}
      <div>
        <h3 className="font-medium mb-2">Shipment Items</h3>
        {detail.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items recorded.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-1 pr-4 font-medium">SKU</th>
                <th className="text-left py-1 pr-4 font-medium">Product</th>
                <th className="text-right py-1 font-medium">Qty</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((item) => (
                <tr key={item.id} className="border-b border-dashed">
                  <td className="py-1 pr-4 font-mono text-xs">{item.sku}</td>
                  <td className="py-1 pr-4">{item.product_title ?? "---"}</td>
                  <td className="py-1 text-right">{item.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Tracking Timeline */}
      <div>
        <h3 className="font-medium mb-2">Tracking Timeline</h3>
        {detail.trackingEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tracking events yet.</p>
        ) : (
          <div className="space-y-2">
            {detail.trackingEvents.map((event) => (
              <div key={event.id} className="flex gap-3 text-sm">
                <span className="text-muted-foreground whitespace-nowrap">
                  {event.event_time ? new Date(event.event_time).toLocaleString() : "---"}
                </span>
                <div>
                  <p className="font-medium">{event.status}</p>
                  {event.description && (
                    <p className="text-muted-foreground">{event.description}</p>
                  )}
                  {event.location && (
                    <p className="text-xs text-muted-foreground">{event.location}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b">
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    shipped: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    voided: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    delivered: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  };
  const colorClass =
    colors[status] ?? "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {status}
    </span>
  );
}
