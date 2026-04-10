"use client";

import { AlertTriangle, CheckCircle2, Loader2, Package, RefreshCw } from "lucide-react";
import React, { useState } from "react";
import { getUserContext } from "@/actions/auth";
import {
  computeBundleAvailability,
  getBundleComponents,
  listBundles,
} from "@/actions/bundle-components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function BundlesPage() {
  const { data: ctx } = useAppQuery({
    queryKey: queryKeys.auth.userContext(),
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.SESSION,
  });

  const workspaceId = ctx?.workspaceId;

  const {
    data: bundles,
    isLoading,
    refetch,
    isFetching,
  } = useAppQuery({
    queryKey: queryKeys.bundles.list(workspaceId ?? ""),
    queryFn: () => listBundles(workspaceId ?? ""),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!workspaceId,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading || !bundles) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const available = bundles.filter((b) => b.status === "available").length;
  const low = bundles.filter((b) => b.status === "low").length;
  const unavailable = bundles.filter((b) => b.status === "unavailable").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Package className="h-6 w-6" /> Bundle Inventory
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {bundles.length} bundles | {available} available | {low} low stock | {unavailable}{" "}
            unavailable
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {bundles.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No bundles configured. Bundles are created by linking component variants to a bundle
            variant.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px]">Bundle</TableHead>
                  <TableHead className="w-[120px]">SKU</TableHead>
                  <TableHead className="text-right w-[80px]">Components</TableHead>
                  <TableHead className="text-right w-[100px]">Bundle Stock</TableHead>
                  <TableHead className="text-right w-[100px]">Effective</TableHead>
                  <TableHead className="w-[180px]">Constrained By</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bundles.map((bundle) => {
                  const isExpanded = expandedId === bundle.bundleVariantId;
                  return (
                    <React.Fragment key={bundle.bundleVariantId}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setExpandedId(isExpanded ? null : bundle.bundleVariantId)}
                      >
                        <TableCell className="font-medium">{bundle.title}</TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono">
                          {bundle.sku}
                        </TableCell>
                        <TableCell className="text-right">{bundle.componentCount}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {bundle.bundleStock}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {bundle.effectiveAvailable}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {bundle.constrainedBy ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              bundle.status === "available"
                                ? "default"
                                : bundle.status === "low"
                                  ? "secondary"
                                  : "destructive"
                            }
                            className="text-xs"
                          >
                            {bundle.status === "available" && (
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                            )}
                            {bundle.status === "unavailable" && (
                              <AlertTriangle className="h-3 w-3 mr-1" />
                            )}
                            {bundle.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <tr>
                          <td colSpan={7} className="p-0">
                            <BundleComponentDetail bundleVariantId={bundle.bundleVariantId} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BundleComponentDetail({ bundleVariantId }: { bundleVariantId: string }) {
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.bundles.detail(bundleVariantId),
    queryFn: () => getBundleComponents(bundleVariantId),
    tier: CACHE_TIERS.REALTIME,
  });

  if (isLoading) {
    return (
      <div className="p-4 text-center">
        <Loader2 className="h-4 w-4 animate-spin inline" />
      </div>
    );
  }

  if (!data?.length) {
    return <div className="p-4 text-sm text-muted-foreground">No components found</div>;
  }

  return (
    <div className="bg-muted/30 p-4">
      <p className="text-xs font-medium text-muted-foreground mb-2">Components</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Component</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead className="text-right">Qty per Bundle</TableHead>
            <TableHead className="text-right">Available</TableHead>
            <TableHead className="text-right">Contribution</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((comp: Record<string, unknown>) => {
            const variant = comp.warehouse_product_variants as Record<string, unknown> | null;
            const levels = (variant as Record<string, unknown>)
              ?.warehouse_inventory_levels as Record<string, unknown> | null;
            const available = (levels?.available as number) ?? 0;
            const qty = comp.quantity as number;
            const contribution = Math.floor(available / qty);
            const product = (variant as Record<string, unknown>)?.warehouse_products as Record<
              string,
              unknown
            > | null;

            return (
              <TableRow key={comp.id as string}>
                <TableCell className="text-sm">
                  {(product?.title as string) ?? (variant?.title as string) ?? "—"}
                </TableCell>
                <TableCell className="text-xs font-mono text-muted-foreground">
                  {(variant?.sku as string) ?? "—"}
                </TableCell>
                <TableCell className="text-right">{qty}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <span className={available <= 0 ? "text-destructive font-medium" : ""}>
                    {available}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{contribution}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
