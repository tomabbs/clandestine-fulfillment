"use client";

import { ChevronsUpDown, ExternalLink, Minus, Package, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  getClientInventoryLevels,
  getInventoryDetail,
  updateInventoryBuffer,
} from "@/actions/inventory";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function InventoryPage() {
  const [filters, setFilters] = useState({
    format: "",
    search: "",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  useListPaginationPreference("portal/inventory", filters, setFilters);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const queryFilters = {
    ...(filters.format && { format: filters.format }),
    ...(filters.search && { search: filters.search }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  // Explicitly scoped to client's own org via requireClient() in server action
  const { data, isLoading, error } = useAppQuery({
    queryKey: queryKeys.inventory.list({ ...queryFilters, portal: true }),
    queryFn: () => getClientInventoryLevels(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.inventory.detail(expandedSku ?? ""),
    queryFn: () => getInventoryDetail(expandedSku ?? ""),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!expandedSku,
  });
  const rows = data?.rows ?? [];
  const expandedKeys = useMemo(
    () =>
      expandedSku
        ? (new Set<string | number>([expandedSku]) as Set<string | number>)
        : (new Set<string | number>() as Set<string | number>),
    [expandedSku],
  );

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        <Link
          href="/portal/inventory/activity"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          View Activity Log
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search SKU or title..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <Input
          placeholder="Filter by format..."
          value={filters.format}
          onChange={(e) => setFilters((f) => ({ ...f, format: e.target.value, page: 1 }))}
          className="w-40"
        />
      </div>

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
        ariaLabel="Client inventory list"
        virtualizeThreshold={500}
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
              <span className="inline-flex items-center gap-1">
                {expanded ? "Hide" : "Details"} <ChevronsUpDown className="h-3.5 w-3.5" />
              </span>
            </button>
          </div>
        )}
        renderBody={({ row }) => (
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 text-sm">
            <MetricCard label="In stock" value={String(row.available)} mono />
            <MetricCard
              label="Listed as"
              value={String(Math.max(0, row.available - (row.safetyStock ?? 3)))}
              mono
            />
            <MetricCard label="Committed" value={String(row.committed)} mono />
            <MetricCard label="Incoming" value={String(row.incoming)} mono />
            <div className="rounded-md border bg-background/60 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                Buffer
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground px-1"
                  title="Reduce buffer"
                  onClick={async () => {
                    const cur = row.safetyStock ?? 3;
                    const next = Math.max(0, cur - 1);
                    await updateInventoryBuffer(row.sku, next === 3 ? null : next);
                  }}
                >
                  <Minus className="h-3 w-3" />
                </button>
                <span className="font-mono text-sm w-6 text-center">{row.safetyStock ?? 3}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground px-1"
                  title="Increase buffer"
                  onClick={async () => {
                    const cur = row.safetyStock ?? 3;
                    const next = Math.min(20, cur + 1);
                    await updateInventoryBuffer(row.sku, next === 3 ? null : next);
                  }}
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>
            <MetricCard label="Format" value={row.formatName ?? "—"} />
          </div>
        )}
        renderExpanded={({ row }) => (
          <div className="rounded-md border bg-muted/30 p-4">
            {detailLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : detail && expandedSku === row.sku ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <h4 className="mb-2 text-sm font-semibold">Locations</h4>
                  {detail.locations.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No location data</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {detail.locations.map((loc) => (
                        <li key={loc.locationId} className="flex justify-between">
                          <span>
                            {loc.locationName}{" "}
                            <span className="text-muted-foreground">({loc.locationType})</span>
                          </span>
                          <span className="font-mono">{loc.quantity}</span>
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
                              <Plus className="h-3 w-3 text-green-600 shrink-0" />
                            ) : (
                              <Minus className="h-3 w-3 text-red-600 shrink-0" />
                            )}
                            <span className="font-mono">
                              {a.delta > 0 ? `+${a.delta}` : a.delta}
                            </span>
                            {a.previousQuantity != null && a.newQuantity != null && (
                              <span className="text-muted-foreground text-xs font-mono">
                                ({a.previousQuantity}→{a.newQuantity})
                              </span>
                            )}
                            <span className="text-muted-foreground truncate">{a.sourceLabel}</span>
                            {a.referenceId && (
                              <span className="text-muted-foreground text-xs truncate">
                                · {a.referenceId}
                              </span>
                            )}
                          </span>
                          <span className="text-muted-foreground text-xs whitespace-nowrap">
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
          <EmptyState title="No inventory found" description="No products match current filters." />
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
    </div>
  );
}

function MetricCard({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-sm" : "text-sm"}>{value}</p>
    </div>
  );
}
