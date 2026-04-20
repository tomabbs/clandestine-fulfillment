"use client";

import { CheckCircle, Package } from "lucide-react";
import { useState } from "react";
import { getClientOrderDetail, getClientOrders, getTrackingEvents } from "@/actions/orders";
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

type OrderRow = Awaited<ReturnType<typeof getClientOrders>>["orders"][number];

export default function PortalFulfillmentPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    status: "",
    search: "",
  });
  useListPaginationPreference("portal/fulfillment", filters, setFilters);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error } = useAppQuery({
    queryKey: queryKeys.orders.list({ ...filters, portal: true }),
    queryFn: () => getClientOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.orders.detail(expandedId ?? ""),
    queryFn: () => getClientOrderDetail(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Fulfillment</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  return (
    <PageShell
      title="Fulfillment"
      maxWidth="full"
      toolbar={
        <PageToolbar>
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
        items={data?.orders ?? []}
        totalCount={data?.total}
        loading={isLoading}
        itemKey={(order) => order.id}
        density="ops"
        ariaLabel="Fulfillment orders"
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
          const order = row as OrderRow;
          return (
            <div className="min-w-0 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-sm">{order.order_number ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(order.created_at).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {order.is_preorder && (
                  <Badge variant="secondary" className="text-xs">
                    Pre-Order
                  </Badge>
                )}
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
            </div>
          );
        }}
        renderExceptionZone={({ row }) => (
          <FulfillmentStatusBadge status={(row as OrderRow).fulfillment_status} />
        )}
        renderBody={({ row }) => {
          const order = row as OrderRow;
          return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Metric label="Customer" value={order.customer_name ?? order.customer_email ?? "—"} />
              <Metric
                label="Items"
                value={`${Array.isArray(order.line_items) ? order.line_items.length : 0} item(s)`}
              />
              <Metric
                label="Total"
                value={order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : "—"}
                mono
              />
              <Metric
                label="Status"
                value={order.fulfillment_status?.replace(/_/g, " ") ?? "unfulfilled"}
              />
            </div>
          );
        }}
        renderExpanded={() => (
          <div className="rounded-md border bg-muted/30 p-4">
            {detailLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : detail ? (
              <OrderExpandedDetail detail={detail} />
            ) : null}
          </div>
        )}
        emptyState={<EmptyState icon={Package} title="No fulfillment orders found" />}
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

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-sm" : "text-sm"}>{value}</p>
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

function OrderExpandedDetail({
  detail,
}: {
  detail: Awaited<ReturnType<typeof getClientOrderDetail>>;
}) {
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
