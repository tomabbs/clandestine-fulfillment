"use client";

import { ChevronLeft, ChevronRight, Package, Search } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getProducts } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
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

const PAGE_SIZES = [25, 50, 100] as const;

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  draft: "secondary",
  archived: "outline",
};

export default function CatalogPage() {
  const router = useRouter();
  const [filters, setFilters] = useState({
    orgId: "",
    format: "",
    status: "" as "" | "active" | "draft" | "archived",
    search: "",
    page: 1,
    pageSize: 25 as 25 | 50 | 100,
  });

  const queryFilters = {
    ...(filters.orgId && { orgId: filters.orgId }),
    ...(filters.format && { format: filters.format }),
    ...(filters.status && { status: filters.status }),
    ...(filters.search && { search: filters.search }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.catalog.list(queryFilters),
    queryFn: () => getProducts(queryFilters),
    tier: CACHE_TIERS.SESSION,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>

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
              <TableHead>Label</TableHead>
              <TableHead>Variants</TableHead>
              <TableHead>Format</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.products ?? []).map((product) => {
              const variants = (product.warehouse_product_variants ?? []) as Array<{
                id: string;
                sku: string;
                title: string | null;
                format_name: string | null;
                is_preorder: boolean;
              }>;
              const images = (product.warehouse_product_images ?? []) as Array<{
                id: string;
                src: string;
                alt: string | null;
                position: number;
              }>;
              const org = product.organizations as { id: string; name: string } | null;
              const primaryImage = images.sort((a, b) => a.position - b.position)[0];
              const formats = Array.from(
                new Set(variants.map((v) => v.format_name).filter(Boolean)),
              );

              return (
                <TableRow
                  key={product.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/admin/catalog/${product.id}`)}
                >
                  <TableCell>
                    {primaryImage ? (
                      <Image
                        src={primaryImage.src}
                        alt={primaryImage.alt ?? product.title}
                        width={32}
                        height={32}
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                        <Package className="text-muted-foreground h-4 w-4" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{product.title}</div>
                    {variants.length === 1 && (
                      <div className="text-muted-foreground text-xs">{variants[0].sku}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {org?.name ?? product.vendor ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm">{variants.length}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formats.join(", ") || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[product.status] ?? "outline"}>
                      {product.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {product.updated_at ? new Date(product.updated_at).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {(data?.products ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
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
