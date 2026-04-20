"use client";

import { Package } from "lucide-react";
import { useState } from "react";
import { getClientShipments, getShipmentItems, getTrackingEvents } from "@/actions/orders";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ShipmentRow = Awaited<ReturnType<typeof getClientShipments>>["shipments"][number];

export default function PortalShippingPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    status: "",
    carrier: "",
    search: "",
  });
  useListPaginationPreference("portal/shipping", filters, setFilters);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error } = useAppQuery({
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

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Shipping</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  return (
    <PageShell
      title="Shipping"
      maxWidth="full"
      toolbar={
        <PageToolbar>
          <Input
            placeholder="Search tracking..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            className="w-48"
          />
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
        </PageToolbar>
      }
    >
      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}

      <BlockList
        className="mt-3"
        items={data?.shipments ?? []}
        totalCount={data?.total}
        itemKey={(shipment) => shipment.id}
        loading={isLoading}
        density="ops"
        ariaLabel="Client shipments"
        expandedKeys={
          expandedId
            ? (new Set<string | number>([expandedId]) as Set<string | number>)
            : (new Set<string | number>() as Set<string | number>)
        }
        onExpandedKeysChange={(keys) => {
          const next = Array.from(keys)[0];
          setExpandedId(next ? String(next) : null);
        }}
        renderHeader={({ row, toggleExpanded }) => {
          const shipment = row as ShipmentRow;
          const orderNumber = (
            shipment as ShipmentRow & {
              warehouse_orders?: { order_number?: string | null } | null;
            }
          ).warehouse_orders?.order_number;
          return (
            <div className="min-w-0 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-xs">{shipment.tracking_number ?? "—"}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{shipment.carrier ?? "—"}</span>
                  {orderNumber ? (
                    <a
                      href={`/portal/fulfillment?search=${encodeURIComponent(orderNumber)}`}
                      className="text-blue-600 hover:underline"
                    >
                      {orderNumber}
                    </a>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleExpanded();
                }}
              >
                Details
              </button>
            </div>
          );
        }}
        renderExceptionZone={({ row }) => {
          const shipment = row as ShipmentRow;
          return <ShipmentStatusBadge status={shipment.status} />;
        }}
        renderBody={({ row }) => {
          const shipment = row as ShipmentRow;
          const labelSource = (shipment as ShipmentRow & { label_source?: string | null })
            .label_source;
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <BlockMetric
                label="Ship date"
                value={
                  shipment.ship_date
                    ? new Date(`${shipment.ship_date}T12:00:00`).toLocaleDateString()
                    : "—"
                }
              />
              <BlockMetric
                label="Weight"
                value={shipment.weight ? `${shipment.weight} lbs` : "—"}
              />
              <BlockMetric label="Label source" value={labelSource ?? "—"} />
              <BlockMetric
                label="Postage"
                value={
                  shipment.shipping_cost != null ? `$${shipment.shipping_cost.toFixed(2)}` : "—"
                }
              />
            </div>
          );
        }}
        renderExpanded={({ row }) => {
          const shipment = row as ShipmentRow;
          const customerCharged = (
            shipment as ShipmentRow & { customer_shipping_charged?: number | null }
          ).customer_shipping_charged;
          const postage = shipment.shipping_cost ?? null;
          const shippingGap =
            customerCharged != null && postage != null ? customerCharged - postage : null;
          return (
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
            </div>
          );
        }}
        emptyState={<EmptyState icon={Package} title="No shipments found" />}
      />

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </PageShell>
  );
}

function BlockMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
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
