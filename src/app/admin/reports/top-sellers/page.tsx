"use client";

import { BarChart3, DollarSign, Package, TrendingUp } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { getOrganizations } from "@/actions/organizations";
import { getTopSellers, getTopSellersSummary } from "@/actions/reports";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

function formatCurrency(val: number): string {
  return val.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function TopSellersPage() {
  const [orgFilter, setOrgFilter] = useState("");

  const filters = {
    ...(orgFilter && { orgId: orgFilter }),
    limit: 100 as const,
  };

  const { data: sellers, isLoading } = useAppQuery({
    queryKey: ["top-sellers", filters],
    queryFn: () => getTopSellers(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: summary } = useAppQuery({
    queryKey: ["top-sellers-summary"],
    queryFn: () => getTopSellersSummary(),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: orgs } = useAppQuery({
    queryKey: ["organizations"],
    queryFn: () => getOrganizations(),
    tier: CACHE_TIERS.SESSION,
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Top Sellers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All-time Bandcamp sales ranked by units sold
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Units Sold
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <span className="text-2xl font-semibold">
                  {summary.totalUnitsSold.toLocaleString()}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Revenue
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-2xl font-semibold">
                  {formatCurrency(summary.totalRevenue)}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Products with Sales
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <span className="text-2xl font-semibold">
                  {summary.productsWithSales.toLocaleString()}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-3">
        <select
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All Clients</option>
          {(orgs ?? []).map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      </div>

      <BlockList
        className="mt-3"
        items={sellers ?? []}
        itemKey={(seller) => `${seller.sku}-${seller.rank}`}
        loading={isLoading}
        density="ops"
        ariaLabel="Top seller rows"
        renderHeader={({ row: seller }) => (
          <div className="min-w-0 flex items-start gap-3">
            <p className="font-mono text-sm text-muted-foreground w-8">{seller.rank}</p>
            {seller.imageUrl ? (
              <Image
                src={seller.imageUrl}
                alt={seller.productTitle}
                width={32}
                height={32}
                className="h-8 w-8 rounded object-cover"
              />
            ) : (
              <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                <Package className="text-muted-foreground h-4 w-4" />
              </div>
            )}
            <div className="min-w-0">
              <p className="font-medium leading-tight">{seller.productTitle}</p>
              {seller.variantTitle && seller.variantTitle !== "Default Title" ? (
                <p className="text-xs text-muted-foreground">{seller.variantTitle}</p>
              ) : null}
            </div>
          </div>
        )}
        renderExceptionZone={({ row: seller }) => (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{seller.vendor ?? "—"}</span>
            {seller.orgName && seller.orgName !== seller.vendor ? (
              <span className="text-muted-foreground">({seller.orgName})</span>
            ) : null}
            <span className="font-mono text-xs text-muted-foreground">{seller.sku}</span>
          </div>
        )}
        renderBody={({ row: seller }) => (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <SellerMetric label="Qty sold" value={seller.qtySold.toLocaleString()} mono />
            <SellerMetric
              label="Unit price"
              value={seller.price != null ? formatCurrency(seller.price) : "—"}
            />
            <SellerMetric label="Revenue" value={formatCurrency(seller.revenue)} />
          </div>
        )}
        emptyState={
          <EmptyState
            icon={Package}
            title="No sales data available"
            description="Try a different client filter or check back after sales sync."
          />
        }
      />
    </div>
  );
}

function SellerMetric({
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
