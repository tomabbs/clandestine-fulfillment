"use client";

import { Calendar, Disc3, Loader2, Package } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getClientReleases } from "@/actions/catalog";
import {
  DEFAULT_PAGE_SIZE,
  type PageSize,
  PaginationBar,
} from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreferenceSplit } from "@/lib/hooks/use-list-pagination-preference";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ReleaseVariant = {
  id: string;
  sku: string;
  title: string | null;
  street_date: string | null;
  is_preorder: boolean;
  warehouse_products: {
    id: string;
    title: string;
    status: string;
    org_id: string;
    warehouse_product_images: Array<{
      id: string;
      src: string;
      alt: string | null;
      position: number;
    }>;
  };
  warehouse_inventory_levels: Array<{
    available: number;
    committed: number;
    incoming: number;
  }>;
};

function formatDateUTC(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function VariantThumbnail({ variant }: { variant: ReleaseVariant }) {
  const images = variant.warehouse_products?.warehouse_product_images ?? [];
  const primary = [...images].sort((a, b) => a.position - b.position)[0];
  if (primary) {
    return (
      <Image
        src={primary.src}
        alt={primary.alt ?? variant.warehouse_products.title}
        width={32}
        height={32}
        className="h-8 w-8 rounded object-cover"
      />
    );
  }
  return (
    <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
      <Package className="text-muted-foreground h-4 w-4" />
    </div>
  );
}

export default function CatalogPage() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  useListPaginationPreferenceSplit("portal/catalog", page, pageSize, setPage, setPageSize);

  const { data, isLoading, error } = useAppQuery({
    queryKey: [...queryKeys.clientReleases.list(), page, pageSize],
    queryFn: () => getClientReleases({ page, pageSize }),
    tier: CACHE_TIERS.SESSION,
  });

  useEffect(() => {
    setHydrated(true);
  }, []);

  const preorders = (data?.preorders ?? []) as unknown as ReleaseVariant[];
  const newReleases = (data?.newReleases ?? []) as unknown as ReleaseVariant[];
  const catalog = (data?.catalog ?? []) as unknown as ReleaseVariant[];
  const total = data?.total ?? 0;

  if (!hydrated || isLoading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load catalog."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" /> Upcoming Pre-Orders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{preorders.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Disc3 className="h-3.5 w-3.5" /> Recent Releases (30d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{newReleases.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Pre-orders callout — only shown when there are preorders */}
      {preorders.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Upcoming Pre-Orders</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12" />
                <TableHead>Title</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Street Date</TableHead>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Incoming</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preorders.map((v) => {
                const inv = v.warehouse_inventory_levels?.[0];
                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      <VariantThumbnail variant={v} />
                    </TableCell>
                    <TableCell className="font-medium">
                      {v.warehouse_products?.title ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {v.sku}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{formatDateUTC(v.street_date)}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{inv?.committed ?? 0}</TableCell>
                    <TableCell className="text-right font-mono">{inv?.incoming ?? 0}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Recent releases callout — only shown when there are recent releases */}
      {newReleases.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Recent Releases (30 days)</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12" />
                <TableHead>Title</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Release Date</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Committed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newReleases.map((v) => {
                const inv = v.warehouse_inventory_levels?.[0];
                return (
                  <TableRow key={v.id}>
                    <TableCell>
                      <VariantThumbnail variant={v} />
                    </TableCell>
                    <TableCell className="font-medium">
                      {v.warehouse_products?.title ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {v.sku}
                    </TableCell>
                    <TableCell className="text-sm">{formatDateUTC(v.street_date)}</TableCell>
                    <TableCell className="text-right font-mono">{inv?.available ?? 0}</TableCell>
                    <TableCell className="text-right font-mono">{inv?.committed ?? 0}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Full catalog — always shown, paginated */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Full Catalog</h2>
          <span className="text-sm text-muted-foreground">{total} titles</span>
        </div>

        {catalog.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4">No catalog items found.</p>
        ) : (
          <>
            {total > 0 && (
              <PaginationBar
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(s) => {
                  setPageSize(s);
                  setPage(1);
                }}
              />
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12" />
                  <TableHead>Title</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Release Date</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalog.map((v) => {
                  const inv = v.warehouse_inventory_levels?.[0];
                  const isRecent =
                    v.street_date &&
                    new Date(v.street_date) >= new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                  const productId = v.warehouse_products?.id;
                  return (
                    <TableRow
                      key={v.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => productId && router.push(`/portal/catalog/${productId}`)}
                    >
                      <TableCell>
                        <VariantThumbnail variant={v} />
                      </TableCell>
                      <TableCell className="font-medium max-w-[280px]">
                        <span className="truncate block">{v.warehouse_products?.title ?? "—"}</span>
                        <span className="flex gap-1 mt-0.5">
                          {v.is_preorder && (
                            <Badge variant="outline" className="text-xs">
                              Pre-Order
                            </Badge>
                          )}
                          {isRecent && !v.is_preorder && (
                            <Badge variant="secondary" className="text-xs">
                              New
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {v.sku}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateUTC(v.street_date)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{inv?.available ?? 0}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {total > 0 && (
              <PaginationBar
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(s) => {
                  setPageSize(s);
                  setPage(1);
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
