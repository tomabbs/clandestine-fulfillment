"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  type ListClientStockExceptionsResult,
  listClientStockExceptions,
} from "@/actions/portal-stock-exceptions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// Phase 6 Slice 6.F — client surface for /portal/stock-exceptions.
// Reads the `listClientStockExceptions` Server Action (which is
// org-scoped via `requireClient()`). Presentational only: no mutations,
// no staff internals, and we deliberately avoid surfacing
// `evidence_snapshot` / `remote_fingerprint` to clients.

type PlatformFilter = "all" | "shopify" | "woocommerce" | "squarespace";

interface Filters {
  platform: PlatformFilter;
}

const DEFAULT_FILTERS: Filters = { platform: "all" };
const PAGE_SIZE = 25;

export function StockExceptionsClient({
  bootstrap,
}: {
  bootstrap: ListClientStockExceptionsResult;
}) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [offset, setOffset] = useState(0);

  const queryKey = useMemo(
    () => ["portal", "stock-exceptions", filters.platform, offset] as const,
    [filters, offset],
  );

  const query = useAppQuery<ListClientStockExceptionsResult, Error>({
    queryKey: Array.from(queryKey),
    queryFn: () =>
      listClientStockExceptions({
        platform: filters.platform === "all" ? undefined : filters.platform,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: bootstrap,
    tier: CACHE_TIERS.SESSION,
  });

  const rows = query.data?.rows ?? bootstrap.rows;
  const total = query.data?.total ?? bootstrap.total;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  const updateFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setOffset(0);
  }, []);

  return (
    <div className="max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Stock exceptions</h1>
        <p className="text-sm text-muted-foreground">
          These are items your connected stores are advertising as in-stock, but our warehouse shows
          as 0 on hand. Updating your store's listed availability will avoid oversells.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Narrow the view to a specific store platform.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <FilterSelect
              label="Platform"
              value={filters.platform}
              onChange={(v) => updateFilter("platform", v as PlatformFilter)}
              options={[
                { value: "all", label: "All platforms" },
                { value: "shopify", label: "Shopify" },
                { value: "woocommerce", label: "WooCommerce" },
                { value: "squarespace", label: "Squarespace" },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Current exceptions</CardTitle>
              <CardDescription>
                {total > 0
                  ? `Showing ${pageStart}–${pageEnd} of ${total} exception${total === 1 ? "" : "s"}.`
                  : "No stock exceptions at the moment — nice work!"}
              </CardDescription>
            </div>
            {query.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              No stock exceptions right now.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-4 font-medium">Last seen</th>
                    <th className="py-2 pr-4 font-medium">Platform</th>
                    <th className="py-2 pr-4 font-medium">Remote SKU</th>
                    <th className="py-2 pr-4 font-medium">Warehouse on-hand</th>
                    <th className="py-2 pr-4 font-medium">Store listed stock</th>
                    <th className="py-2 pr-4 font-medium">Still listed?</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-4 font-mono text-xs">
                        {new Date(row.last_evaluated_at).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-xs">{row.platform}</td>
                      <td className="py-2 pr-4 font-mono text-[11px]">
                        {row.remote_sku ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {row.warehouse_stock_at_match ?? 0}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {row.remote_stock_at_match ?? (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        {row.remote_stock_listed_at_match === null ? (
                          <span className="text-muted-foreground">unknown</span>
                        ) : row.remote_stock_listed_at_match ? (
                          <Badge variant="outline">Yes</Badge>
                        ) : (
                          <Badge variant="secondary">No</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {total > 0 ? `Page ${Math.floor(offset / PAGE_SIZE) + 1}` : "—"}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || query.isFetching}
                onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total || query.isFetching}
                onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {query.error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load exceptions: {query.error.message}
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
