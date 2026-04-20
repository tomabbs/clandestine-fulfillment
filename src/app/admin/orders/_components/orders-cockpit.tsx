// Phase 8 — ShipStation parity cockpit (full rewrite).
//
// Layout:
//   ┌──────────────┬─────────────────────────────────────────────┐
//   │ status       │ header (filters + saved views + actions)    │
//   │ sidebar      ├─────────────────────────────────────────────┤
//   │ + clients    │ tabs (All / Preorders / Ready / Needs)      │
//   │              ├─────────────────────────────────────────────┤
//   │              │ table (group by client when sort=client)    │
//   │              │ row → expanded drawer with everything       │
//   │              ├─────────────────────────────────────────────┤
//   │              │ pagination                                  │
//   └──────────────┴─────────────────────────────────────────────┘
//
// Sub-phase coverage in this file:
//   8.1 two-pane (sidebar handled in CockpitStatusSidebar)
//   8.2 per-client list (in sidebar)
//   8.3 saved views (CockpitSavedViews)
//   8.4 group-by + columns picker (group-by inline; columns picker as a
//       lightweight dropdown that toggles which optional columns render)
//   8.5 tag chips + edit modal
//   8.6 hold-until picker + restore
//   8.7 address-verify badge + click-to-fix overlay
//   8.8 display-only fields panel
//   polish: auto-sort on preorder tab, manual org-assignment dropdown,
//           retry-writeback button
"use client";

import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  MapPin,
  Package,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  ScanLine,
  Search,
  Settings2,
  Tag as TagIcon,
  Truck,
  User,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  assignOrgToShipStationOrder,
  type CockpitFilters,
  type CockpitOrder,
  type CockpitSort,
  type CockpitTab,
  getBandcampEnrichmentForCockpit,
  getBandcampMatchForShipStationOrder,
  getShipStationOrdersDb,
  listOrgsForAssignment,
  listShipStationTagDefinitions,
  refreshShipStationOrdersFromSS,
  restoreOrderFromHoldAction,
  retryShipStationWriteback,
  setOrderHoldUntil,
  updateShipStationOrderShipTo,
  verifyShipStationOrderAddress,
} from "@/actions/shipstation-orders";
import {
  assignOrders,
  bulkAddOrdersTag,
  bulkRemoveOrdersTag,
  bulkSetOrdersHoldUntil,
  getCockpitFeatureFlags,
  listAssignableStaff,
} from "@/actions/bulk-orders";
import { BulkBuyLabelsModal } from "./bulk-buy-labels-modal";
import { ScanToVerifyModal } from "./scan-to-verify-modal";
import { CreateLabelPanel } from "@/components/shipping/create-label-panel";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSidebar } from "@/components/ui/sidebar";
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
import {
  buildCarrierTrackingUrl,
  buildShipStationOrderPageUrl,
} from "@/lib/shared/carrier-tracking-urls";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import { CockpitEditTagsModal } from "./cockpit-edit-tags-modal";
import { CockpitSavedViews } from "./cockpit-saved-views";
import { CockpitStatusSidebar } from "./cockpit-status-sidebar";

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

// Phase 8.4 — columns the user can show/hide. "core" columns are always on.
type ColumnKey = "client" | "customer" | "ship_to" | "items" | "status" | "amount" | "order_date" | "tags" | "tracking";
const ALL_OPTIONAL_COLUMNS: Array<{ key: ColumnKey; label: string }> = [
  { key: "client", label: "Client" },
  { key: "customer", label: "Customer" },
  { key: "ship_to", label: "Ship To" },
  { key: "items", label: "Items" },
  { key: "status", label: "Status" },
  { key: "amount", label: "Amount" },
  { key: "order_date", label: "Order Date" },
  { key: "tags", label: "Tags" },
  { key: "tracking", label: "Tracking" },
];

interface CockpitState {
  page: number;
  pageSize: number;
  orderStatus: string;
  orgId: string;
  storeId?: number;
  tab: CockpitTab;
  search: string;
  sort: CockpitSort;
  groupBy: "none" | "client";
  columnPrefs: Record<ColumnKey, boolean>;
  tagIds: number[];
  /** Phase 9.3 — "me" or a specific staff user id; undefined for no filter. */
  assignedUserId?: string | "me";
}

const DEFAULT_STATE: CockpitState = {
  page: 1,
  pageSize: 50,
  orderStatus: "awaiting_shipment",
  orgId: "",
  tab: "all",
  search: "",
  sort: "client_then_date",
  groupBy: "client",
  columnPrefs: {
    client: true,
    customer: true,
    ship_to: true,
    items: true,
    status: true,
    amount: true,
    order_date: true,
    tags: false,
    tracking: true,
  },
  tagIds: [],
};

function formatShipTo(shipTo: Record<string, unknown> | null): string {
  if (!shipTo) return "—";
  const parts = [shipTo.name, shipTo.city, shipTo.state, shipTo.country]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.join(", ") || "—";
}

export function OrdersCockpit() {
  const [state, setState] = useState<CockpitState>(DEFAULT_STATE);
  useListPaginationPreference("admin/orders", state, setState);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Auto-collapse the global admin sidebar to icon-only width when the
  // cockpit mounts. The cockpit has its own dedicated status sidebar, so
  // the global one's text labels are redundant here AND eat ~150px of
  // horizontal room that the wide order table needs. Users can hit the
  // SidebarTrigger in the page header to expand back to full text any time
  // (cookie persists their last preference for other pages).
  const sidebar = useSidebar();
  useEffect(() => {
    if (sidebar.open) sidebar.setOpen(false);
    // Run only on mount — don't fight user toggling during the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Phase 9.1 — multi-select. Set persists across pagination so staff can
  // assemble a 100-order batch from multiple pages. Reset on tab/filter
  // change to avoid the "I just assigned a label to an order I forgot was
  // selected on page 3" footgun.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Phase 9.1 — bulk-buy modal open state.
  const [bulkBuyOpen, setBulkBuyOpen] = useState(false);
  // Phase 9.3 — assign-to modal open state.
  const [assignOpen, setAssignOpen] = useState(false);
  // Phase 9.5 — bulk tag / hold modal open state. v1-DEPENDENT — hidden when
  // v1_features_enabled is false.
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkHoldOpen, setBulkHoldOpen] = useState(false);
  const featureFlagsQuery = useAppQuery({
    queryKey: ["cockpit-feature-flags"],
    queryFn: () => getCockpitFeatureFlags(),
    tier: CACHE_TIERS.SESSION,
  });
  const v1Enabled = featureFlagsQuery.data?.v1_features_enabled === true;
  function toggleSelect(id: string) {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectVisible(ids: string[]) {
    setSelectedIds((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  const filters: CockpitFilters = useMemo(
    () => ({
      orderStatus: state.orderStatus,
      orgId: state.orgId || undefined,
      storeId: state.storeId,
      tab: state.tab,
      search: state.search.trim() || undefined,
      sort: state.sort,
      page: state.page,
      pageSize: state.pageSize,
      tagIds: state.tagIds.length > 0 ? state.tagIds : undefined,
      assignedUserId: state.assignedUserId,
    }),
    [state],
  );

  const { data, isLoading, refetch } = useAppQuery({
    queryKey: ["shipstation-orders-db", filters],
    queryFn: () => getShipStationOrdersDb(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const refreshFromSS = useAppMutation({
    mutationFn: () => refreshShipStationOrdersFromSS({ windowMinutes: 30 }),
    onSuccess: () => refetch(),
  });

  // ── Phase 8.5 — tag definitions (for chips + filter chip rendering) ──────
  const tagsDefQuery = useAppQuery({
    queryKey: ["ss-tag-defs"],
    queryFn: () => listShipStationTagDefinitions(),
    tier: CACHE_TIERS.SESSION,
  });
  const tagDefById = useMemo(() => {
    const m = new Map<number, { name: string; color: string | null }>();
    for (const t of tagsDefQuery.data ?? []) {
      m.set(t.tagId, { name: t.name, color: t.color ?? null });
    }
    return m;
  }, [tagsDefQuery.data]);

  const orders = data?.orders ?? [];
  const total = data?.total ?? 0;
  const tabCounts =
    data?.tabCounts ?? { all: 0, preorder: 0, preorder_ready: 0, needs_assignment: 0 };

  function patchState(patch: Partial<CockpitState>) {
    setState((s) => ({ ...s, ...patch }));
  }

  // Phase 5 retro polish — auto-switch sort to release_date when entering preorder tabs.
  function setTab(tab: CockpitTab) {
    setState((s) => ({
      ...s,
      tab,
      page: 1,
      sort:
        (tab === "preorder" || tab === "preorder_ready") && s.sort !== "release_date"
          ? "release_date"
          : s.sort,
    }));
    // Phase 9.1 — reset selection on tab change. Staff would otherwise carry
    // selections across tabs (e.g. select on Preorders, switch to Ready, click
    // bulk-buy → buys against orders that aren't in the visible context).
    clearSelection();
  }

  // ── Group by client when explicitly requested ─────────────────────────────
  const grouped = useMemo(() => {
    if (state.groupBy !== "client") return null;
    const groups = new Map<string, { name: string; rows: CockpitOrder[] }>();
    for (const o of orders) {
      const key = o.org_id ?? "__unassigned__";
      const name = o.org_name ?? "Needs assignment";
      if (!groups.has(key)) groups.set(key, { name, rows: [] });
      groups.get(key)?.rows.push(o);
    }
    return Array.from(groups.values());
  }, [orders, state.groupBy]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      <CockpitStatusSidebar
        filters={filters}
        onPatchFilters={(patch) =>
          patchState({
            ...(patch.orderStatus != null && { orderStatus: patch.orderStatus }),
            ...(Object.hasOwn(patch, "orgId") && { orgId: patch.orgId ?? "" }),
            ...(Object.hasOwn(patch, "storeId") && { storeId: patch.storeId }),
            ...(Object.hasOwn(patch, "assignedUserId") && {
              assignedUserId: patch.assignedUserId,
            }),
            ...(patch.page != null && { page: patch.page }),
          })
        }
      />

      <main className="flex-1 min-w-0 overflow-y-auto p-6 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              ShipStation orders mirrored locally. Showing {orders.length} of {total}.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <CockpitSavedViews
              currentViewState={state as unknown as Record<string, unknown>}
              onLoadView={(loaded) => {
                setState((s) => ({ ...s, ...(loaded as Partial<CockpitState>) }));
              }}
            />
            {/* Phase 9.4 — Manual order entry deep link. SS owns the order
                creation form; we just pop their tab. */}
            <a
              href="https://ship11.shipstation.com/orders/awaiting-shipment?createOrder=true"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-muted transition-colors"
            >
              <ExternalLink className="h-4 w-4" />
              New SS order
            </a>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshFromSS.mutate()}
              disabled={refreshFromSS.isPending}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${refreshFromSS.isPending ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={state.tab} onValueChange={(v) => v && setTab(v as CockpitTab)}>
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

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Order #, customer, email, ship-to, SKU…"
              value={state.search}
              onChange={(e) => patchState({ search: e.target.value, page: 1 })}
              className="pl-9"
            />
          </div>

          <Select
            value={state.orderStatus}
            onValueChange={(v) => v && patchState({ orderStatus: v, page: 1 })}
          >
            <SelectTrigger className="w-44">
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
            value={state.sort}
            onValueChange={(v) => v && patchState({ sort: v as CockpitSort })}
          >
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="client_then_date">Client → Date</SelectItem>
              <SelectItem value="date">Date (newest first)</SelectItem>
              <SelectItem value="order_number">Order #</SelectItem>
              <SelectItem value="release_date">Release date (preorders)</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={state.groupBy}
            onValueChange={(v) => v && patchState({ groupBy: v as "none" | "client" })}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Group by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No group</SelectItem>
              <SelectItem value="client">Client</SelectItem>
            </SelectContent>
          </Select>

          {/* Phase 8.5 — active tag filter chips */}
          {state.tagIds.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {state.tagIds.map((tagId) => {
                const def = tagDefById.get(tagId);
                return (
                  <button
                    key={tagId}
                    type="button"
                    onClick={() =>
                      patchState({
                        tagIds: state.tagIds.filter((id) => id !== tagId),
                        page: 1,
                      })
                    }
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border bg-amber-50 text-amber-900 hover:bg-amber-100"
                  >
                    <TagIcon className="h-3 w-3" />
                    {def?.name ?? `tag ${tagId}`} ✕
                  </button>
                );
              })}
            </div>
          )}

          {/* Phase 8.4 — columns picker */}
          <details className="relative ml-auto">
            <summary className="cursor-pointer inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground select-none px-2 py-1 border rounded-md">
              <Settings2 className="h-3.5 w-3.5" /> Columns
            </summary>
            <div className="absolute right-0 top-full mt-1 z-10 w-44 bg-background border rounded-md shadow-md p-2 space-y-0.5">
              {ALL_OPTIONAL_COLUMNS.map((c) => (
                <label
                  key={c.key}
                  className="flex items-center gap-2 px-1.5 py-1 text-sm hover:bg-muted rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={state.columnPrefs[c.key]}
                    onChange={(e) =>
                      patchState({
                        columnPrefs: { ...state.columnPrefs, [c.key]: e.target.checked },
                      })
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </details>
        </div>

        {/* Phase 9.1 — bulk action toolbar (sticky-ish, only visible when ≥1 selected). */}
        {selectedIds.size > 0 && (
          <BulkActionToolbar
            selectedCount={selectedIds.size}
            onClear={clearSelection}
            onOpenBulkBuyLabels={() => setBulkBuyOpen(true)}
            onOpenAssign={() => setAssignOpen(true)}
            v1Enabled={v1Enabled}
            onOpenBulkTag={() => setBulkTagOpen(true)}
            onOpenBulkHold={() => setBulkHoldOpen(true)}
          />
        )}
        {bulkBuyOpen && (
          <BulkBuyLabelsModal
            selectedIds={Array.from(selectedIds)}
            visibleOrders={orders.filter((o) => selectedIds.has(o.id))}
            onClose={() => setBulkBuyOpen(false)}
            onCompleted={() => {
              clearSelection();
              setBulkBuyOpen(false);
              void refetch();
            }}
          />
        )}
        {assignOpen && (
          <AssignToModal
            selectedIds={Array.from(selectedIds)}
            onClose={() => setAssignOpen(false)}
            onCompleted={() => {
              clearSelection();
              setAssignOpen(false);
              void refetch();
            }}
          />
        )}
        {bulkTagOpen && (
          <BulkTagModal
            selectedIds={Array.from(selectedIds)}
            tagsDef={tagsDefQuery.data ?? []}
            onClose={() => setBulkTagOpen(false)}
            onCompleted={() => {
              clearSelection();
              setBulkTagOpen(false);
              void refetch();
            }}
          />
        )}
        {bulkHoldOpen && (
          <BulkHoldModal
            selectedIds={Array.from(selectedIds)}
            onClose={() => setBulkHoldOpen(false)}
            onCompleted={() => {
              clearSelection();
              setBulkHoldOpen(false);
              void refetch();
            }}
          />
        )}

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading orders…
          </div>
        ) : (
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[36px]">
                    <input
                      type="checkbox"
                      aria-label="Select all visible orders on this page"
                      checked={
                        orders.length > 0 &&
                        orders.every((o) => selectedIds.has(o.id))
                      }
                      onChange={(e) => {
                        if (e.target.checked) selectVisible(orders.map((o) => o.id));
                        else clearSelection();
                      }}
                    />
                  </TableHead>
                  <TableHead className="w-[160px]">Order #</TableHead>
                  {state.columnPrefs.client && <TableHead>Client</TableHead>}
                  {state.columnPrefs.customer && <TableHead>Customer</TableHead>}
                  {state.columnPrefs.ship_to && <TableHead>Ship To</TableHead>}
                  {state.columnPrefs.tags && <TableHead>Tags</TableHead>}
                  {state.columnPrefs.items && <TableHead>Items</TableHead>}
                  {state.columnPrefs.status && <TableHead>Status</TableHead>}
                  {state.columnPrefs.amount && <TableHead className="text-right">Amount</TableHead>}
                  {state.columnPrefs.order_date && <TableHead>Order Date</TableHead>}
                  {state.columnPrefs.tracking && <TableHead className="text-right">Tracking</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
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
                      tagDefById={tagDefById}
                      columnPrefs={state.columnPrefs}
                      onToggleTagFilter={(tagId) =>
                        patchState({
                          tagIds: state.tagIds.includes(tagId)
                            ? state.tagIds
                            : [...state.tagIds, tagId],
                          page: 1,
                        })
                      }
                      onRefetchOrders={refetch}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleSelect}
                    />
                  ))
                ) : (
                  orders.map((o) => (
                    <CockpitRow
                      key={o.id}
                      order={o}
                      isExpanded={expandedId === o.id}
                      onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)}
                      tagDefById={tagDefById}
                      columnPrefs={state.columnPrefs}
                      onToggleTagFilter={(tagId) =>
                        patchState({
                          tagIds: state.tagIds.includes(tagId)
                            ? state.tagIds
                            : [...state.tagIds, tagId],
                          page: 1,
                        })
                      }
                      onRefetchOrders={refetch}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleSelect}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        <PaginationBar
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={(page) => patchState({ page })}
          onPageSizeChange={(pageSize) => patchState({ pageSize, page: 1 })}
        />
      </main>
    </div>
  );
}

interface RowSharedProps {
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  tagDefById: Map<number, { name: string; color: string | null }>;
  columnPrefs: Record<ColumnKey, boolean>;
  onToggleTagFilter: (tagId: number) => void;
  onRefetchOrders: () => void;
  // Phase 9.1 — multi-select.
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}

function GroupRows({
  group,
  ...rest
}: { group: { name: string; rows: CockpitOrder[] } } & RowSharedProps) {
  return (
    <>
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell colSpan={11} className="font-semibold text-sm py-2">
          {group.name}{" "}
          <span className="text-muted-foreground font-normal">({group.rows.length})</span>
        </TableCell>
      </TableRow>
      {group.rows.map((o) => (
        <CockpitRow
          key={o.id}
          order={o}
          isExpanded={rest.expandedId === o.id}
          onToggle={() =>
            rest.setExpandedId(rest.expandedId === o.id ? null : o.id)
          }
          tagDefById={rest.tagDefById}
          columnPrefs={rest.columnPrefs}
          onToggleTagFilter={rest.onToggleTagFilter}
          onRefetchOrders={rest.onRefetchOrders}
          selectedIds={rest.selectedIds}
          onToggleSelect={rest.onToggleSelect}
        />
      ))}
    </>
  );
}

function CockpitRow({
  order,
  isExpanded,
  onToggle,
  tagDefById,
  columnPrefs,
  onToggleTagFilter,
  onRefetchOrders,
  selectedIds,
  onToggleSelect,
}: {
  order: CockpitOrder;
  isExpanded: boolean;
  onToggle: () => void;
} & Omit<RowSharedProps, "expandedId" | "setExpandedId">) {
  const ssDeepLink = buildShipStationOrderPageUrl(order.shipstation_order_id);
  const itemCount = order.items.reduce((sum, i) => sum + (i.quantity ?? 1), 0);
  const isUnassigned = !order.org_id;
  const isSelected = selectedIds.has(order.id);

  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell onClick={(e) => e.stopPropagation()} className="w-[36px]">
          <input
            type="checkbox"
            aria-label={`Select order ${order.order_number}`}
            checked={isSelected}
            onChange={() => onToggleSelect(order.id)}
          />
        </TableCell>
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
          {order.hold_until_date && (
            <Badge
              variant="outline"
              className="ml-2 bg-gray-100 text-gray-700 border-gray-300"
              title={`On hold until ${order.hold_until_date}`}
            >
              <Pause className="h-2.5 w-2.5 mr-0.5" />
              hold
            </Badge>
          )}
        </TableCell>
        {columnPrefs.client && (
          <TableCell className="text-sm">
            {isUnassigned ? (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <UserPlus className="h-3.5 w-3.5" /> Needs assignment
              </span>
            ) : (
              order.org_name ?? "—"
            )}
          </TableCell>
        )}
        {columnPrefs.customer && (
          <TableCell className="text-sm">
            <div>{order.customer_name ?? "—"}</div>
            {order.customer_email && (
              <div className="text-xs text-muted-foreground">{order.customer_email}</div>
            )}
          </TableCell>
        )}
        {columnPrefs.ship_to && (
          <TableCell className="text-sm text-muted-foreground">
            {formatShipTo(order.ship_to)}
          </TableCell>
        )}
        {columnPrefs.tags && (
          <TableCell>
            <div className="flex flex-wrap gap-1">
              {order.tag_ids.length === 0 ? (
                <span className="text-muted-foreground text-xs">—</span>
              ) : (
                order.tag_ids.map((tagId) => {
                  const def = tagDefById.get(tagId);
                  return (
                    <button
                      key={tagId}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleTagFilter(tagId);
                      }}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border hover:bg-muted"
                      title={`Filter by ${def?.name ?? `tag ${tagId}`}`}
                    >
                      {def?.color && (
                        <span
                          className="inline-block w-2 h-2 rounded-sm"
                          style={{ backgroundColor: def.color }}
                        />
                      )}
                      {def?.name ?? tagId}
                    </button>
                  );
                })
              )}
            </div>
          </TableCell>
        )}
        {columnPrefs.items && <TableCell className="text-sm">{itemCount}</TableCell>}
        {columnPrefs.status && (
          <TableCell>
            <span
              className={`text-xs px-2 py-0.5 rounded font-medium whitespace-nowrap ${
                STATUS_COLORS[order.order_status] ?? "bg-gray-100 text-gray-700"
              }`}
            >
              {order.order_status.replace(/_/g, " ")}
            </span>
          </TableCell>
        )}
        {columnPrefs.amount && (
          <TableCell className="text-right font-mono text-sm">
            {order.amount_paid != null ? `$${order.amount_paid.toFixed(2)}` : "—"}
          </TableCell>
        )}
        {columnPrefs.order_date && (
          <TableCell className="text-sm text-muted-foreground">
            {order.order_date ? new Date(order.order_date).toLocaleDateString() : "—"}
          </TableCell>
        )}
        {columnPrefs.tracking && (
          <TableCell className="text-right text-sm">
            <TrackingCell order={order} />
          </TableCell>
        )}
      </TableRow>

      {isExpanded && (
        <TableRow>
          <TableCell colSpan={11} className="bg-muted/20 px-4 py-3 align-top">
            <div className="min-w-0">
              <CockpitDrawer
                order={order}
                tagDefById={tagDefById}
                onRefetchOrders={onRefetchOrders}
              />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

function CockpitDrawer({
  order,
  tagDefById,
  onRefetchOrders,
}: {
  order: CockpitOrder;
  tagDefById: Map<number, { name: string; color: string | null }>;
  onRefetchOrders: () => void;
}) {
  const [showEditTags, setShowEditTags] = useState(false);

  return (
    <div className="space-y-4">
      {/* ── Phase 6.2 — Bandcamp reconciliation badge ────────────────────── */}
      <BandcampReconcileBadge order={order} />
      {/* ── Phase 11.2 — Bandcamp enrichment (note, gift, payment) ──────── */}
      <BandcampDrawerEnrichment order={order} />

      {/* ── Writeback error banner (Phase 4.5 + 8 retry button) ──────────── */}
      {order.shipment?.shipstation_writeback_error && (
        <WritebackErrorBanner order={order} onRefetch={onRefetchOrders} />
      )}

      {/* ── Top grid: Ship To (with verify) + Display fields + Items ──────
          Stacks on small/medium screens. minmax(0, 1fr) on each column so
          long content (item names, ship-to lines) wraps inside the column
          rather than blowing the column out and forcing horizontal scroll. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-6">
        <div className="min-w-0">
          <ShipToWithVerify order={order} onRefetch={onRefetchOrders} />
        </div>
        <div className="min-w-0">
          <DisplayOnlyFieldsPanel order={order} />
        </div>
        <div className="min-w-0">
          <ItemsPanel order={order} />
        </div>
      </div>

      {/* ── Tag chips + Edit Tags button (Phase 8.5) ────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tags
        </span>
        {order.tag_ids.length === 0 ? (
          <span className="text-xs text-muted-foreground">none</span>
        ) : (
          order.tag_ids.map((tagId) => {
            const def = tagDefById.get(tagId);
            return (
              <span
                key={tagId}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border"
              >
                {def?.color && (
                  <span
                    className="inline-block w-2 h-2 rounded-sm"
                    style={{ backgroundColor: def.color }}
                  />
                )}
                {def?.name ?? `tag ${tagId}`}
              </span>
            );
          })
        )}
        <Button size="sm" variant="outline" onClick={() => setShowEditTags(true)}>
          <TagIcon className="h-3.5 w-3.5 mr-1.5" />
          Edit Tags
        </Button>
      </div>
      <CockpitEditTagsModal
        open={showEditTags}
        onClose={() => setShowEditTags(false)}
        shipstationOrderUuid={order.id}
        currentTagIds={order.tag_ids}
        onSaved={onRefetchOrders}
      />

      {/* ── Hold-until controls (Phase 8.6) ──────────────────────────────── */}
      <HoldUntilPanel order={order} onRefetch={onRefetchOrders} />

      {/* ── Manual org assignment (polish) — only when org_id IS NULL ────── */}
      {!order.org_id && <NeedsAssignmentDropdown order={order} onRefetch={onRefetchOrders} />}

      {/* ── Bottom toolbar: Print Slip + Scan-to-Verify + Buy Label panel ── */}
      <DrawerBottomToolbar order={order} onRefetchOrders={onRefetchOrders} />
    </div>
  );
}

// ─── Drawer sub-panels ──────────────────────────────────────────────────────

function ShipToWithVerify({
  order,
  onRefetch,
}: {
  order: CockpitOrder;
  onRefetch: () => void;
}) {
  const [showFix, setShowFix] = useState(false);

  // Phase 8.7 — verify on demand. We don't auto-run on every drawer open
  // because EP costs apply per address verification (small, but real).
  const verifyMut = useAppMutation({
    mutationFn: () =>
      verifyShipStationOrderAddress({ shipstationOrderUuid: order.id }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Ship To
        </p>
        <button
          type="button"
          className="text-xs text-blue-600 hover:underline"
          onClick={() => verifyMut.mutate()}
          disabled={verifyMut.isPending}
        >
          {verifyMut.isPending ? (
            <>
              <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
              Verifying…
            </>
          ) : (
            "Verify address"
          )}
        </button>
      </div>
      {order.ship_to ? (
        (() => {
          const st = order.ship_to as Record<string, unknown>;
          const s = (k: string): string | null => {
            const v = st[k];
            return typeof v === "string" && v.length > 0 ? v : null;
          };
          return (
            <address className="text-sm not-italic space-y-0.5">
              {s("name") && <div className="font-medium">{s("name")}</div>}
              {s("street1") && <div className="text-muted-foreground">{s("street1")}</div>}
              {s("street2") && <div className="text-muted-foreground">{s("street2")}</div>}
              {(s("city") || s("state") || s("postalCode")) && (
                <div className="text-muted-foreground">
                  {[s("city"), s("state"), s("postalCode")].filter(Boolean).join(", ")}
                </div>
              )}
              {s("country") && s("country") !== "US" && (
                <div className="text-muted-foreground">{s("country")}</div>
              )}
            </address>
          );
        })()
      ) : (
        <span className="text-sm text-muted-foreground">No ship-to recorded</span>
      )}

      {verifyMut.data && (
        <div className="mt-2 text-xs">
          {verifyMut.data.verified ? (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              Address verified by EasyPost
            </span>
          ) : (
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertTriangle className="h-3 w-3" />
                Verification failed
              </span>
              <ul className="list-disc pl-4 text-amber-800">
                {verifyMut.data.errors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
              <button
                type="button"
                className="text-blue-600 hover:underline"
                onClick={() => setShowFix(true)}
              >
                Edit address →
              </button>
            </div>
          )}
        </div>
      )}

      {showFix && (
        <FixAddressOverlay
          order={order}
          onClose={() => setShowFix(false)}
          onSaved={() => {
            setShowFix(false);
            onRefetch();
          }}
        />
      )}
    </div>
  );
}

function FixAddressOverlay({
  order,
  onClose,
  onSaved,
}: {
  order: CockpitOrder;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = (order.ship_to ?? {}) as Record<string, unknown>;
  const init = (k: string): string => (typeof initial[k] === "string" ? (initial[k] as string) : "");
  const [name, setName] = useState(init("name"));
  const [street1, setStreet1] = useState(init("street1"));
  const [street2, setStreet2] = useState(init("street2"));
  const [city, setCity] = useState(init("city"));
  const [stateVal, setStateVal] = useState(init("state"));
  const [postalCode, setPostalCode] = useState(init("postalCode") || init("zip"));
  const [country, setCountry] = useState(init("country") || "US");

  const saveMut = useAppMutation({
    mutationFn: () =>
      updateShipStationOrderShipTo({
        shipstationOrderUuid: order.id,
        ship_to: { name, street1, street2, city, state: stateVal, postalCode, country },
      }),
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background border rounded-lg shadow-xl w-[480px] max-h-[80vh] overflow-y-auto">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm">Edit Ship-To</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground">
            ✕
          </button>
        </div>
        <div className="p-4 grid grid-cols-2 gap-3 text-sm">
          <label className="col-span-2 space-y-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-xs text-muted-foreground">Street 1</span>
            <Input value={street1} onChange={(e) => setStreet1(e.target.value)} />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-xs text-muted-foreground">Street 2</span>
            <Input value={street2} onChange={(e) => setStreet2(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">City</span>
            <Input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">State / Region</span>
            <Input value={stateVal} onChange={(e) => setStateVal(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Postal code</span>
            <Input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Country</span>
            <Input value={country} onChange={(e) => setCountry(e.target.value)} />
          </label>
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function DisplayOnlyFieldsPanel({ order }: { order: CockpitOrder }) {
  const ssEditUrl = buildShipStationOrderPageUrl(order.shipstation_order_id);
  const fields: Array<{ label: string; value: string | null; Icon?: typeof Calendar }> = [
    { label: "Ship by", value: order.ship_by_date, Icon: Truck },
    { label: "Deliver by", value: order.deliver_by_date, Icon: Calendar },
    {
      label: "Date paid",
      value: order.payment_date ? new Date(order.payment_date).toLocaleDateString() : null,
    },
    { label: "Assignee", value: order.assignee_user_id, Icon: User },
    { label: "Allocation", value: order.allocation_status, Icon: MapPin },
  ];
  const visible = fields.filter((f) => f.value);
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        Details
      </p>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No additional fields from ShipStation.</p>
      ) : (
        <dl className="text-sm space-y-0.5">
          {visible.map((f) => (
            <div key={f.label} className="flex items-center gap-1.5">
              {f.Icon && <f.Icon className="h-3 w-3 text-muted-foreground" />}
              <dt className="text-muted-foreground w-20 text-xs">{f.label}:</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <a
        href={ssEditUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-2"
        onClick={(e) => e.stopPropagation()}
      >
        Edit in ShipStation <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function ItemsPanel({ order }: { order: CockpitOrder }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        Items
      </p>
      <div className="space-y-1">
        {order.items.map((item) => (
          <div
            key={item.item_index}
            className="flex items-baseline justify-between gap-4 text-sm min-w-0"
          >
            <div className="min-w-0 flex-1 break-words">
              {item.sku && (
                <span className="font-mono text-xs text-muted-foreground mr-1.5">
                  {item.sku}
                </span>
              )}
              <span className="break-words">{item.name ?? "—"}</span>
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
  );
}

function HoldUntilPanel({ order, onRefetch }: { order: CockpitOrder; onRefetch: () => void }) {
  const [date, setDate] = useState(
    order.hold_until_date ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  );
  const setMut = useAppMutation({
    mutationFn: () =>
      setOrderHoldUntil({ shipstationOrderUuid: order.id, holdUntilDate: date }),
    onSuccess: () => onRefetch(),
  });
  const restoreMut = useAppMutation({
    mutationFn: () => restoreOrderFromHoldAction({ shipstationOrderUuid: order.id }),
    onSuccess: () => onRefetch(),
  });

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Hold until
      </span>
      <Input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="w-44 h-8"
      />
      <Button size="sm" variant="outline" onClick={() => setMut.mutate()} disabled={setMut.isPending}>
        <Pause className="h-3.5 w-3.5 mr-1.5" />
        {order.hold_until_date ? "Update hold" : "Set hold"}
      </Button>
      {order.hold_until_date && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => restoreMut.mutate()}
          disabled={restoreMut.isPending}
        >
          <Play className="h-3.5 w-3.5 mr-1.5" />
          Restore from hold
        </Button>
      )}
      {(setMut.data?.remoteSuccess === false || restoreMut.data?.remoteSuccess === false) && (
        <span className="text-xs text-amber-700">
          Local update saved; SS write returned an error — verify in dashboard.
        </span>
      )}
    </div>
  );
}

function NeedsAssignmentDropdown({
  order,
  onRefetch,
}: {
  order: CockpitOrder;
  onRefetch: () => void;
}) {
  const orgsQuery = useAppQuery({
    queryKey: ["orgs-for-assignment"],
    queryFn: () => listOrgsForAssignment(),
    tier: CACHE_TIERS.SESSION,
  });
  const [pickedOrgId, setPickedOrgId] = useState<string>("");
  const assignMut = useAppMutation({
    mutationFn: () =>
      assignOrgToShipStationOrder({
        shipstationOrderId: order.id,
        orgId: pickedOrgId,
      }),
    onSuccess: () => onRefetch(),
  });

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-semibold flex items-center gap-1.5 mb-2">
        <UserPlus className="h-4 w-4" />
        Assign a client to this order
      </p>
      <div className="flex items-center gap-2">
        <Select value={pickedOrgId} onValueChange={(v) => v && setPickedOrgId(v)}>
          <SelectTrigger className="w-72 bg-background">
            <SelectValue placeholder="Pick a client…" />
          </SelectTrigger>
          <SelectContent>
            {(orgsQuery.data ?? []).map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={!pickedOrgId || assignMut.isPending}
          onClick={() => assignMut.mutate()}
        >
          {assignMut.isPending ? (
            <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
          ) : null}
          Assign
        </Button>
      </div>
    </div>
  );
}

function WritebackErrorBanner({
  order,
  onRefetch,
}: {
  order: CockpitOrder;
  onRefetch: () => void;
}) {
  const retryMut = useAppMutation({
    mutationFn: () => retryShipStationWriteback({ shipstationOrderUuid: order.id }),
    onSuccess: () => {
      // The retry runs async on Trigger.dev; refetch after a short delay so
      // the cockpit shows the new state.
      setTimeout(onRefetch, 4000);
    },
  });
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="space-y-1 min-w-0 flex-1">
          <p className="font-semibold">ShipStation write-back failed</p>
          <p className="text-xs break-words">{order.shipment?.shipstation_writeback_error}</p>
          <p className="text-xs text-amber-800">
            The label was printed successfully — only the "mark shipped in SS" step failed.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 bg-background"
          onClick={() => retryMut.mutate()}
          disabled={retryMut.isPending}
        >
          {retryMut.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Retrying…
            </>
          ) : (
            <>
              <RotateCw className="h-3.5 w-3.5 mr-1.5" />
              Retry write-back
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ─── Tracking column ────────────────────────────────────────────────────────

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

// ─── Phase 6.2 — Bandcamp reconciliation badge ─────────────────────────────

const RECONCILE_BADGE_STYLE: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-800 border-emerald-200",
  medium: "bg-blue-50 text-blue-800 border-blue-200",
  low: "bg-amber-50 text-amber-800 border-amber-200",
  none: "bg-gray-50 text-gray-700 border-gray-200",
};

function BandcampReconcileBadge({ order }: { order: CockpitOrder }) {
  const matchQuery = useAppQuery({
    queryKey: ["bc-reconcile", order.id],
    queryFn: () => getBandcampMatchForShipStationOrder({ shipstationOrderUuid: order.id }),
    tier: CACHE_TIERS.SESSION,
  });

  if (matchQuery.isLoading || !matchQuery.data) return null;
  const m = matchQuery.data;
  // Don't render anything when there's no candidate AND the order isn't from a
  // Bandcamp-marketplace store (avoid noise on Shopify-only orders).
  if (m.confidence === "none") return null;

  const style = RECONCILE_BADGE_STYLE[m.confidence] ?? RECONCILE_BADGE_STYLE.none;
  return (
    <div
      className={`rounded-md border px-3 py-2 text-xs flex items-center justify-between gap-2 ${style}`}
    >
      <span>
        <strong>Bandcamp match:</strong>{" "}
        {m.order_number ?? `BC-${m.bandcamp_payment_id}`} — confidence:{" "}
        <strong>{m.confidence}</strong>{" "}
        <span className="opacity-75">({m.matched_via})</span>
      </span>
    </div>
  );
}

// ─── Phase 11.2 — Bandcamp drawer enrichment (note, gift, payment) ─────────

function BandcampDrawerEnrichment({ order }: { order: CockpitOrder }) {
  const enrichmentQuery = useAppQuery({
    queryKey: ["bc-enrichment", order.id],
    queryFn: () => getBandcampEnrichmentForCockpit({ shipstationOrderUuid: order.id }),
    tier: CACHE_TIERS.SESSION,
  });
  if (enrichmentQuery.isLoading || !enrichmentQuery.data) return null;
  const e = enrichmentQuery.data;
  if (!e.has_data) return null;

  // Render only sections that have content. Skip the panel entirely when
  // every field is empty (defensive — has_data should already gate this).
  const showNote = !!e.buyer_note;
  const showGift = !!e.ship_notes;
  const showTip = e.additional_fan_contribution != null && e.additional_fan_contribution > 0;
  const showPayment = !!e.payment_state || !!e.paypal_transaction_id;
  if (!showNote && !showGift && !showTip && !showPayment) return null;

  return (
    <div className="space-y-2">
      {showNote && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs">
          <div className="font-semibold uppercase tracking-wide opacity-75 mb-0.5">
            Note from buyer
          </div>
          <div className="whitespace-pre-wrap text-blue-900">{e.buyer_note}</div>
        </div>
      )}
      {showGift && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs">
          <div className="font-semibold uppercase tracking-wide opacity-75 mb-0.5">
            Gift / ship instructions
          </div>
          <div className="whitespace-pre-wrap text-rose-900">{e.ship_notes}</div>
        </div>
      )}
      {(showTip || showPayment) && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <div className="font-semibold uppercase tracking-wide opacity-75 mb-1">
            Payment info
          </div>
          <div className="grid grid-cols-2 gap-2">
            {e.payment_state && (
              <div>
                <span className="opacity-75">State:</span>{" "}
                <span
                  className={
                    e.payment_state === "paid"
                      ? "text-emerald-700 font-medium"
                      : e.payment_state === "refunded"
                        ? "text-rose-700 font-medium"
                        : "font-medium"
                  }
                >
                  {e.payment_state}
                </span>
              </div>
            )}
            {e.paypal_transaction_id && (
              <div className="font-mono text-[11px] truncate" title={e.paypal_transaction_id}>
                <span className="opacity-75 not-italic">PayPal:</span>{" "}
                {e.paypal_transaction_id}
              </div>
            )}
            {showTip && (
              <div className="col-span-2">
                <span className="opacity-75">Fan tip:</span>{" "}
                <span className="font-medium">
                  +${e.additional_fan_contribution!.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Phase 9.1 — Bulk action toolbar ───────────────────────────────────────

function BulkActionToolbar({
  selectedCount,
  onClear,
  onOpenBulkBuyLabels,
  onOpenAssign,
  v1Enabled,
  onOpenBulkTag,
  onOpenBulkHold,
}: {
  selectedCount: number;
  onClear: () => void;
  onOpenBulkBuyLabels: () => void;
  onOpenAssign: () => void;
  v1Enabled: boolean;
  onOpenBulkTag: () => void;
  onOpenBulkHold: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <strong>{selectedCount}</strong>
        <span className="text-muted-foreground">
          order{selectedCount === 1 ? "" : "s"} selected
        </span>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onOpenAssign}>
          Assign to…
        </Button>
        {v1Enabled && (
          <>
            <Button size="sm" variant="outline" onClick={onOpenBulkTag}>
              Tags…
            </Button>
            <Button size="sm" variant="outline" onClick={onOpenBulkHold}>
              Hold until…
            </Button>
          </>
        )}
        <Button size="sm" onClick={onOpenBulkBuyLabels}>
          Buy + Print Labels…
        </Button>
      </div>
    </div>
  );
}

// ─── Phase 9.2 — DrawerBottomToolbar (Print Slip + Scan-to-Verify + Buy Label)

function DrawerBottomToolbar({
  order,
  onRefetchOrders,
}: {
  order: CockpitOrder;
  onRefetchOrders: () => void;
}) {
  const [scanOpen, setScanOpen] = useState(false);
  const [verified, setVerified] = useState(false);
  return (
    <div className="pt-3 border-t space-y-3">
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
        <button
          type="button"
          onClick={() => setScanOpen(true)}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-colors ${
            verified ? "bg-emerald-50 border-emerald-300 text-emerald-800" : "hover:bg-muted"
          }`}
        >
          {verified ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Verified
            </>
          ) : (
            <>
              <ScanLine className="h-3.5 w-3.5" />
              Scan to Verify
            </>
          )}
        </button>
      </div>
      {scanOpen && (
        <ScanToVerifyModal
          items={order.items}
          onClose={() => setScanOpen(false)}
          onAllVerified={() => setVerified(true)}
        />
      )}
      {order.org_id ? (
        <CreateLabelPanel
          orderId={order.id}
          orderType="shipstation"
          customerShippingCharged={order.shipping_paid ?? null}
          onSuccess={() => onRefetchOrders()}
        />
      ) : (
        <p className="text-xs text-amber-700">
          Assign a client above before printing a label.
        </p>
      )}
    </div>
  );
}

// ─── Phase 9.3 — Assign to staff modal ─────────────────────────────────────

function AssignToModal({
  selectedIds,
  onClose,
  onCompleted,
}: {
  selectedIds: string[];
  onClose: () => void;
  onCompleted: () => void;
}) {
  const staffQuery = useAppQuery({
    queryKey: ["assignable-staff"],
    queryFn: () => listAssignableStaff(),
    tier: CACHE_TIERS.SESSION,
  });
  const [chosenUserId, setChosenUserId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply(targetUserId: string | null) {
    setSubmitting(true);
    setErr(null);
    try {
      await assignOrders({
        shipstationOrderUuids: selectedIds,
        assignedUserId: targetUserId,
      });
      onCompleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="border-b px-4 py-3 text-sm font-semibold">
          Assign {selectedIds.length} order{selectedIds.length === 1 ? "" : "s"} to staff
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Local assignment only — does not update ShipStation. Pass empty / "Unassigned" to clear.
          </p>
          <select
            value={chosenUserId}
            onChange={(e) => setChosenUserId(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            disabled={staffQuery.isLoading}
          >
            <option value="">Unassigned</option>
            {(staffQuery.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name ?? u.email ?? u.id.slice(0, 8)}
              </option>
            ))}
          </select>
          {err && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {err}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void apply(chosenUserId || null)}
            disabled={submitting}
          >
            {submitting ? "Assigning…" : chosenUserId ? "Assign" : "Clear assignment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Phase 9.5 — Bulk tag modal (v1-DEPENDENT) ────────────────────────────

function BulkTagModal({
  selectedIds,
  tagsDef,
  onClose,
  onCompleted,
}: {
  selectedIds: string[];
  tagsDef: Array<{ tagId: number; name: string; color?: string | null }>;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [tagId, setTagId] = useState<number | null>(tagsDef[0]?.tagId ?? null);
  const [op, setOp] = useState<"add" | "remove">("add");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Estimated wall-clock at the SS rate limit (40 req/min = 1.5s/call).
  const estSec = Math.ceil((selectedIds.length * 1500) / 1000);

  async function apply() {
    if (tagId == null) return;
    setSubmitting(true);
    setErr(null);
    try {
      const fn = op === "add" ? bulkAddOrdersTag : bulkRemoveOrdersTag;
      const r = await fn({ shipstationOrderUuids: selectedIds, tagId });
      setResult({ ok: r.succeeded, failed: r.failed.length });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="border-b px-4 py-3 text-sm font-semibold">
          Bulk {op === "add" ? "add" : "remove"} tag
        </div>
        <div className="p-4 space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={op === "add" ? "default" : "outline"}
              onClick={() => setOp("add")}
            >
              Add
            </Button>
            <Button
              size="sm"
              variant={op === "remove" ? "default" : "outline"}
              onClick={() => setOp("remove")}
            >
              Remove
            </Button>
          </div>
          <select
            value={tagId ?? ""}
            onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}
            className="w-full rounded border px-2 py-1.5 text-sm"
          >
            {tagsDef.map((t) => (
              <option key={t.tagId} value={t.tagId}>
                {t.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-amber-700">
            ~{estSec}s wall-clock for {selectedIds.length} orders at the SS rate limit.
          </p>
          {result && (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
              Done — {result.ok} succeeded, {result.failed} failed.
            </div>
          )}
          {err && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {err}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button onClick={() => void apply()} disabled={submitting || tagId == null}>
              {submitting ? "Working…" : `${op === "add" ? "Add" : "Remove"} tag`}
            </Button>
          )}
          {result && (
            <Button onClick={onCompleted}>Refresh & close</Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Phase 9.5 — Bulk Hold-Until modal (v1-DEPENDENT) ─────────────────────

function BulkHoldModal({
  selectedIds,
  onClose,
  onCompleted,
}: {
  selectedIds: string[];
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [date, setDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const estSec = Math.ceil((selectedIds.length * 1500) / 1000);

  async function apply() {
    if (!date) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await bulkSetOrdersHoldUntil({
        shipstationOrderUuids: selectedIds,
        holdUntilDate: date,
      });
      setResult({ ok: r.succeeded, failed: r.failed.length });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="border-b px-4 py-3 text-sm font-semibold">
          Hold {selectedIds.length} order{selectedIds.length === 1 ? "" : "s"} until…
        </div>
        <div className="p-4 space-y-3 text-sm">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-sm"
          />
          <p className="text-xs text-amber-700">
            ~{estSec}s wall-clock at the SS rate limit.
          </p>
          {result && (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
              Done — {result.ok} succeeded, {result.failed} failed.
            </div>
          )}
          {err && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {err}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button onClick={() => void apply()} disabled={submitting || !date}>
              {submitting ? "Working…" : "Hold orders"}
            </Button>
          )}
          {result && <Button onClick={onCompleted}>Refresh & close</Button>}
        </div>
      </div>
    </div>
  );
}
