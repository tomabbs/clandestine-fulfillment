"use client";

import { BarChart3, DollarSign, Package, TrendingUp } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { getOrganizations } from "@/actions/organizations";
import { getTopSellers, getTopSellersSummary } from "@/actions/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        <div className="grid grid-cols-3 gap-4">
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

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={`skel-${i.toString()}`} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead className="w-12" />
              <TableHead>Product</TableHead>
              <TableHead>Artist / Label</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Qty Sold</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(sellers ?? []).map((seller) => (
              <TableRow key={`${seller.sku}-${seller.rank}`}>
                <TableCell className="font-mono text-muted-foreground text-sm">
                  {seller.rank}
                </TableCell>
                <TableCell>
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
                </TableCell>
                <TableCell>
                  <div className="font-medium leading-tight">{seller.productTitle}</div>
                  {seller.variantTitle && seller.variantTitle !== "Default Title" && (
                    <div className="text-muted-foreground text-xs">{seller.variantTitle}</div>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  <div>{seller.vendor ?? "—"}</div>
                  {seller.orgName && seller.orgName !== seller.vendor && (
                    <div className="text-muted-foreground text-xs">{seller.orgName}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {seller.sku}
                </TableCell>
                <TableCell className="text-right font-medium">{seller.qtySold}</TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {seller.price != null ? formatCurrency(seller.price) : "—"}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(seller.revenue)}
                </TableCell>
              </TableRow>
            ))}
            {(sellers ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No sales data available.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
