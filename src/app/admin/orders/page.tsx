"use client";

import { Check, CheckCircle, Copy, ExternalLink, Loader2, Package, Tag } from "lucide-react";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
import {
  createOrderLabel,
  getLabelTaskStatus,
  getShippingRates,
  type LabelResult,
  type RateOption,
} from "@/actions/shipping";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
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
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
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

export default function AdminOrdersPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
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

function OrderDetailExpanded({ detail }: { detail: Awaited<ReturnType<typeof getOrderDetail>> }) {
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

      {/* Create Label — hidden when a shipment already exists */}
      {!hasLinkedShipment && isUnfulfilled && orderId && (
        <CreateLabelPanel
          orderId={orderId}
          orderType="fulfillment"
          customerShippingCharged={
            (detail.order as { shipping_cost?: number | null }).shipping_cost ?? null
          }
        />
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

function CreateLabelPanel({
  orderId,
  orderType,
  customerShippingCharged,
}: {
  orderId: string;
  orderType: "fulfillment" | "mailorder";
  customerShippingCharged?: number | null;
}) {
  const [showRates, setShowRates] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [labelResult, setLabelResult] = useState<LabelResult | null>(null);
  const [taskRunId, setTaskRunId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const ratesQuery = useAppQuery({
    queryKey: ["label-rates", orderId, orderType],
    queryFn: () => getShippingRates(orderId, orderType),
    tier: CACHE_TIERS.SESSION,
    enabled: showRates,
  });

  const createMut = useAppMutation({
    mutationFn: async () => {
      if (!selectedRateId) throw new Error("Select a rate first");
      return createOrderLabel(orderId, { orderType, selectedRateId });
    },
    onSuccess: async (result) => {
      if (!result.success) {
        setLabelResult(result);
        return;
      }
      // result.shipmentId is the Trigger.dev run ID when using task path
      if (result.shipmentId) {
        setTaskRunId(result.shipmentId);
        setPolling(true);
        // Poll for task completion
        const poll = async () => {
          const status = await getLabelTaskStatus(result.shipmentId!);
          if (status.status === "completed" || status.status === "failed") {
            setPolling(false);
            setLabelResult(status.result ?? { success: false, error: "Unknown status" });
          } else {
            setTimeout(poll, 2500);
          }
        };
        setTimeout(poll, 2500);
      } else {
        setLabelResult(result);
      }
    },
  });

  const rates: RateOption[] = ratesQuery.data?.rates ?? [];

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          <Tag className="h-4 w-4" />
          Create Shipping Label
        </h4>
        {!showRates && !labelResult && (
          <Button size="sm" variant="outline" onClick={() => setShowRates(true)}>
            Get Rates
          </Button>
        )}
      </div>

      {customerShippingCharged != null && (
        <p className="text-xs text-muted-foreground">
          Customer paid for shipping:{" "}
          <span className="font-mono font-medium text-foreground">
            ${customerShippingCharged.toFixed(2)}
          </span>{" "}
          — pick the rate closest to this amount.
        </p>
      )}

      {/* Rates loading */}
      {showRates && ratesQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Fetching rates…
        </div>
      )}

      {/* Rate error */}
      {ratesQuery.data?.error && (
        <p className="text-sm text-destructive">{ratesQuery.data.error}</p>
      )}

      {/* Rate selector */}
      {!ratesQuery.isLoading && rates.length > 0 && !labelResult && (
        <div className="space-y-2">
          <div className="grid gap-2">
            {rates.map((rate) => (
              <label
                key={rate.id}
                className={`flex items-center justify-between border rounded-md px-3 py-2 cursor-pointer text-sm transition-colors ${
                  selectedRateId === rate.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground"
                }`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`rate-${orderId}`}
                    value={rate.id}
                    checked={selectedRateId === rate.id}
                    onChange={() => setSelectedRateId(rate.id)}
                    className="sr-only"
                  />
                  <div>
                    <span className="font-medium">{rate.displayName}</span>
                    {rate.recommended && (
                      <Badge variant="secondary" className="ml-2 text-xs">
                        Recommended
                      </Badge>
                    )}
                    {rate.isMediaMail && (
                      <Badge variant="outline" className="ml-1 text-xs">
                        Media Mail
                      </Badge>
                    )}
                    {rate.deliveryDays && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        ~{rate.deliveryDays}d
                      </span>
                    )}
                  </div>
                </div>
                <span className="font-mono font-semibold">${rate.rate.toFixed(2)}</span>
              </label>
            ))}
          </div>
          <Button
            size="sm"
            disabled={!selectedRateId || createMut.isPending || polling}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending || polling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Creating…
              </>
            ) : (
              "Buy Label"
            )}
          </Button>
        </div>
      )}

      {/* Label result */}
      {labelResult && (
        <div
          className={`rounded-md p-3 text-sm ${labelResult.success ? "bg-green-50 border border-green-200" : "bg-destructive/10 border border-destructive/20"}`}
        >
          {labelResult.success ? (
            <div className="space-y-2">
              <p className="font-medium text-green-800">Label created!</p>
              <div className="text-green-700 space-y-1">
                <p>
                  Carrier: {labelResult.carrier} · {labelResult.service}
                </p>
                <p>
                  Tracking: <span className="font-mono">{labelResult.trackingNumber}</span>
                </p>
                <p>
                  Cost: <span className="font-mono">${labelResult.rate?.toFixed(2)}</span>
                </p>
              </div>
              {labelResult.labelUrl && (
                <a
                  href={labelResult.labelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open label (Cmd+P to print)
                </a>
              )}
            </div>
          ) : (
            <p className="text-destructive">{labelResult.error ?? "Label creation failed"}</p>
          )}
        </div>
      )}
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
