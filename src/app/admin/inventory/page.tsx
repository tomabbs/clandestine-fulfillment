"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Minus, Package, Plus } from "lucide-react";
import { useCallback, useState } from "react";
import {
  adjustInventory,
  getInventoryDetail,
  getInventoryLevels,
  updateInventoryBuffer,
  updateVariantFormat,
} from "@/actions/inventory";
import { EditableNumberCell, EditableSelectCell } from "@/components/shared/editable-cell";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

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
    search: "",
    page: 1,
    pageSize: 25,
  });
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [adjustDialog, setAdjustDialog] = useState<{
    sku: string;
    title: string;
  } | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const queryFilters = {
    ...(filters.orgId && { orgId: filters.orgId }),
    ...(filters.format && { format: filters.format }),
    ...(filters.status && { status: filters.status }),
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
          placeholder="Filter by org ID..."
          value={filters.orgId}
          onChange={(e) => setFilters((f) => ({ ...f, orgId: e.target.value, page: 1 }))}
          className="w-48"
        />
        <Input
          placeholder="Filter by format..."
          value={filters.format}
          onChange={(e) => setFilters((f) => ({ ...f, format: e.target.value, page: 1 }))}
          className="w-40"
        />
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
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={`skel-inv-${i.toString()}`} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12" />
                <TableHead>Product / SKU</TableHead>
                <TableHead className="hidden sm:table-cell">Label</TableHead>
                <TableHead className="text-right" title="Actual units in warehouse. Full truth.">
                  Avail
                </TableHead>
                <TableHead
                  className="hidden xl:table-cell text-right"
                  title="Units shown on Bandcamp and connected stores. Reduced by the safety buffer."
                >
                  Listed As
                </TableHead>
                <TableHead className="hidden md:table-cell text-right">Committed</TableHead>
                <TableHead className="hidden md:table-cell text-right">Incoming</TableHead>
                <TableHead
                  className="hidden xl:table-cell text-right"
                  title="Units held back from all sales channels. Default 3 covers Bandcamp's 5-min sync window."
                >
                  Buffer
                </TableHead>
                <TableHead className="hidden lg:table-cell">Format</TableHead>
                <TableHead className="w-20" />
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
                    <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
                      {row.orgName ?? "—"}
                    </TableCell>
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
                    {/* Listed As = what channels actually see (buffered quantity) */}
                    <TableCell className="hidden xl:table-cell text-right font-mono text-muted-foreground">
                      {Math.max(
                        0,
                        row.available - ((row as { safetyStock?: number | null }).safetyStock ?? 3),
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-right font-mono">
                      {row.committed}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-right font-mono">
                      {row.incoming}
                    </TableCell>
                    {/* Buffer — inline editable; null = uses workspace default (3) */}
                    <EditableNumberCell
                      value={(row as { safetyStock?: number | null }).safetyStock ?? 3}
                      prefix=""
                      placeholder="3"
                      precision={0}
                      className="hidden xl:table-cell text-right font-mono text-muted-foreground"
                      onSave={async (newValue) => {
                        const val = newValue ?? null;
                        await updateInventoryBuffer(row.sku, val === 3 ? null : val);
                        invalidateInventory();
                      }}
                    />
                    <EditableSelectCell
                      value={row.formatName ?? ""}
                      options={FORMAT_OPTIONS}
                      className="hidden lg:table-cell text-sm"
                      onSave={async (newValue) => {
                        await updateVariantFormat(row.variantId, newValue);
                        invalidateInventory();
                      }}
                    />
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAdjustDialog({ sku: row.sku, title: row.productTitle });
                        }}
                      >
                        Adjust
                      </Button>
                    </TableCell>
                  </TableRow>

                  {/* Expanded detail */}
                  {expandedSku === row.sku && (
                    <TableRow key={`${row.variantId}-detail`}>
                      <TableCell colSpan={8} className="bg-muted/30 p-4">
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
                  <TableCell colSpan={8} className="text-muted-foreground py-8 text-center">
                    No inventory found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
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
    </div>
  );
}
