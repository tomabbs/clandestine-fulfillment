"use client";

import { ArrowDown, ArrowUp, Download, Minus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { exportClientInventoryActivity, getClientInventoryActivity } from "@/actions/inventory";
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
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory Activity Log</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every inventory change for your catalog — orders, shipments, manual adjustments, and
            inbound stock.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
            <Download className="h-4 w-4 mr-1" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Link
            href="/portal/inventory"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            ← Inventory
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by SKU…"
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
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load activity."}
        </p>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={`skel-act-${i.toString()}`} className="h-12 w-full" />
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
                <TableHead className="w-36">Date / Time</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right w-20">Change</TableHead>
                <TableHead className="text-right w-32 hidden md:table-cell">
                  Before → After
                </TableHead>
                <TableHead>Cause</TableHead>
                <TableHead className="hidden lg:table-cell">Reference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    <div>{new Date(row.createdAt).toLocaleDateString()}</div>
                    <div>
                      {new Date(row.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{row.sku}</TableCell>
                  <TableCell className="text-right">
                    <span
                      className={`inline-flex items-center gap-1 font-mono font-semibold ${
                        row.delta > 0
                          ? "text-green-600"
                          : row.delta < 0
                            ? "text-red-600"
                            : "text-muted-foreground"
                      }`}
                    >
                      {row.delta > 0 ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : row.delta < 0 ? (
                        <ArrowDown className="h-3 w-3" />
                      ) : (
                        <Minus className="h-3 w-3" />
                      )}
                      {row.delta > 0 ? `+${row.delta}` : row.delta}
                    </span>
                  </TableCell>
                  <TableCell className="text-right hidden md:table-cell">
                    {row.previousQuantity != null && row.newQuantity != null ? (
                      <span className="font-mono text-sm text-muted-foreground">
                        {row.previousQuantity} → {row.newQuantity}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs font-normal">
                      {row.sourceLabel}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">
                    {row.referenceId ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {data?.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground text-sm">
                    No activity found for the selected filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {data && data.total > 0 && (
            <PaginationBar
              page={filters.page}
              pageSize={filters.pageSize}
              total={data.total}
              onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
              onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
            />
          )}
        </>
      )}
    </div>
  );
}
