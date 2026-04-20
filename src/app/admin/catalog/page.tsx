"use client";

import { AlertTriangle, Layers, Package, Search } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  getCatalogStats,
  getProducts,
  updateProductField,
  updateVariantField,
} from "@/actions/catalog";
import { BlockList } from "@/components/shared/block-list";
import {
  EditableNumberCell,
  EditableSelectCell,
  EditableTextCell,
} from "@/components/shared/editable-cell";
import { EmptyState } from "@/components/shared/empty-state";
import { DEFAULT_PAGE_SIZE, PaginationBar } from "@/components/shared/pagination-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { useListPaginationPreference } from "@/lib/hooks/use-list-pagination-preference";
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
    pageSize: DEFAULT_PAGE_SIZE,
  });

  useListPaginationPreference("admin/catalog", filters, setFilters);

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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

      {/* Catalog rows */}
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
        items={data?.products ?? []}
        itemKey={(product) => product.id}
        loading={isLoading}
        density="ops"
        ariaLabel="Catalog products"
        renderHeader={({ row: product }) => {
          const images = (product.warehouse_product_images ?? []) as Array<{
            id: string;
            src: string;
            alt: string | null;
            position: number;
          }>;
          const primaryImage = [...images].sort((a, b) => a.position - b.position)[0];
          const imagesJson = product.images as Array<{ src: string }> | null;
          const thumbSrc = primaryImage?.src ?? imagesJson?.[0]?.src;
          return (
            <div className="min-w-0 flex items-start gap-3">
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
              <EditableTextCell
                as="div"
                value={product.title}
                onSave={async (v) => {
                  await updateProductField(product.id, "title", v);
                }}
                className="max-w-[360px] font-medium"
              />
            </div>
          );
        }}
        renderExceptionZone={({ row: product }) => (
          <div className="flex flex-wrap items-center gap-2">
            <EditableSelectCell
              as="div"
              value={product.status}
              options={STATUS_OPTIONS}
              onSave={async (v) => {
                await updateProductField(product.id, "status", v);
              }}
            />
            <Badge variant="outline">Inventory: {product.inventoryTotal}</Badge>
            <Badge variant="outline">Format: {product.product_type ?? "—"}</Badge>
          </div>
        )}
        renderBody={({ row: product }) => {
          const firstVarId = product.firstVariantId as string | null;
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
              <CatalogField label="Vendor">
                <EditableTextCell
                  as="div"
                  value={product.vendor}
                  onSave={async (v) => {
                    await updateProductField(product.id, "vendor", v);
                  }}
                  className="text-sm"
                />
              </CatalogField>
              <CatalogField label="SKU">
                <EditableTextCell
                  as="div"
                  value={product.firstVariantSku}
                  onSave={async (v) => {
                    if (firstVarId) await updateVariantField(firstVarId, "sku", v);
                  }}
                  className="font-mono text-xs"
                />
              </CatalogField>
              <CatalogField label="Cost">
                <EditableNumberCell
                  as="div"
                  value={product.firstVariantCost}
                  onSave={async (v) => {
                    if (firstVarId) await updateVariantField(firstVarId, "cost", v);
                  }}
                />
              </CatalogField>
              <CatalogField label="Price">
                <EditableNumberCell
                  as="div"
                  value={product.firstVariantPrice}
                  onSave={async (v) => {
                    if (firstVarId) await updateVariantField(firstVarId, "price", v);
                  }}
                />
              </CatalogField>
              <CatalogField label="Open detail">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push(`/admin/catalog/${product.id}`)}
                >
                  Open
                </Button>
              </CatalogField>
            </div>
          );
        }}
        emptyState={<EmptyState icon={Package} title="No products found" />}
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

function CatalogField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border bg-background/60 p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{label}</p>
      {children}
    </div>
  );
}
