// Phase 2.3 — moved from src/app/admin/orders/page.tsx as part of the
// route migration. The body is preserved verbatim and re-rendered in two
// places: (a) /admin/orders-legacy/page.tsx (direct URL access for ops
// during cutover), and (b) /admin/orders/page.tsx when
// workspaces.flags.shipstation_unified_shipping is FALSE (import shim).
//
// DO NOT modify this file as part of Phase 2 work. Edits to the legacy view
// happen on its own roadmap; cockpit work goes in
// src/app/admin/orders/_components/OrdersCockpit.tsx instead.
"use client";

import { Check, CheckCircle, Copy, Package } from "lucide-react";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
import { CreateLabelPanel } from "@/components/shipping/create-label-panel";
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
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type OrderRow = Awaited<ReturnType<typeof getOrders>>["orders"][number];

const SOURCE_COLORS: Record<string, string> = {
  shopify: "bg-green-100 text-green-800",
  bandcamp: "bg-blue-100 text-blue-800",
  woocommerce: "bg-purple-100 text-purple-800",
  squarespace: "bg-yellow-100 text-yellow-800",
  discogs: "bg-orange-100 text-orange-800",
  manual: "bg-gray-100 text-gray-800",
};

export interface LegacyOrdersViewProps {
  /**
   * Phase 6.3 — when FALSE (default after cutover), per-row CreateLabelPanel
   * is replaced with a "use the new cockpit" notice. Pass TRUE pre-cutover or
   * when workspaces.flags.staff_diagnostics is set, so ops can still use
   * the legacy surface for diagnostic label printing.
   */
  canPrintLegacyLabels?: boolean;
}

export function LegacyOrdersView({
  canPrintLegacyLabels: canPrintLegacyLabelsProp = true,
}: LegacyOrdersViewProps = {}) {
  const canPrintLegacyLabels = canPrintLegacyLabelsProp;
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    status: "",
    source: "",
    search: "",
    orgId: "",
  });
  // Phase 2.3: pagination key changed from "admin/orders" to
  // "admin/orders-legacy" so the legacy view and the new cockpit don't
  // share pagination state when staff toggle between them.
  useListPaginationPreference("admin/orders-legacy", filters, setFilters);
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
          <option value="discogs">Discogs</option>
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
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm">{order.order_number ?? "—"}</span>
                          {order.is_preorder && (
                            <Badge variant="secondary" className="text-xs">
                              Pre-Order
                            </Badge>
                          )}
                          {order.source === "bandcamp" &&
                            (order as OrderRow & { bandcamp_payment_id?: number | null })
                              .bandcamp_payment_id != null && (
                              <Badge variant="outline" className="text-xs font-mono">
                                BC{" "}
                                {
                                  (order as OrderRow & { bandcamp_payment_id?: number })
                                    .bandcamp_payment_id
                                }
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
                        {order.total_price != null
                          ? `$${Number(order.total_price).toFixed(2)}`
                          : "—"}
                      </TableCell>
                    </TableRow>

                    {expandedId === order.id && (
                      <TableRow key={`${order.id}-detail`}>
                        <TableCell colSpan={7} className="bg-muted/30 p-4">
                          {detailLoading ? (
                            <Skeleton className="h-32 w-full" />
                          ) : detail ? (
                            <OrderDetailExpanded
                              detail={detail}
                              canPrintLegacyLabels={canPrintLegacyLabels}
                            />
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

/**
 * Bandcamp formats item_name as "{Album}: {Item} by {Artist}".
 * When the album title matches the start of the item title, the album name
 * appears twice (e.g. "Seeing Is Forgetting: Seeing Is Forgetting (Black 12" LP)").
 * Strip the redundant prefix so we only show "{Item} by {Artist}".
 */
function cleanItemTitle(title: string | null): string | null {
  if (!title) return null;
  const colonIdx = title.indexOf(": ");
  if (colonIdx <= 0) return title;
  const albumPrefix = title.substring(0, colonIdx);
  const rest = title.substring(colonIdx + 2);
  // If the rest of the string starts with the album prefix, it's duplicated — drop it
  if (rest.startsWith(albumPrefix)) return rest;
  return title;
}

function OrderDetailExpanded({
  detail,
  canPrintLegacyLabels,
}: {
  detail: Awaited<ReturnType<typeof getOrderDetail>>;
  canPrintLegacyLabels: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const orderId = detail.order?.id as string;
  const order = detail.order as {
    source?: string;
    bandcamp_payment_id?: number | null;
    fulfillment_status?: string | null;
  };
  const showBandcamp = order.source === "bandcamp" && order.bandcamp_payment_id != null;
  const isUnfulfilled =
    !order.fulfillment_status ||
    order.fulfillment_status === "unfulfilled" ||
    order.fulfillment_status === "pending";
  // Hide Create Label when a shipment is already linked — order has been shipped.
  const hasLinkedShipment = detail.shipments.length > 0;

  const handleCopyPaymentId = async () => {
    const id = String(order.bandcamp_payment_id);
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: selectable text remains
    }
  };

  const shippingAddr = detail.order?.shipping_address as Record<string, string | undefined> | null;

  return (
    <div className="space-y-4">
      {/* Line Items — full width */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Line Items
        </h4>
        <div className="space-y-1.5 text-sm">
          {detail.items.length === 0 ? (
            <p className="text-muted-foreground">No items</p>
          ) : (
            detail.items.map((item) => (
              <div key={item.id} className="flex items-baseline justify-between gap-4">
                <div className="min-w-0">
                  {item.sku && (
                    <span className="font-mono text-xs text-muted-foreground mr-1.5">
                      {item.sku}
                    </span>
                  )}
                  <span>{cleanItemTitle(item.title) ?? "—"}</span>
                </div>
                <span className="font-mono text-xs shrink-0 text-right whitespace-nowrap">
                  x{item.quantity}
                  {item.price != null && (
                    <span className="text-muted-foreground ml-1">
                      · ${Number(item.price).toFixed(2)}
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Ship To — full width */}
      {shippingAddr && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Ship To
          </h4>
          <address className="text-sm not-italic space-y-0.5">
            {(shippingAddr.name || shippingAddr.firstName) && (
              <div className="font-medium">
                {shippingAddr.name ??
                  `${shippingAddr.firstName ?? ""} ${shippingAddr.lastName ?? ""}`.trim()}
              </div>
            )}
            {shippingAddr.street1 && (
              <div className="text-muted-foreground">{shippingAddr.street1}</div>
            )}
            {shippingAddr.street2 && (
              <div className="text-muted-foreground">{shippingAddr.street2}</div>
            )}
            {(shippingAddr.city || shippingAddr.state || shippingAddr.zip) && (
              <div className="text-muted-foreground">
                {[shippingAddr.city, shippingAddr.state, shippingAddr.zip]
                  .filter(Boolean)
                  .join(", ")}
              </div>
            )}
            {shippingAddr.country && shippingAddr.country !== "US" && (
              <div className="text-muted-foreground">{shippingAddr.country}</div>
            )}
          </address>
        </div>
      )}

      {/* Section A: Bandcamp Platform Status — what the Bandcamp API reports */}
      {order.source === "bandcamp" && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Bandcamp Platform Status
          </h4>
          {order.fulfillment_status === "fulfilled" ? (
            <Badge variant="default" className="gap-1">
              <CheckCircle className="h-3 w-3" /> Fulfilled on Bandcamp
            </Badge>
          ) : (
            <Badge variant="outline">Unfulfilled on Bandcamp</Badge>
          )}
        </div>
      )}

      {/* Section B: Shipment & Tracking — what our system has */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Shipment & Tracking
        </h4>
        {detail.shipments.length > 0 ? (
          <div className="space-y-3">
            {detail.shipments.map((s) => (
              <div key={s.id} className="border rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.tracking_number ?? "No tracking number"}
                  </span>
                  <a
                    href={`/admin/shipping?search=${encodeURIComponent(s.tracking_number ?? "")}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    View in Shipping Log →
                  </a>
                </div>
                <TrackingTimeline
                  shipmentId={s.id}
                  trackingNumber={s.tracking_number}
                  carrier={s.carrier}
                  fetchEvents={getTrackingEvents}
                />
                {order.fulfillment_status !== "fulfilled" && order.source === "bandcamp" && (
                  <p className="text-xs text-amber-600 mt-2">
                    Shipped — Bandcamp not yet notified. Use "Mark Shipped on Bandcamp" to sync
                    tracking.
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : order.fulfillment_status === "fulfilled" ? (
          <p className="text-sm text-muted-foreground">
            Fulfilled externally — no label created in this system.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No shipments yet.</p>
        )}
      </div>

      {/* Create Label — hidden when a shipment already exists.
          Phase 6.3: also gated by canPrintLegacyLabels — set to FALSE after
          cutover so labels go through the new cockpit only. Set to TRUE pre-
          cutover OR when workspaces.flags.staff_diagnostics is enabled. */}
      {!hasLinkedShipment && isUnfulfilled && orderId && canPrintLegacyLabels && (
        <CreateLabelPanel
          orderId={orderId}
          orderType="fulfillment"
          customerShippingCharged={
            (detail.order as { shipping_cost?: number | null }).shipping_cost ?? null
          }
        />
      )}
      {!hasLinkedShipment && isUnfulfilled && orderId && !canPrintLegacyLabels && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Label printing moved to the new Orders cockpit.</p>
          <p className="text-xs mt-1">
            Open{" "}
            <a href="/admin/orders" className="underline">
              /admin/orders
            </a>{" "}
            to print this label. The legacy view stays available for diagnostics; flip{" "}
            <code className="text-xs">workspaces.flags.staff_diagnostics = true</code> to re-enable
            label printing here.
          </p>
        </div>
      )}

      {showBandcamp && (
        <div className="border rounded-lg p-3 bg-muted/30">
          <h4 className="text-sm font-semibold mb-2">Bandcamp</h4>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Payment ID:</span>
            <span className="font-mono text-sm select-all">{order.bandcamp_payment_id}</span>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={handleCopyPaymentId}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Use this ID when linking a shipment to Bandcamp on the Shipping page.
          </p>
        </div>
      )}
    </div>
  );
}

// Phase 3.3 — local CreateLabelPanel removed; legacy view now imports the
// shared @/components/shipping/create-label-panel for parity with the cockpit.

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
