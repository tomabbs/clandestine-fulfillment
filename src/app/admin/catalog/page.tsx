"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, Layers, Package, Search } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getCatalogStats, getProducts } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const PAGE_SIZES = [25, 50, 100] as const;

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800 border-green-200",
  draft: "bg-yellow-100 text-yellow-800 border-yellow-200",
  archived: "bg-gray-100 text-gray-600 border-gray-200",
};

function formatCurrency(val: number | null): string {
  if (val == null) return "—";
  return `$${val.toFixed(2)}`;
}

export default function CatalogPage() {
  const router = useRouter();
  const [filters, setFilters] = useState({
    orgId: "",
    format: "",
    status: "" as "" | "active" | "draft" | "archived",
    search: "",
    missingCost: false,
    page: 1,
    pageSize: 25 as 25 | 50 | 100,
  });

  const queryFilters = {
    ...(filters.orgId && { orgId: filters.orgId }),
    ...(filters.format && { format: filters.format }),
    ...(filters.status && { status: filters.status }),
    ...(filters.search && { search: filters.search }),
    ...(filters.missingCost && { missingCost: true }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.catalog.list(queryFilters),
    queryFn: () => getProducts(queryFilters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: stats } = useAppQuery({
    queryKey: ["catalog-stats"],
    queryFn: () => getCatalogStats(),
    tier: CACHE_TIERS.SESSION,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>

      {/* Stat Cards */}
      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Products
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                <span className="text-2xl font-semibold">
                  {stats.totalProducts.toLocaleString()}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Variants
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <span className="text-2xl font-semibold">
                  {stats.totalVariants.toLocaleString()}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card
            className={
              stats.missingCostCount > 0
                ? "border-red-200 cursor-pointer hover:border-red-300 transition-colors"
                : ""
            }
            onClick={
              stats.missingCostCount > 0
                ? () => setFilters((f) => ({ ...f, missingCost: !f.missingCost, page: 1 }))
                : undefined
            }
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Missing Cost
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                {stats.missingCostCount > 0 ? (
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                )}
                <span
                  className={`text-2xl font-semibold ${stats.missingCostCount > 0 ? "text-red-600" : ""}`}
                >
                  {stats.missingCostCount.toLocaleString()}
                </span>
                {filters.missingCost && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    filtered
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or SKU..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            className="pl-9"
          />
        </div>
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
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              status: e.target.value as "" | "active" | "draft" | "archived",
              page: 1,
            }))
          }
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
        {filters.missingCost && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilters((f) => ({ ...f, missingCost: false, page: 1 }))}
          >
            Clear Missing Cost Filter
          </Button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={`skel-cat-${i.toString()}`} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>Title</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Format</TableHead>
              <TableHead className="text-right">Inventory</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.products ?? []).map((product) => {
              const images = (product.warehouse_product_images ?? []) as Array<{
                id: string;
                src: string;
                alt: string | null;
                position: number;
              }>;
              const org = product.organizations as { id: string; name: string } | null;
              const primaryImage = images.sort((a, b) => a.position - b.position)[0];
              const thumbSrc = primaryImage?.src ?? product.image_url;

              return (
                <TableRow
                  key={product.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/admin/catalog/${product.id}`)}
                >
                  <TableCell>
                    {thumbSrc ? (
                      <Image
                        src={thumbSrc}
                        alt={primaryImage?.alt ?? product.title}
                        width={40}
                        height={40}
                        className="h-10 w-10 rounded object-cover"
                      />
                    ) : (
                      <div className="bg-muted flex h-10 w-10 items-center justify-center rounded">
                        <Package className="text-muted-foreground h-5 w-5" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium leading-tight">{product.title}</div>
                    <div className="text-muted-foreground text-xs">
                      {org?.name ?? product.vendor ?? ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {product.vendor ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {product.firstVariantSku ?? "—"}
                  </TableCell>
                  <TableCell
                    className={`text-right text-sm ${product.firstVariantCost == null || product.firstVariantCost === 0 ? "text-red-500" : ""}`}
                  >
                    {formatCurrency(product.firstVariantCost)}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {formatCurrency(product.firstVariantPrice)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[product.status] ?? "bg-gray-100 text-gray-600"}`}
                    >
                      {product.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {product.product_type ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm font-medium">
                    {product.inventoryTotal}
                  </TableCell>
                </TableRow>
              );
            })}
            {(data?.products ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No products found.
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
                setFilters((f) => ({
                  ...f,
                  pageSize: Number(e.target.value) as 25 | 50 | 100,
                  page: 1,
                }))
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
