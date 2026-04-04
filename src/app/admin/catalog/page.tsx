"use client";

import { AlertTriangle, Layers, Package, Search } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  getCatalogStats,
  getProducts,
  updateProductField,
  updateVariantField,
} from "@/actions/catalog";
import {
  EditableNumberCell,
  EditableSelectCell,
  EditableTextCell,
} from "@/components/shared/editable-cell";
import { PaginationBar } from "@/components/shared/pagination-bar";
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

// PAGE_SIZES provided by PaginationBar

const _STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800 border-green-200",
  draft: "bg-yellow-100 text-yellow-800 border-yellow-200",
  archived: "bg-gray-100 text-gray-600 border-gray-200",
};

const STATUS_OPTIONS = [
  { value: "active", label: "Active", className: "text-green-700 dark:text-green-400" },
  { value: "draft", label: "Draft", className: "text-yellow-700 dark:text-yellow-400" },
  { value: "archived", label: "Archived", className: "text-muted-foreground" },
];

function _formatCurrency(val: number | null): string {
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
        <div className="overflow-x-auto min-w-0 border rounded-lg">
          <Table className="min-w-[800px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead className="min-w-[180px] max-w-[300px]">Title</TableHead>
                <TableHead className="hidden md:table-cell w-[130px]">Vendor</TableHead>
                <TableHead className="w-28">SKU</TableHead>
                <TableHead className="hidden lg:table-cell text-right w-20">Cost</TableHead>
                <TableHead className="text-right w-20">Price</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="hidden md:table-cell w-20">Format</TableHead>
                <TableHead className="text-right w-16">Inv</TableHead>
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
                const _org = product.organizations as { id: string; name: string } | null;
                const primaryImage = images.sort((a, b) => a.position - b.position)[0];
                const imagesJson = product.images as Array<{ src: string }> | null;
                const thumbSrc = primaryImage?.src ?? imagesJson?.[0]?.src;

                const firstVarId = product.firstVariantId as string | null;

                return (
                  <TableRow
                    key={product.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/admin/catalog/${product.id}`)}
                  >
                    <TableCell className="w-10 p-2">
                      {thumbSrc ? (
                        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded">
                          <Image
                            src={thumbSrc}
                            alt={primaryImage?.alt ?? product.title}
                            fill
                            sizes="40px"
                            className="object-cover"
                          />
                        </div>
                      ) : (
                        <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded">
                          <Package className="text-muted-foreground h-5 w-5" />
                        </div>
                      )}
                    </TableCell>
                    <EditableTextCell
                      value={product.title}
                      onSave={async (v) => {
                        await updateProductField(product.id, "title", v);
                      }}
                      className="max-w-[300px] font-medium"
                    />
                    <EditableTextCell
                      value={product.vendor}
                      onSave={async (v) => {
                        await updateProductField(product.id, "vendor", v);
                      }}
                      className="hidden md:table-cell text-sm"
                    />
                    <EditableTextCell
                      value={product.firstVariantSku}
                      onSave={async (v) => {
                        if (firstVarId) await updateVariantField(firstVarId, "sku", v);
                      }}
                      className="font-mono text-xs"
                    />
                    <EditableNumberCell
                      value={product.firstVariantCost}
                      onSave={async (v) => {
                        if (firstVarId) await updateVariantField(firstVarId, "cost", v);
                      }}
                      className="hidden lg:table-cell"
                    />
                    <EditableNumberCell
                      value={product.firstVariantPrice}
                      onSave={async (v) => {
                        if (firstVarId) await updateVariantField(firstVarId, "price", v);
                      }}
                    />
                    <EditableSelectCell
                      value={product.status}
                      options={STATUS_OPTIONS}
                      onSave={async (v) => {
                        await updateProductField(product.id, "status", v);
                      }}
                    />
                    <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
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
        </div>
      )}

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
