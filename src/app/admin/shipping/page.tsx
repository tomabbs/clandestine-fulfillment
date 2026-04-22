"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Download,
  ExternalLink,
  Loader2,
  Package,
  Pencil,
  Search,
  Send,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setBandcampPaymentId, triggerBandcampMarkShipped } from "@/actions/bandcamp-shipping";
import { getAuthWorkspaceId } from "@/actions/billing";
import type { GetShipmentsFilters } from "@/actions/shipping";
import {
  exportShipmentsCsv,
  getShipmentDetail,
  getShipments,
  getShipmentsSummary,
  setShipmentItemFormatOverride,
} from "@/actions/shipping";
import { EmptyState } from "@/components/shared/empty-state";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { type QueryScope, queryKeys, queryKeysV2 } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import { maxShippingFromOrderLineItems } from "@/lib/utils";

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
  if (ld.shipTo) return ld.shipTo as LabelDataAddress;
  if (ld.recipient) return ld.recipient as LabelDataAddress;
  return null;
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
  const abs = Math.abs(value);
  const core = `$${abs.toFixed(2)}`;
  return value < 0 ? `-${core}` : core;
}

// === Main Page ===

export default function ShippingPage() {
  const [filters, setFilters] = useState<GetShipmentsFilters>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  useListPaginationPreference("admin/shipping", filters, setFilters);
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

  // v2: workspace-scoped cache keys. Admin shipping spans all client orgs in
  // the workspace, so orgId is null (sentinel "*" in the key).
  const { data: workspaceId } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeysV2.authContext.workspaceId("staff"),
    queryFn: () => getAuthWorkspaceId(),
  });
  const scope: QueryScope = useMemo(
    () => ({ workspaceId: workspaceId ?? "", orgId: null, viewer: "staff" }),
    [workspaceId],
  );
  const scopeReady = !!workspaceId;

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeysV2.shipping.list(scope, filters),
    queryFn: () => getShipments(filters),
    enabled: scopeReady,
  });

  const { data: summary } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeysV2.shipping.summary(scope, summaryFilters),
    queryFn: () => getShipmentsSummary(summaryFilters),
    enabled: scopeReady,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeysV2.shipping.detail(scope, expandedId ?? ""),
    queryFn: () => getShipmentDetail(expandedId ?? ""),
    enabled: !!expandedId && scopeReady,
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Shipping Log</h1>
          <p className="text-muted-foreground mt-1">
            {data ? `${data.total} shipment${data.total !== 1 ? "s" : ""}` : "Loading..."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          defaultValue=""
          onChange={(e) => handleFilterChange("labelSource", e.target.value)}
        >
          <option value="">All Sources</option>
          <option value="shipstation">ShipStation</option>
          <option value="pirate_ship">Pirate Ship</option>
          <option value="easypost">EasyPost</option>
          <option value="manual">Manual</option>
        </select>
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
      <div className="space-y-2">
        {isLoading && [1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)}
        {data?.shipments.map((shipment) => (
          <ShipmentTableRow
            key={shipment.id}
            shipment={shipment}
            isExpanded={expandedId === shipment.id}
            onToggle={() => setExpandedId((prev) => (prev === shipment.id ? null : shipment.id))}
            detail={expandedId === shipment.id ? detail : undefined}
            detailLoading={expandedId === shipment.id && detailLoading}
            scope={scope}
          />
        ))}
        {data && data.shipments.length === 0 && <EmptyState title="No shipments found" compact />}
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
  scope,
}: {
  shipment: ShipmentRow;
  isExpanded: boolean;
  onToggle: () => void;
  detail: ShipmentDetail | undefined;
  detailLoading: boolean;
  scope: QueryScope;
}) {
  const queryClient = useQueryClient();
  const handleDetailRefresh = useCallback(() => {
    // Bridge: invalidate both v1 and v2 detail keys during transition so
    // any non-migrated reader (legacy admin/orders-legacy etc.) also refreshes.
    queryClient.invalidateQueries({ queryKey: queryKeys.shipments.detail(shipment.id) });
    queryClient.invalidateQueries({ queryKey: queryKeysV2.shipping.detail(scope, shipment.id) });
  }, [queryClient, shipment.id, scope]);

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

  const lineItems = (
    shipment as ShipmentRow & {
      warehouse_shipment_items?: Array<{ quantity?: number | null }>;
    }
  ).warehouse_shipment_items;
  const lineRowCount = lineItems?.length ?? 0;
  const unitsFromLines = lineItems?.reduce((s, row) => s + (Number(row.quantity) || 0), 0) ?? 0;
  const storedUnits = (shipment as ShipmentRow & { total_units?: number | null }).total_units ?? 0;
  // Pirate Ship imports may omit total_units and per-row quantity; use line count when sum is 0 but rows exist
  const itemCount = Math.max(
    storedUnits,
    unitsFromLines,
    lineRowCount > 0 && unitsFromLines === 0 ? lineRowCount : 0,
  );

  const trackingUrl = getCarrierTrackingUrl(shipment.carrier, shipment.tracking_number);
  const carrierLabel = getCarrierLabel(shipment.carrier);
  const labelSource = (shipment as ShipmentRow & { label_source?: string | null }).label_source;

  const orderJoin = shipment.warehouse_orders as {
    shipping_cost?: number | null;
    line_items?: unknown;
  } | null;
  const fromColumn = orderJoin?.shipping_cost != null ? Number(orderJoin.shipping_cost) : null;
  const fromLineItems = maxShippingFromOrderLineItems(orderJoin?.line_items);
  const orderShippingEffective =
    fromColumn != null && !Number.isNaN(fromColumn)
      ? fromColumn
      : fromLineItems != null
        ? fromLineItems
        : null;
  // Customer charged: prefer snapshot on shipment; fall back to order shipping
  const customerCharged =
    (shipment as ShipmentRow & { customer_shipping_charged?: number | null })
      .customer_shipping_charged ??
    (orderShippingEffective != null ? Number(orderShippingEffective) : null);

  // Use fulfillment_total (postage + materials + pick/pack) for cost column and margin dot.
  // Falls back to raw postage if enrichment didn't run (e.g. no SKU data).
  const enrichedRow = shipment as ShipmentRow & {
    fulfillment_total?: number | null;
    fulfillment_partial?: boolean;
  };
  const fulfillmentTotal = enrichedRow.fulfillment_total ?? shipment.shipping_cost ?? null;
  const fulfillmentPartial = enrichedRow.fulfillment_partial ?? false;

  // Margin = customer charged minus total fulfillment cost (postage + materials + pick/pack)
  const fulfillmentGap =
    customerCharged != null && fulfillmentTotal != null ? customerCharged - fulfillmentTotal : null;

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        className="w-full text-left p-3 hover:bg-muted/30 transition-colors"
        onClick={onToggle}
      >
        <div className="grid grid-cols-1 md:grid-cols-4 xl:grid-cols-8 gap-3 text-sm">
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Ship Date</p>
            <p>
              {shipment.ship_date
                ? new Date(`${shipment.ship_date}T12:00:00`).toLocaleDateString()
                : "---"}
            </p>
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Order #</p>
            <p className="font-mono text-xs">{displayOrderRef ?? "---"}</p>
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Client</p>
            <p>{clientName ?? "—"}</p>
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Recipient</p>
            <p className="truncate">{recipient?.name ?? "---"}</p>
            {recipient?.city && (
              <p className="text-xs text-muted-foreground truncate">
                {recipient.city}
                {recipient.state ? `, ${recipient.state}` : ""}
              </p>
            )}
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Tracking</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {carrierLabel && <Badge variant="secondary">{carrierLabel}</Badge>}
              {labelSource === "shipstation" && (
                <span className="text-xs bg-blue-100 text-blue-700 px-1 rounded">SS</span>
              )}
              {labelSource === "pirate_ship" && (
                <span className="text-xs bg-orange-100 text-orange-700 px-1 rounded">PS</span>
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
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Items</p>
            <div className="inline-flex items-center gap-1 text-muted-foreground">
              <Package className="h-3.5 w-3.5" />
              <span className="tabular-nums">{itemCount}</span>
            </div>
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</p>
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
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Cost</p>
            <div className="flex items-center gap-1.5 font-mono">
              {fulfillmentPartial && (
                <span
                  className="inline-block h-2 w-2 rounded-full flex-shrink-0 bg-amber-400"
                  title="Fulfillment cost is partial — some item SKUs or format costs could not be resolved"
                />
              )}
              {!fulfillmentPartial && fulfillmentGap != null && (
                <span
                  className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${
                    fulfillmentGap >= 0 ? "bg-green-500" : "bg-red-500"
                  }`}
                  title={
                    fulfillmentGap >= 0
                      ? `Charged $${customerCharged?.toFixed(2)} / Fulfillment $${fulfillmentTotal?.toFixed(2)} (+$${fulfillmentGap.toFixed(2)})`
                      : `Charged $${customerCharged?.toFixed(2)} / Fulfillment $${fulfillmentTotal?.toFixed(2)} (-$${Math.abs(fulfillmentGap).toFixed(2)} shortfall)`
                  }
                />
              )}
              {formatCurrency(fulfillmentTotal)}
            </div>
          </div>
        </div>
      </button>
      {isExpanded && (
        <div className="border-t bg-muted/10 px-6 py-5">
          {detailLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          ) : detail ? (
            <ShipmentExpandedDetail
              detail={detail}
              onDetailRefresh={handleDetailRefresh}
              scope={scope}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

// === Expanded Detail ===

function ShipmentExpandedDetail({
  detail,
  onDetailRefresh,
  scope,
}: {
  detail: ShipmentDetail;
  onDetailRefresh: () => void;
  scope: QueryScope;
}) {
  const { shipment, recipient, costBreakdown, items, trackingEvents, availableFormats } = detail;
  const formatOptions =
    availableFormats && availableFormats.length > 0 ? availableFormats : FORMAT_OPTIONS_FALLBACK;
  const bandcampPaymentId = (shipment as { bandcamp_payment_id?: number | null })
    .bandcamp_payment_id;
  const [bcPaymentInput, setBcPaymentInput] = useState(String(bandcampPaymentId ?? ""));
  useEffect(() => {
    setBcPaymentInput(String(bandcampPaymentId ?? ""));
  }, [bandcampPaymentId]);

  // Bridge invalidation: hit both legacy (queryKeys.shipments.all → ["shipments"])
  // and v2 scope-wide root so non-migrated readers (e.g. orders-legacy) still
  // refresh, while v2 callsites for this scope refresh too. queryKeysV2.shipping.domain()
  // is intentionally NOT used here — keep the blast radius bounded to this scope.
  const shipmentsInvalidation = useMemo(
    () => [queryKeys.shipments.all, queryKeysV2.shipping.all(scope)],
    [scope],
  );
  const setPaymentMut = useAppMutation({
    mutationFn: (paymentId: number | null) =>
      setBandcampPaymentId({ shipmentId: shipment.id, bandcampPaymentId: paymentId }),
    invalidateKeys: shipmentsInvalidation,
  });

  const syncMut = useAppMutation({
    mutationFn: () => triggerBandcampMarkShipped({ shipmentId: shipment.id }),
    invalidateKeys: shipmentsInvalidation,
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
            <div className="space-y-2">
              {items.map((item) => (
                <div key={item.id} className="rounded-md border bg-background/60 p-2">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-sm">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Product
                      </p>
                      <p>{item.product_title ?? "---"}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        SKU
                      </p>
                      <p className="font-mono text-xs">{item.sku}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Qty
                      </p>
                      <p className="tabular-nums">{item.quantity}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Format
                      </p>
                      <FormatCell
                        item={{
                          id: item.id,
                          format_name: item.format_name,
                          format_name_override: (
                            item as typeof item & { format_name_override?: string | null }
                          ).format_name_override,
                        }}
                        onSaved={onDetailRefresh}
                        formatOptions={formatOptions}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
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
            /** Customer shipping collected minus total fulfillment cost (postage + materials + pick/pack + …). */
            const fulfillmentDiff = charged != null ? charged - costBreakdown.total : null;
            return (
              <dl className="text-sm space-y-1">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Customer charged (shipping)</dt>
                  <dd className="font-mono">{charged != null ? formatCurrency(charged) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Postage</dt>
                  <dd className="font-mono">{formatCurrency(costBreakdown.postage)}</dd>
                </div>
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
                  <dt>Total Cost</dt>
                  <dd className="font-mono">{formatCurrency(costBreakdown.total)}</dd>
                </div>
                {fulfillmentDiff != null && (
                  <div
                    className={`flex justify-between border-t pt-1 font-medium ${
                      fulfillmentDiff >= 0 ? "text-green-700" : "text-red-600"
                    }`}
                  >
                    <dt>Fulfillment difference</dt>
                    <dd className="font-mono">{formatCurrency(fulfillmentDiff)}</dd>
                  </div>
                )}
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

// === Format Cell (inline edit) ===

/** Fallback format options used only when the server hasn't returned availableFormats yet. */
const FORMAT_OPTIONS_FALLBACK = ["LP", "CD", "Cassette", '7"'] as const;

/**
 * Displays the resolved format for a shipment item and lets staff assign an override
 * when automatic resolution fails (blank / amber dot) or is wrong.
 *
 * - Format resolved → shows format text + pencil button to edit
 * - Format blank    → shows "—" with an inline select open by default
 * - Saving calls setShipmentItemFormatOverride; clearing picks the empty option
 * - Options are fetched from warehouse_format_costs so the names always match cost rows exactly.
 */
function FormatCell({
  item,
  onSaved,
  formatOptions,
}: {
  item: { id: string; format_name: string | null; format_name_override?: string | null };
  onSaved: () => void;
  formatOptions: readonly string[];
}) {
  const [editing, setEditing] = useState(!item.format_name);
  const [saving, setSaving] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  // When the format becomes resolved (after a save + refetch), exit editing mode.
  useEffect(() => {
    if (item.format_name) setEditing(false);
  }, [item.format_name]);

  useEffect(() => {
    if (editing) selectRef.current?.focus();
  }, [editing]);

  const handleChange = async (value: string) => {
    setSaving(true);
    try {
      await setShipmentItemFormatOverride({
        itemId: item.id,
        formatName: value || null,
      });
      onSaved();
    } catch {
      // leave editing open so staff can retry
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <select
            ref={selectRef}
            className="h-7 rounded border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            defaultValue={item.format_name_override ?? item.format_name ?? ""}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && item.format_name && setEditing(false)}
          >
            <option value="">— clear —</option>
            {formatOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        {item.format_name && !saving && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-muted-foreground hover:text-foreground"
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 group">
      <span className={item.format_name_override ? "font-medium text-amber-700" : ""}>
        {item.format_name ?? "—"}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
        title={item.format_name_override ? "Edit format override" : "Set format"}
      >
        <Pencil className="h-3 w-3" />
      </button>
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
    <div className="rounded-lg border p-3">
      <div className="grid grid-cols-1 md:grid-cols-4 xl:grid-cols-8 gap-3">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
