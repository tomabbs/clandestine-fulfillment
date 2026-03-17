"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Minus, Package, Plus } from "lucide-react";
import { useState } from "react";
import { getInventoryDetail, getInventoryLevels } from "@/actions/inventory";
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
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const PAGE_SIZES = [10, 25, 50, 100];

export default function InventoryPage() {
  const [filters, setFilters] = useState({
    format: "",
    search: "",
    page: 1,
    pageSize: 25,
  });
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const queryFilters = {
    ...(filters.format && { format: filters.format }),
    ...(filters.search && { search: filters.search }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  // RLS filters to own org automatically via Supabase auth
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.inventory.list({ ...queryFilters, portal: true }),
    queryFn: () => getInventoryLevels(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.inventory.detail(expandedSku ?? ""),
    queryFn: () => getInventoryDetail(expandedSku ?? ""),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!expandedSku,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>

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

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={`skel-inv-${i.toString()}`} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>Product / SKU</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Committed</TableHead>
              <TableHead className="text-right">Incoming</TableHead>
              <TableHead>Format</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.rows.map((row) => (
              <>
                <TableRow
                  key={row.variantId}
                  className="cursor-pointer"
                  onClick={() => setExpandedSku((prev) => (prev === row.sku ? null : row.sku))}
                >
                  <TableCell>
                    {row.imageSrc ? (
                      // biome-ignore lint/performance/noImgElement: external Shopify CDN URLs — next/image optimization not applicable
                      <img
                        src={row.imageSrc}
                        alt={row.productTitle}
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                        <Package className="text-muted-foreground h-4 w-4" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{row.productTitle}</div>
                    <div className="text-muted-foreground text-xs">{row.sku}</div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{row.available}</TableCell>
                  <TableCell className="text-right font-mono">{row.committed}</TableCell>
                  <TableCell className="text-right font-mono">{row.incoming}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {row.formatName ?? "—"}
                  </TableCell>
                </TableRow>

                {/* Expanded detail */}
                {expandedSku === row.sku && (
                  <TableRow key={`${row.variantId}-detail`}>
                    <TableCell colSpan={6} className="bg-muted/30 p-4">
                      {detailLoading ? (
                        <Skeleton className="h-24 w-full" />
                      ) : detail ? (
                        <div className="grid grid-cols-2 gap-6">
                          {/* Locations */}
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
                                      <span className="text-muted-foreground">
                                        ({loc.locationType})
                                      </span>
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

                          {/* Recent Activity */}
                          <div>
                            <h4 className="mb-2 text-sm font-semibold">Recent Activity</h4>
                            {detail.recentActivity.length === 0 ? (
                              <p className="text-muted-foreground text-sm">No activity yet</p>
                            ) : (
                              <ul className="space-y-1 text-sm">
                                {detail.recentActivity.slice(0, 10).map((a) => (
                                  <li key={a.id} className="flex items-center justify-between">
                                    <span className="flex items-center gap-1">
                                      {a.delta > 0 ? (
                                        <Plus className="h-3 w-3 text-green-600" />
                                      ) : (
                                        <Minus className="h-3 w-3 text-red-600" />
                                      )}
                                      <span className="font-mono">
                                        {a.delta > 0 ? `+${a.delta}` : a.delta}
                                      </span>
                                      <span className="text-muted-foreground">{a.source}</span>
                                    </span>
                                    <span className="text-muted-foreground text-xs">
                                      {new Date(a.createdAt).toLocaleDateString()}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {data?.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  No inventory found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {/* Pagination */}
      {data && data.total > 0 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <span>Rows per page:</span>
            <select
              value={filters.pageSize}
              onChange={(e) =>
                setFilters((f) => ({ ...f, pageSize: Number(e.target.value), page: 1 }))
              }
              className="border-input bg-background rounded border px-2 py-1 text-sm"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span>
              {(data.page - 1) * data.pageSize + 1}–
              {Math.min(data.page * data.pageSize, data.total)} of {data.total}
            </span>
          </div>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page >= totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
