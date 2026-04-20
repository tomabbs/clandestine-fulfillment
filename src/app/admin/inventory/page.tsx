"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Download, ExternalLink, Minus, Package, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  adjustInventory,
  exportInventoryCsv,
  getInventoryDetail,
  getInventoryLevels,
  updateInventoryBuffer,
  updateVariantFormat,
} from "@/actions/inventory";
import { getOrganizations } from "@/actions/organizations";
// Saturday Workstream 3 (2026-04-18) — count session UI panel.
//   Lives inside the existing expanded-row detail (full-width, above the
//   Locations / Recent Activity 2-col grid). All five count Server Actions
//   are wrapped inside the component; no plumbing needed at the page level.
import { InventoryCountSessionPanel } from "@/components/admin/inventory-count-session-panel";
import { BlockList } from "@/components/shared/block-list";
import { EditableNumberCell, EditableSelectCell } from "@/components/shared/editable-cell";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import { formatRelativeTimeShort } from "@/lib/shared/utils";

const FORMAT_OPTIONS = [
  { value: "", label: "—", className: "text-muted-foreground" },
  { value: "LP", label: "LP" },
  { value: "2xLP", label: "2xLP" },
  { value: "CD", label: "CD" },
  { value: "Cassette", label: "Cassette" },
  { value: '7"', label: '7"' },
  { value: '10"', label: '10"' },
  { value: "Box Set", label: "Box Set" },
  { value: "Merch", label: "Merch" },
  { value: "Other", label: "Other" },
];

export default function InventoryPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({
    orgId: "",
    format: "",
    status: "",
    stockFilter: "" as "" | "in_stock" | "out_of_stock",
    search: "",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  useListPaginationPreference("admin/inventory", filters, setFilters);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [adjustDialog, setAdjustDialog] = useState<{
    sku: string;
    title: string;
  } | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [exporting, setExporting] = useState(false);

  const { data: orgs } = useAppQuery({
    queryKey: ["admin", "organizations"],
    queryFn: () => getOrganizations(),
    tier: CACHE_TIERS.SESSION,
  });

  const queryFilters = {
    ...(filters.orgId && { orgId: filters.orgId }),
    ...(filters.format && { format: filters.format }),
    ...(filters.status && { status: filters.status }),
    ...(filters.stockFilter && { stockFilter: filters.stockFilter }),
    ...(filters.search && { search: filters.search }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.inventory.list(queryFilters),
    queryFn: () => getInventoryLevels(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.inventory.detail(expandedSku ?? ""),
    queryFn: () => getInventoryDetail(expandedSku ?? ""),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!expandedSku,
  });

  const invalidateInventory = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all });
  }, [queryClient]);

  const adjustMutation = useAppMutation({
    mutationFn: async () => {
      if (!adjustDialog) throw new Error("No SKU selected");
      return adjustInventory(adjustDialog.sku, Number(adjustDelta), adjustReason);
    },
    invalidateKeys: [queryKeys.inventory.all],
    onSuccess: () => {
      setAdjustDialog(null);
      setAdjustDelta("");
      setAdjustReason("");
    },
  });

  const rows = data?.rows ?? [];
  const expandedKeys = useMemo(
    () =>
      expandedSku
        ? (new Set<string | number>([expandedSku]) as Set<string | number>)
        : (new Set<string | number>() as Set<string | number>),
    [expandedSku],
  );

  return (
    <PageShell
      title="Inventory"
      maxWidth="full"
      toolbar={
        <PageToolbar>
          <Input
            placeholder="Search SKU or title..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            className="w-64"
          />
          <select
            value={filters.orgId}
            onChange={(e) => setFilters((f) => ({ ...f, orgId: e.target.value, page: 1 }))}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm min-w-[180px]"
          >
            <option value="">All clients</option>
            {(orgs ?? []).map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
          <select
            value={filters.stockFilter}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                stockFilter: e.target.value as "" | "in_stock" | "out_of_stock",
                page: 1,
              }))
            }
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            <option value="">All stock levels</option>
            <option value="in_stock">In stock</option>
            <option value="out_of_stock">Out of stock</option>
          </select>
          <select
            value={filters.format}
            onChange={(e) => setFilters((f) => ({ ...f, format: e.target.value, page: 1 }))}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            <option value="">All formats</option>
            {FORMAT_OPTIONS.filter((f) => f.value).map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
          <PageToolbar.Actions>
            <Button
              variant="outline"
              size="sm"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  const csv = await exportInventoryCsv({
                    orgId: filters.orgId || undefined,
                    stockFilter: filters.stockFilter || undefined,
                    format: filters.format || undefined,
                    status: filters.status || undefined,
                    search: filters.search || undefined,
                  });
                  const blob = new Blob([csv], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  const orgName = orgs?.find((o) => o.id === filters.orgId)?.name ?? "all-clients";
                  a.href = url;
                  a.download = `inventory-${orgName.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().split("T")[0]}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                } finally {
                  setExporting(false);
                }
              }}
            >
              <Download className="h-4 w-4 mr-1" />
              {exporting ? "Exporting..." : "Export CSV"}
            </Button>
          </PageToolbar.Actions>
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
        items={rows}
        totalCount={data?.total}
        loading={isLoading}
        density="ops"
        itemKey={(row) => row.sku}
        ariaLabel="Inventory list"
        // Keep inventory in non-virtual mode for current pagination sizes (max 250)
        // until variable-height virtualization is hardened for dense editable rows.
        virtualizeThreshold={500}
        virtualizationHeightClassName="max-h-[72vh]"
        expandedKeys={expandedKeys}
        onExpandedKeysChange={(keys) => {
          const next = Array.from(keys)[0];
          setExpandedSku(next ? String(next) : null);
        }}
        renderHeader={({ row, expanded, toggleExpanded }) => (
          <div className="min-w-0 flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              {row.imageSrc ? (
                // biome-ignore lint/performance/noImgElement: external Shopify CDN URLs — next/image optimization not applicable
                <img
                  src={row.imageSrc}
                  alt={row.productTitle}
                  className="h-10 w-10 rounded object-cover"
                />
              ) : (
                <div className="bg-muted flex h-10 w-10 items-center justify-center rounded">
                  <Package className="text-muted-foreground h-4 w-4" />
                </div>
              )}
              <div className="min-w-0">
                <p className="font-medium truncate">{row.productTitle}</p>
                <p className="text-xs text-muted-foreground">{row.sku}</p>
                {row.countStatus === "count_in_progress" && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Counting{" "}
                    {row.countStartedAt ? `· ${formatRelativeTimeShort(row.countStartedAt)}` : ""}
                    {row.countStartedByName ? ` by ${row.countStartedByName}` : ""}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  setAdjustDialog({ sku: row.sku, title: row.productTitle });
                }}
              >
                Adjust
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={expanded ? "Collapse row details" : "Expand row details"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleExpanded();
                }}
              >
                <ChevronsUpDown className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        renderExceptionZone={({ row }) => (
          <div className="flex flex-wrap items-center gap-2">
            {row.available <= 0 ? (
              <StatusBadge intent="danger">Out of stock</StatusBadge>
            ) : (
              <StatusBadge intent="success">In stock</StatusBadge>
            )}
            {row.countStatus === "count_in_progress" && (
              <StatusBadge intent="warning">Count in progress</StatusBadge>
            )}
            {row.status !== "active" && <StatusBadge intent="neutral">{row.status}</StatusBadge>}
          </div>
        )}
        renderBody={({ row }) => (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border bg-background/60 p-2 space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Client</p>
              <p className="text-sm">{row.orgName ?? "—"}</p>
            </div>

            <div className="rounded-md border bg-background/60 p-2 space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Available</p>
              <EditableNumberCell
                value={row.available}
                prefix=""
                placeholder="0"
                precision={0}
                className="text-right font-mono"
                onSave={async (newValue) => {
                  const target = newValue ?? 0;
                  const delta = target - row.available;
                  if (delta === 0) return;
                  await adjustInventory(row.sku, delta, "Inline quantity edit");
                  invalidateInventory();
                }}
              />
            </div>

            <div className="rounded-md border bg-background/60 p-2 space-y-1">
              <p
                className="text-[11px] uppercase tracking-wide text-muted-foreground"
                title="Units shown on channels after safety buffer."
              >
                Listed As
              </p>
              <p className="text-right font-mono text-sm">
                {Math.max(0, row.available - (row.safetyStock ?? 3))}
              </p>
            </div>

            <div className="rounded-md border bg-background/60 p-2 space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Committed</p>
              <p className="text-right font-mono text-sm">{row.committed}</p>
            </div>

            <div className="rounded-md border bg-background/60 p-2 space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Incoming</p>
              <p className="text-right font-mono text-sm">{row.incoming}</p>
            </div>

            <div className="rounded-md border bg-background/60 p-2 space-y-1">
              <p
                className="text-[11px] uppercase tracking-wide text-muted-foreground"
                title="Units held back from channels."
              >
                Buffer
              </p>
              <EditableNumberCell
                value={row.safetyStock ?? 3}
                prefix=""
                placeholder="3"
                precision={0}
                className="text-right font-mono"
                onSave={async (newValue) => {
                  const val = newValue ?? null;
                  await updateInventoryBuffer(row.sku, val === 3 ? null : val);
                  invalidateInventory();
                }}
              />
            </div>

            <div className="rounded-md border bg-background/60 p-2 space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Format</p>
              <EditableSelectCell
                value={row.formatName ?? ""}
                options={FORMAT_OPTIONS}
                className="text-sm"
                onSave={async (newValue) => {
                  await updateVariantFormat(row.variantId, newValue);
                  invalidateInventory();
                }}
              />
            </div>
          </div>
        )}
        renderExpanded={({ row }) => (
          <div className="rounded-md border bg-muted/30 p-4">
            {detailLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : detail && expandedSku === row.sku ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <InventoryCountSessionPanel sku={row.sku} />

                <div>
                  <h4 className="mb-2 text-sm font-semibold">Locations</h4>
                  {detail.locations.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No location data</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {detail.locations.map((loc) => (
                        <li key={loc.locationId} className="flex justify-between gap-2">
                          <span className="min-w-0 break-words">
                            {loc.locationName}{" "}
                            <span className="text-muted-foreground">({loc.locationType})</span>
                          </span>
                          <span className="font-mono shrink-0">{loc.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.bandcampUrl && (
                    <a
                      href={detail.bandcampUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Bandcamp
                    </a>
                  )}
                </div>

                <div>
                  <h4 className="mb-2 text-sm font-semibold">Recent Activity</h4>
                  {detail.recentActivity.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No activity yet</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {detail.recentActivity.slice(0, 10).map((a) => (
                        <li key={a.id} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1 min-w-0">
                            {a.delta > 0 ? (
                              <Plus className="h-3 w-3 text-green-600" />
                            ) : (
                              <Minus className="h-3 w-3 text-red-600" />
                            )}
                            <span className="font-mono shrink-0">
                              {a.delta > 0 ? `+${a.delta}` : a.delta}
                            </span>
                            <span className="text-muted-foreground truncate">{a.source}</span>
                          </span>
                          <span className="text-muted-foreground text-xs shrink-0">
                            {new Date(a.createdAt).toLocaleDateString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}
        emptyState={
          <EmptyState
            title="No inventory found"
            description="No products match the selected filters."
          />
        }
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

      {/* Adjust Dialog */}
      <Dialog
        open={!!adjustDialog}
        onOpenChange={(open) => {
          if (!open) {
            setAdjustDialog(null);
            setAdjustDelta("");
            setAdjustReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Inventory — {adjustDialog?.sku}</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">{adjustDialog?.title}</p>
          <div className="space-y-3 pt-2">
            <div>
              <label htmlFor="adjust-delta" className="text-sm font-medium">
                Delta (positive to add, negative to remove)
              </label>
              <Input
                id="adjust-delta"
                type="number"
                value={adjustDelta}
                onChange={(e) => setAdjustDelta(e.target.value)}
                placeholder="e.g. -5 or 10"
              />
            </div>
            <div>
              <label htmlFor="adjust-reason" className="text-sm font-medium">
                Reason
              </label>
              <Input
                id="adjust-reason"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="Reason for adjustment..."
              />
            </div>
            <Button
              className="w-full"
              disabled={
                !adjustDelta ||
                Number(adjustDelta) === 0 ||
                !adjustReason ||
                adjustMutation.isPending
              }
              onClick={() => adjustMutation.mutate()}
            >
              {adjustMutation.isPending ? "Adjusting..." : "Confirm Adjustment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
