"use client";

import { ArrowDown, ArrowUp, Download, Minus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { exportClientInventoryActivity, getClientInventoryActivity } from "@/actions/inventory";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageShell } from "@/components/shared/page-shell";
import { PageToolbar } from "@/components/shared/page-toolbar";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const SOURCE_OPTIONS = [
  { value: "", label: "All sources" },
  { value: "shopify", label: "Shopify order" },
  { value: "bandcamp", label: "Bandcamp sale" },
  { value: "woocommerce", label: "WooCommerce order" },
  { value: "squarespace", label: "Squarespace order" },
  { value: "shipstation", label: "ShipStation order" },
  { value: "inbound", label: "Inbound shipment" },
  { value: "manual", label: "Manual adjustment" },
  { value: "preorder", label: "Pre-order allocation" },
  { value: "backfill", label: "Inventory backfill" },
];

const DATE_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export default function InventoryActivityPage() {
  const [filters, setFilters] = useState({
    sku: "",
    source: "",
    dateRange: "30d" as "7d" | "30d" | "90d" | "all",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });
  const [exporting, setExporting] = useState(false);

  const queryFilters = {
    ...(filters.sku && { sku: filters.sku }),
    ...(filters.source && { source: filters.source }),
    dateRange: filters.dateRange,
    page: filters.page,
    pageSize: filters.pageSize,
  };

  const { data, isLoading, error } = useAppQuery({
    queryKey: queryKeys.inventory.activity(queryFilters),
    queryFn: () => getClientInventoryActivity(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  async function handleExport() {
    setExporting(true);
    try {
      const csv = await exportClientInventoryActivity({
        sku: filters.sku || undefined,
        source: filters.source || undefined,
        dateRange: filters.dateRange,
      });
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `inventory-activity-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <PageShell
      title="Inventory Activity Log"
      description="Every inventory change for your catalog — orders, shipments, manual adjustments, and inbound stock."
      actions={
        <>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
            <Download className="h-4 w-4 mr-1" />
            {exporting ? "Exporting..." : "Export CSV"}
          </Button>
          <Link
            href="/portal/inventory"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            ← Inventory
          </Link>
        </>
      }
      toolbar={
        <PageToolbar>
          <Input
            placeholder="Filter by SKU..."
            value={filters.sku}
            onChange={(e) => setFilters((f) => ({ ...f, sku: e.target.value, page: 1 }))}
            className="w-52"
          />
          <Select
            value={filters.source}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, source: !v || v === "__all__" ? "" : v, page: 1 }))
            }
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value || "__all__"} value={opt.value || "__all__"}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.dateRange}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, dateRange: v as typeof filters.dateRange, page: 1 }))
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        items={data?.rows ?? []}
        totalCount={data?.total}
        itemKey={(row) => row.id}
        loading={isLoading}
        density="ops"
        ariaLabel="Inventory activity entries"
        errorState={
          error ? (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load activity."}
            </p>
          ) : undefined
        }
        renderHeader={({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-sm">{row.sku}</p>
            <p className="text-xs text-muted-foreground">
              {new Date(row.createdAt).toLocaleString()}
            </p>
          </div>
        )}
        renderExceptionZone={({ row }) => (
          <div className="flex flex-wrap items-center gap-2">
            <DeltaBadge delta={row.delta} />
            <Badge variant="secondary" className="text-xs font-normal">
              {row.sourceLabel}
            </Badge>
          </div>
        )}
        renderBody={({ row }) => (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <ActivityMetric
              label="Before -> After"
              value={
                row.previousQuantity != null && row.newQuantity != null
                  ? `${row.previousQuantity} -> ${row.newQuantity}`
                  : "—"
              }
              mono
            />
            <ActivityMetric label="Reference" value={row.referenceId ?? "—"} />
            <ActivityMetric label="Entry ID" value={row.id} mono />
          </div>
        )}
        emptyState={
          <EmptyState
            icon={Minus}
            title="No activity found"
            description="Try adjusting SKU, source, or date filters."
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
    </PageShell>
  );
}

function DeltaBadge({ delta }: { delta: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-mono font-semibold ${
        delta > 0
          ? "text-green-600 border-green-200 bg-green-50"
          : delta < 0
            ? "text-red-600 border-red-200 bg-red-50"
            : "text-muted-foreground border-border bg-muted/40"
      }`}
    >
      {delta > 0 ? (
        <ArrowUp className="h-3 w-3" />
      ) : delta < 0 ? (
        <ArrowDown className="h-3 w-3" />
      ) : (
        <Minus className="h-3 w-3" />
      )}
      {delta > 0 ? `+${delta}` : delta}
    </span>
  );
}

function ActivityMetric({
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
      <p className={mono ? "text-sm font-mono" : "text-sm"}>{value}</p>
    </div>
  );
}
