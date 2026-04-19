// Phase 2.2 — New ShipStation-backed Orders cockpit. Reads from
// shipstation_orders / shipstation_order_items via getShipStationOrdersDb.
//
// Tabs: All / Preorders / Preorders Ready / Needs Assignment.
// Sort: Client → Date / Date / Order #.
// Per-row tracking link slot is reserved for Phase 4 to populate; for now
// just shows the SS deep link.
// Per-row Buy Label panel hooks land in Phase 3.3.
"use client";

import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Truck,
  UserPlus,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  type CockpitFilters,
  type CockpitOrder,
  type CockpitSort,
  type CockpitTab,
  getShipStationOrdersDb,
  refreshShipStationOrdersFromSS,
} from "@/actions/shipstation-orders";
import { CreateLabelPanel } from "@/components/shipping/create-label-panel";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import {
  buildCarrierTrackingUrl,
  buildShipStationOrderPageUrl,
} from "@/lib/shared/carrier-tracking-urls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
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

function formatShipTo(shipTo: Record<string, unknown> | null): string {
  if (!shipTo) return "—";
  const parts = [shipTo.name, shipTo.city, shipTo.state, shipTo.country]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.join(", ") || "—";
}

export function OrdersCockpit() {
  const [filters, setFilters] = useState<{
    page: number;
    pageSize: number;
    orderStatus: string;
    orgId: string;
    tab: CockpitTab;
    search: string;
    sort: CockpitSort;
  }>({
    page: 1,
    pageSize: 50,
    orderStatus: "awaiting_shipment",
    orgId: "",
    tab: "all",
    search: "",
    sort: "client_then_date",
  });
  useListPaginationPreference("admin/orders", filters, setFilters);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Translate UI filter shape to the action signature.
  const actionFilters = useMemo<CockpitFilters>(
    () => ({
      orderStatus: filters.orderStatus,
      orgId: filters.orgId || undefined,
      tab: filters.tab,
      search: filters.search.trim() || undefined,
      sort: filters.sort,
      page: filters.page,
      pageSize: filters.pageSize,
    }),
    [filters],
  );

  const { data, isLoading, refetch } = useAppQuery({
    queryKey: ["shipstation-orders-db", actionFilters],
    queryFn: () => getShipStationOrdersDb(actionFilters),
    tier: CACHE_TIERS.SESSION,
  });

  const refreshFromSS = useAppMutation({
    mutationFn: () => refreshShipStationOrdersFromSS({ windowMinutes: 30 }),
    onSuccess: () => refetch(),
  });

  const orders = data?.orders ?? [];
  const total = data?.total ?? 0;
  const tabCounts = data?.tabCounts ?? { all: 0, preorder: 0, preorder_ready: 0, needs_assignment: 0 };

  function setTab(tab: CockpitTab) {
    setFilters((f) => ({ ...f, tab, page: 1 }));
  }
  function setSort(sort: CockpitSort) {
    setFilters((f) => ({ ...f, sort }));
  }
  function setOrderStatus(status: string | null) {
    if (status) setFilters((f) => ({ ...f, orderStatus: status, page: 1 }));
  }

  // Group rows by org when sort=client_then_date for the section headers.
  const grouped = useMemo(() => {
    if (filters.sort !== "client_then_date") return null;
    const groups = new Map<string, { name: string; rows: CockpitOrder[] }>();
    for (const o of orders) {
      const key = o.org_id ?? "__unassigned__";
      const name = o.org_name ?? "Needs assignment";
      if (!groups.has(key)) groups.set(key, { name, rows: [] });
      groups.get(key)?.rows.push(o);
    }
    return Array.from(groups.values());
  }, [orders, filters.sort]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            ShipStation orders mirrored locally. Showing {orders.length} of {total}.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refreshFromSS.mutate()}
          disabled={refreshFromSS.isPending}
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${refreshFromSS.isPending ? "animate-spin" : ""}`}
          />
          Refresh from ShipStation
        </Button>
      </div>

      {/* Tabs (Phase 2.2 + Phase 1 retro drift "needs_assignment") */}
      <Tabs value={filters.tab} onValueChange={(v) => v && setTab(v as CockpitTab)}>
        <TabsList>
          <TabsTrigger value="all">
            All <Badge variant="outline" className="ml-2">{tabCounts.all}</Badge>
          </TabsTrigger>
          <TabsTrigger value="preorder">
            Preorders <Badge variant="outline" className="ml-2">{tabCounts.preorder}</Badge>
          </TabsTrigger>
          <TabsTrigger value="preorder_ready">
            Ready to Ship <Badge variant="outline" className="ml-2">{tabCounts.preorder_ready}</Badge>
          </TabsTrigger>
          <TabsTrigger value="needs_assignment">
            Needs Assignment{" "}
            <Badge variant="outline" className="ml-2">{tabCounts.needs_assignment}</Badge>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Order #, customer, email, ship-to, SKU…"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            className="pl-9"
          />
        </div>

        <Select value={filters.orderStatus} onValueChange={setOrderStatus}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.sort}
          onValueChange={(v) => v && setSort(v as CockpitSort)}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="client_then_date">Client → Date</SelectItem>
            <SelectItem value="date">Date (newest first)</SelectItem>
            <SelectItem value="order_number">Order #</SelectItem>
            <SelectItem value="release_date">Release date (preorders)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading orders…
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Order #</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Ship To</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Order Date</TableHead>
                <TableHead className="text-right">Tracking</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    No orders match these filters.
                  </TableCell>
                </TableRow>
              ) : grouped ? (
                grouped.map((group) => (
                  <GroupRows
                    key={group.name}
                    group={group}
                    expandedId={expandedId}
                    setExpandedId={setExpandedId}
                  />
                ))
              ) : (
                orders.map((o) => (
                  <CockpitRow
                    key={o.id}
                    order={o}
                    isExpanded={expandedId === o.id}
                    onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <PaginationBar
        page={filters.page}
        pageSize={filters.pageSize}
        total={total}
        onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
        onPageSizeChange={(pageSize) => setFilters((f) => ({ ...f, pageSize, page: 1 }))}
      />
    </div>
  );
}

function GroupRows({
  group,
  expandedId,
  setExpandedId,
}: {
  group: { name: string; rows: CockpitOrder[] };
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  return (
    <>
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell colSpan={9} className="font-semibold text-sm py-2">
          {group.name} <span className="text-muted-foreground font-normal">({group.rows.length})</span>
        </TableCell>
      </TableRow>
      {group.rows.map((o) => (
        <CockpitRow
          key={o.id}
          order={o}
          isExpanded={expandedId === o.id}
          onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)}
        />
      ))}
    </>
  );
}

function CockpitRow({
  order,
  isExpanded,
  onToggle,
}: {
  order: CockpitOrder;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const ssDeepLink = `https://ship11.shipstation.com/orders/order-details/${order.shipstation_order_id}`;
  const itemCount = order.items.reduce((sum, i) => sum + (i.quantity ?? 1), 0);
  const isUnassigned = !order.org_id;

  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="font-mono text-sm">
          <a
            href={ssDeepLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {order.order_number}
            <ExternalLink className="h-3 w-3" />
          </a>
          {order.preorder_state === "preorder" && (
            <Badge
              variant="outline"
              className="ml-2 bg-amber-50 text-amber-800 border-amber-200"
              title={
                order.preorder_release_date
                  ? `Releases ${order.preorder_release_date}`
                  : undefined
              }
            >
              preorder
              {order.preorder_release_date && (
                <span className="ml-1 font-mono text-[10px]">
                  · {order.preorder_release_date.slice(5)}
                </span>
              )}
            </Badge>
          )}
          {order.preorder_state === "ready" && (
            <Badge
              variant="outline"
              className="ml-2 bg-emerald-50 text-emerald-800 border-emerald-200"
              title={
                order.preorder_release_date
                  ? `Releases ${order.preorder_release_date}`
                  : undefined
              }
            >
              ready
              {order.preorder_release_date && (
                <span className="ml-1 font-mono text-[10px]">
                  · {order.preorder_release_date.slice(5)}
                </span>
              )}
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-sm">
          {isUnassigned ? (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <UserPlus className="h-3.5 w-3.5" /> Needs assignment
            </span>
          ) : (
            order.org_name ?? "—"
          )}
        </TableCell>
        <TableCell className="text-sm">
          <div>{order.customer_name ?? "—"}</div>
          {order.customer_email && (
            <div className="text-xs text-muted-foreground">{order.customer_email}</div>
          )}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {formatShipTo(order.ship_to)}
        </TableCell>
        <TableCell className="text-sm">{itemCount}</TableCell>
        <TableCell>
          <span
            className={`text-xs px-2 py-0.5 rounded font-medium ${
              STATUS_COLORS[order.order_status] ?? "bg-gray-100 text-gray-700"
            }`}
          >
            {order.order_status.replace(/_/g, " ")}
          </span>
        </TableCell>
        <TableCell className="text-right font-mono text-sm">
          {order.amount_paid != null ? `$${order.amount_paid.toFixed(2)}` : "—"}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {order.order_date ? new Date(order.order_date).toLocaleDateString() : "—"}
        </TableCell>
        <TableCell className="text-right text-sm">
          <TrackingCell order={order} />
        </TableCell>
      </TableRow>

      {isExpanded && (
        <TableRow>
          <TableCell colSpan={9} className="bg-muted/20 px-4 py-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Ship-to */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Ship To
                </p>
                {order.ship_to ? (
                  (() => {
                    const st = order.ship_to as Record<string, unknown>;
                    const s = (k: string): string | null => {
                      const v = st[k];
                      return typeof v === "string" && v.length > 0 ? v : null;
                    };
                    const name = s("name");
                    const street1 = s("street1");
                    const street2 = s("street2");
                    const city = s("city");
                    const state = s("state");
                    const postalCode = s("postalCode");
                    const country = s("country");
                    return (
                      <address className="text-sm not-italic space-y-0.5">
                        {name && <div className="font-medium">{name}</div>}
                        {street1 && <div className="text-muted-foreground">{street1}</div>}
                        {street2 && <div className="text-muted-foreground">{street2}</div>}
                        {(city || state || postalCode) && (
                          <div className="text-muted-foreground">
                            {[city, state, postalCode].filter(Boolean).join(", ")}
                          </div>
                        )}
                        {country && country !== "US" && (
                          <div className="text-muted-foreground">{country}</div>
                        )}
                      </address>
                    );
                  })()
                ) : (
                  <span className="text-sm text-muted-foreground">No ship-to recorded</span>
                )}
              </div>

              {/* Items */}
              <div className="md:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Items
                </p>
                <div className="space-y-1">
                  {order.items.map((item) => (
                    <div
                      key={item.item_index}
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
                        {item.unit_price != null && (
                          <span className="text-muted-foreground ml-1">
                            · ${item.unit_price.toFixed(2)}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Phase 4.5 — writeback error banner.
                Surfaces shipstation-mark-shipped failures so staff can
                manually retry / inspect / override. */}
            {order.shipment?.shipstation_writeback_error && (
              <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="space-y-1 min-w-0">
                    <p className="font-semibold">ShipStation write-back failed</p>
                    <p className="text-xs break-words">
                      {order.shipment.shipstation_writeback_error}
                    </p>
                    <p className="text-xs text-amber-800">
                      The label was printed successfully — only the
                      "mark shipped in SS" step failed. Phase 4.6 retry cron will
                      try again automatically; meanwhile staff can mark shipped
                      manually in the ShipStation dashboard.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Phase 3.3 + 3.4 — Buy Label panel + Print Packing Slip link.
                Phase 8 will add tag editing and hold-until controls beside them. */}
            <div className="mt-4 pt-3 border-t space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <a
                  href={`/admin/orders/${order.id}/packing-slip`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border hover:bg-muted transition-colors"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Print Packing Slip
                </a>
              </div>
              {order.org_id ? (
                <CreateLabelPanel
                  orderId={order.id}
                  orderType="shipstation"
                  customerShippingCharged={order.shipping_paid ?? null}
                />
              ) : (
                <p className="text-xs text-amber-700">
                  This order has no resolved client (org). Assign one before printing a label —
                  use the "Needs Assignment" tab.
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// Phase 4.5 — Tracking column cell with status pill + link.
//
// Status pill ladder:
//   "—"               — no shipment yet (label not bought)
//   "Label printed"   — shipment exists but shipstation_marked_shipped_at IS NULL
//   "Marked shipped"  — writeback success, shipstation_marked_shipped_at set
//
// Link priority (Phase 4.5):
//   1. shipment.shipstation_tracking_url (set by writeback response)
//   2. buildCarrierTrackingUrl(carrier, tracking_number)
//   3. SS order page link as final fallback
function TrackingCell({ order }: { order: CockpitOrder }) {
  const s = order.shipment;
  if (!s) return <span className="text-muted-foreground">—</span>;

  const linkHref =
    s.shipstation_tracking_url ??
    buildCarrierTrackingUrl(s.carrier, s.tracking_number) ??
    buildShipStationOrderPageUrl(order.shipstation_order_id);

  const stamped = !!s.shipstation_marked_shipped_at;
  const hasError = !!s.shipstation_writeback_error;

  return (
    <div className="flex flex-col items-end gap-1 leading-tight">
      <a
        href={linkHref}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-blue-600 hover:underline font-mono text-xs"
        onClick={(e) => e.stopPropagation()}
        title={s.tracking_number ?? undefined}
      >
        <Truck className="h-3 w-3" />
        {s.tracking_number ? truncateTracking(s.tracking_number) : "track"}
      </a>
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded ${
          hasError
            ? "bg-amber-100 text-amber-800"
            : stamped
              ? "bg-emerald-100 text-emerald-800"
              : "bg-blue-100 text-blue-800"
        }`}
      >
        {hasError ? "writeback failed" : stamped ? "marked shipped" : "label printed"}
      </span>
    </div>
  );
}

function truncateTracking(t: string): string {
  return t.length > 12 ? `…${t.slice(-10)}` : t;
}
