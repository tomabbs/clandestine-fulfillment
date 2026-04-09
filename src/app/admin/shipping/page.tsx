"use client";

import { Download, ExternalLink, Loader2, Package, Search, Send, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { setBandcampPaymentId, triggerBandcampMarkShipped } from "@/actions/bandcamp-shipping";
import type { GetShipmentsFilters } from "@/actions/shipping";
import {
  exportShipmentsCsv,
  getShipmentDetail,
  getShipments,
  getShipmentsSummary,
} from "@/actions/shipping";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// === Types ===

type ShipmentRow = Awaited<ReturnType<typeof getShipments>>["shipments"][number];
type ShipmentDetail = Awaited<ReturnType<typeof getShipmentDetail>>;

interface LabelDataAddress {
  name?: string | null;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
}

// === Helpers ===

function extractRecipient(labelData: unknown): LabelDataAddress | null {
  if (!labelData || typeof labelData !== "object") return null;
  const ld = labelData as Record<string, unknown>;
  return (ld.shipTo as LabelDataAddress) ?? null;
}

function getCarrierLabel(carrier: string | null): string {
  if (!carrier) return "";
  const c = carrier.toLowerCase();
  if (c.includes("usps")) return "USPS";
  if (c.includes("ups")) return "UPS";
  if (c.includes("fedex")) return "FedEx";
  if (c.includes("dhl")) return "DHL";
  return carrier.toUpperCase();
}

function getCarrierTrackingUrl(
  carrier: string | null,
  trackingNumber: string | null,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const c = carrier.toLowerCase();
  if (c.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingNumber}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes("dhl"))
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
  return null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "$0.00";
  return `$${value.toFixed(2)}`;
}

// === Main Page ===

export default function ShippingPage() {
  const [filters, setFilters] = useState<GetShipmentsFilters>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  const [searchInput, setSearchInput] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const summaryFilters = useMemo(
    () => ({
      orgId: filters.orgId,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    }),
    [filters.orgId, filters.dateFrom, filters.dateTo],
  );

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.shipments.list(filters),
    queryFn: () => getShipments(filters),
  });

  const { data: summary } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.shipments.summary(summaryFilters),
    queryFn: () => getShipmentsSummary(summaryFilters),
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.shipments.detail(expandedId ?? ""),
    queryFn: () => getShipmentDetail(expandedId ?? ""),
    enabled: !!expandedId,
  });

  const handleSearch = useCallback(() => {
    setFilters((prev) => ({ ...prev, search: searchInput || undefined, page: 1 }));
    setExpandedId(null);
  }, [searchInput]);

  const handleFilterChange = useCallback((key: keyof GetShipmentsFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
    setExpandedId(null);
  }, []);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const csv = await exportShipmentsCsv({
        orgId: filters.orgId,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `shipments-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [filters.orgId, filters.dateFrom, filters.dateTo]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Shipping Log</h1>
          <p className="text-muted-foreground mt-1">
            {data ? `${data.total} shipment${data.total !== 1 ? "s" : ""}` : "Loading..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/shipping/pirate-ship">
            <Button variant="outline" size="sm">
              <Upload className="h-4 w-4 mr-1.5" />
              Import Pirate Ship
            </Button>
          </Link>
          <Button variant="outline" size="sm" disabled={exporting} onClick={handleExport}>
            <Download className="h-4 w-4 mr-1.5" />
            {exporting ? "Exporting..." : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card size="sm">
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Shipments
            </p>
            <p className="text-2xl font-semibold tabular-nums mt-1">
              {summary?.totalCount.toLocaleString() ?? "---"}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Total Postage
            </p>
            <p className="text-2xl font-semibold tabular-nums mt-1 font-mono">
              {summary ? formatCurrency(summary.totalPostage) : "---"}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Avg Cost / Shipment
            </p>
            <p className="text-2xl font-semibold tabular-nums mt-1 font-mono">
              {summary ? formatCurrency(summary.avgCost) : "---"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tracking, carrier..."
            className="pl-9"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>
        <Input
          type="date"
          className="w-40"
          onChange={(e) => handleFilterChange("dateFrom", e.target.value)}
        />
        <Input
          type="date"
          className="w-40"
          onChange={(e) => handleFilterChange("dateTo", e.target.value)}
        />
        <Input
          placeholder="Status..."
          className="w-32"
          onChange={(e) => handleFilterChange("status", e.target.value)}
        />
      </div>

      {/* Table */}
      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page ?? 1}
          pageSize={filters.pageSize ?? DEFAULT_PAGE_SIZE}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Ship Date</th>
              <th className="px-4 py-3 text-left font-medium">Order #</th>
              <th className="px-4 py-3 text-left font-medium">Client</th>
              <th className="px-4 py-3 text-left font-medium">Recipient</th>
              <th className="px-4 py-3 text-left font-medium">Tracking</th>
              <th className="px-4 py-3 text-center font-medium">Items</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && [1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)}
            {data?.shipments.map((shipment) => (
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
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  No shipments found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page ?? 1}
          pageSize={filters.pageSize ?? DEFAULT_PAGE_SIZE}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </div>
  );
}

// === Table Row ===

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
  const recipient = extractRecipient(shipment.label_data);

  // Priority: linked warehouse_order number > ss_order_number > SS-{id} fallback
  const orderNumber =
    (shipment.warehouse_orders as unknown as { order_number: string | null } | null)
      ?.order_number ?? null;
  const ssOrderNum =
    (shipment as ShipmentRow & { ss_order_number?: string | null }).ss_order_number ?? null;
  const displayOrderRef =
    orderNumber ??
    ssOrderNum ??
    (shipment.shipstation_shipment_id ? `SS-${shipment.shipstation_shipment_id}` : null);

  const clientName = (shipment.organizations as unknown as { name: string } | null)?.name ?? null;

  // Use total_units (physical units shipped), not line count
  const itemCount = (shipment as ShipmentRow & { total_units?: number | null }).total_units ?? 0;

  const trackingUrl = getCarrierTrackingUrl(shipment.carrier, shipment.tracking_number);
  const carrierLabel = getCarrierLabel(shipment.carrier);
  const labelSource = (shipment as ShipmentRow & { label_source?: string | null }).label_source;

  // Shipping gap indicator
  const customerCharged =
    (shipment as ShipmentRow & { customer_shipping_charged?: number | null })
      .customer_shipping_charged ?? null;
  const postage = shipment.shipping_cost ?? null;
  const shippingGap = customerCharged != null && postage != null ? customerCharged - postage : null;

  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          {shipment.ship_date
            ? new Date(`${shipment.ship_date}T12:00:00`).toLocaleDateString()
            : "---"}
        </td>
        <td className="px-4 py-3 font-mono text-xs">{displayOrderRef ?? "---"}</td>
        <td className="px-4 py-3 text-sm text-muted-foreground">{clientName ?? "—"}</td>
        <td className="px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm">{recipient?.name ?? "---"}</p>
            {recipient?.city && (
              <p className="text-xs text-muted-foreground truncate">
                {recipient.city}
                {recipient.state ? `, ${recipient.state}` : ""}
              </p>
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {carrierLabel && <Badge variant="secondary">{carrierLabel}</Badge>}
            {labelSource === "shipstation" && (
              <span className="text-xs bg-blue-100 text-blue-700 px-1 rounded">SS</span>
            )}
            {labelSource === "easypost" && (
              <span className="text-xs bg-green-100 text-green-700 px-1 rounded">EP</span>
            )}
            <span className="font-mono text-xs">{shipment.tracking_number ?? "---"}</span>
            {trackingUrl && (
              <a
                href={trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-blue-600 hover:text-blue-800 shrink-0"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-center">
          <div className="inline-flex items-center gap-1 text-muted-foreground">
            <Package className="h-3.5 w-3.5" />
            <span className="tabular-nums">{itemCount}</span>
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <StatusBadge status={shipment.status} />
            {(
              shipment as ShipmentRow & {
                bandcamp_payment_id?: number | null;
                bandcamp_synced_at?: string | null;
              }
            ).bandcamp_payment_id != null && (
              <Badge variant="secondary" className="text-xs">
                BC
                {(shipment as ShipmentRow & { bandcamp_synced_at?: string | null })
                  .bandcamp_synced_at
                  ? " ✓"
                  : ""}
              </Badge>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-right font-mono">
          <div className="flex items-center justify-end gap-1.5">
            {shippingGap != null && (
              <span
                className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${
                  shippingGap >= 0 ? "bg-green-500" : "bg-red-500"
                }`}
                title={
                  shippingGap >= 0
                    ? `Charged $${customerCharged?.toFixed(2)} / Postage $${postage?.toFixed(2)} (+$${shippingGap.toFixed(2)})`
                    : `Charged $${customerCharged?.toFixed(2)} / Postage $${postage?.toFixed(2)} (-$${Math.abs(shippingGap).toFixed(2)} shortfall)`
                }
              />
            )}
            {formatCurrency(shipment.shipping_cost)}
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b bg-muted/10">
          <td colSpan={7} className="px-6 py-5">
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

// === Expanded Detail ===

function ShipmentExpandedDetail({ detail }: { detail: ShipmentDetail }) {
  const { shipment, recipient, costBreakdown, items, trackingEvents } = detail;
  const bandcampPaymentId = (shipment as { bandcamp_payment_id?: number | null })
    .bandcamp_payment_id;
  const [bcPaymentInput, setBcPaymentInput] = useState(String(bandcampPaymentId ?? ""));
  useEffect(() => {
    setBcPaymentInput(String(bandcampPaymentId ?? ""));
  }, [bandcampPaymentId]);

  const setPaymentMut = useAppMutation({
    mutationFn: (paymentId: number | null) =>
      setBandcampPaymentId({ shipmentId: shipment.id, bandcampPaymentId: paymentId }),
    invalidateKeys: [queryKeys.shipments.all],
  });

  const syncMut = useAppMutation({
    mutationFn: () => triggerBandcampMarkShipped({ shipmentId: shipment.id }),
    invalidateKeys: [queryKeys.shipments.all],
  });

  const bandcampSyncedAt = (shipment as { bandcamp_synced_at?: string | null }).bandcamp_synced_at;
  const canSync = bandcampPaymentId != null && shipment.tracking_number != null;

  const handleSetBcPayment = () => {
    const parsed = Number.parseInt(bcPaymentInput, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      setPaymentMut.mutate(null);
    } else {
      setPaymentMut.mutate(parsed);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Column 1: Recipient + Shipping Info */}
      <div className="space-y-4">
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Recipient
          </h4>
          {recipient ? (
            <div className="text-sm space-y-0.5">
              <p className="font-medium">{recipient.name ?? "---"}</p>
              {recipient.company && <p>{recipient.company}</p>}
              {recipient.street1 && <p>{recipient.street1}</p>}
              {recipient.street2 && <p>{recipient.street2}</p>}
              <p>
                {[recipient.city, recipient.state, recipient.postalCode].filter(Boolean).join(", ")}
              </p>
              {recipient.country && recipient.country !== "US" && <p>{recipient.country}</p>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No recipient data</p>
          )}
        </div>

        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Shipping Details
          </h4>
          <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Carrier</dt>
            <dd>{shipment.carrier ?? "---"}</dd>
            <dt className="text-muted-foreground">Service</dt>
            <dd>{shipment.service ?? "---"}</dd>
            <dt className="text-muted-foreground">Weight</dt>
            <dd>{shipment.weight != null ? `${shipment.weight} oz` : "---"}</dd>
          </dl>
        </div>

        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Bandcamp Sync
          </h4>
          <p className="text-xs text-muted-foreground mb-2">
            Link this shipment to a Bandcamp order (payment ID) to mark it shipped and send
            tracking.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              placeholder="Bandcamp payment ID"
              className="w-40 h-8 text-sm"
              value={bcPaymentInput}
              onChange={(e) => setBcPaymentInput(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={setPaymentMut.isPending}
              onClick={handleSetBcPayment}
            >
              {setPaymentMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Set"}
            </Button>
            {bandcampPaymentId != null && (
              <>
                <span className="text-xs text-muted-foreground">
                  Payment ID: {bandcampPaymentId}
                  {bandcampSyncedAt && ` · Synced ${new Date(bandcampSyncedAt).toLocaleString()}`}
                </span>
                {canSync && (
                  <Button size="sm" disabled={syncMut.isPending} onClick={() => syncMut.mutate()}>
                    {syncMut.isPending ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Send className="h-3 w-3 mr-1" />
                    )}
                    Sync to Bandcamp
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Column 2: Items + Cost Breakdown */}
      <div className="space-y-4">
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Items ({items.length})
          </h4>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items recorded.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-1 pr-3 font-medium">Product</th>
                  <th className="text-left py-1 pr-3 font-medium">SKU</th>
                  <th className="text-right py-1 pr-3 font-medium">Qty</th>
                  <th className="text-left py-1 font-medium">Format</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-dashed">
                    <td className="py-1 pr-3">{item.product_title ?? "---"}</td>
                    <td className="py-1 pr-3 font-mono text-xs">{item.sku}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{item.quantity}</td>
                    <td className="py-1">{item.format_name ?? "---"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Cost Breakdown
          </h4>
          {(() => {
            const charged =
              (shipment as { customer_shipping_charged?: number | null })
                .customer_shipping_charged ?? null;
            const gap = charged != null ? charged - costBreakdown.postage : null;
            return (
              <dl className="text-sm space-y-1">
                {charged != null && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Customer charged</dt>
                    <dd className="font-mono">{formatCurrency(charged)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt>Postage</dt>
                  <dd className="font-mono">{formatCurrency(costBreakdown.postage)}</dd>
                </div>
                {gap != null && (
                  <div
                    className={`flex justify-between border-t pt-1 font-medium ${
                      gap >= 0 ? "text-green-700" : "text-red-600"
                    }`}
                  >
                    <dt>Shipping difference</dt>
                    <dd className="font-mono">
                      {gap >= 0 ? "+" : ""}
                      {formatCurrency(gap)}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt>Materials</dt>
                  <dd className="font-mono">{formatCurrency(costBreakdown.materials)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Pick & Pack</dt>
                  <dd className="font-mono">{formatCurrency(costBreakdown.pickPack)}</dd>
                </div>
                {costBreakdown.dropShip > 0 && (
                  <div className="flex justify-between">
                    <dt>Drop Ship</dt>
                    <dd className="font-mono">{formatCurrency(costBreakdown.dropShip)}</dd>
                  </div>
                )}
                {costBreakdown.insurance > 0 && (
                  <div className="flex justify-between">
                    <dt>Insurance</dt>
                    <dd className="font-mono">{formatCurrency(costBreakdown.insurance)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1 font-medium">
                  <dt>Total Clandestine Cost</dt>
                  <dd className="font-mono">{formatCurrency(costBreakdown.total)}</dd>
                </div>
              </dl>
            );
          })()}
        </div>
      </div>

      {/* Column 3: Tracking Timeline */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Tracking Timeline
        </h4>
        {trackingEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tracking events yet.</p>
        ) : (
          <div className="relative pl-5 space-y-3">
            <div className="absolute left-2 top-1 bottom-1 w-px bg-border" />
            {trackingEvents.map((event, i) => (
              <div key={event.id} className="relative">
                <div
                  className={`absolute -left-3 top-0.5 h-2.5 w-2.5 rounded-full border-2 ${
                    i === trackingEvents.length - 1
                      ? "border-green-500 bg-green-500"
                      : "border-border bg-background"
                  }`}
                />
                <div className="text-sm">
                  <p className={i === trackingEvents.length - 1 ? "font-medium" : ""}>
                    {event.status}
                  </p>
                  {event.description && (
                    <p className="text-xs text-muted-foreground">{event.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    {event.location && <span>{event.location}</span>}
                    {event.event_time && <span>{new Date(event.event_time).toLocaleString()}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// === Status Badge ===

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "shipped"
      ? "default"
      : status === "delivered"
        ? "secondary"
        : status === "voided"
          ? "destructive"
          : "outline";

  return <Badge variant={variant}>{status}</Badge>;
}

// === Skeleton Row ===

function SkeletonRow() {
  return (
    <tr className="border-b">
      {[1, 2, 3, 4, 5, 6, 7].map((i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}
