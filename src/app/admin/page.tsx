"use client";

import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Calendar, Disc3, Loader2, Package, Rocket } from "lucide-react";
import { useCallback } from "react";
import { getPreorderProducts, manualRelease } from "@/actions/preorders";
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
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type PreorderVariant = Awaited<ReturnType<typeof getPreorderProducts>>["variants"][number];

export default function DashboardPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Warehouse overview</p>
      </div>
      <UpcomingReleasesCard />
    </div>
  );
}

function UpcomingReleasesCard() {
  const { data, isLoading } = useAppQuery<Awaited<ReturnType<typeof getPreorderProducts>>>({
    queryKey: queryKeys.products.list({ preorders: true }),
    queryFn: () => getPreorderProducts({ pageSize: 30 }),
    tier: CACHE_TIERS.SESSION,
  });

  const releaseMutation = useAppMutation({
    mutationFn: (variantId: string) => manualRelease(variantId),
    invalidateKeys: [queryKeys.products.all, queryKeys.orders.all],
  });

  const handleRelease = useCallback(
    (variantId: string) => releaseMutation.mutate(variantId),
    [releaseMutation],
  );

  const variants = data?.variants ?? [];

  // Split into upcoming (next 30 days) and overdue (past street date)
  const today = new Date();
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

  const upcoming = variants.filter((v) => {
    if (!v.streetDate) return false;
    const d = new Date(v.streetDate);
    return d >= today && d <= thirtyDaysOut;
  });

  const overdue = variants.filter((v) => {
    if (!v.streetDate) return false;
    return new Date(v.streetDate) < today;
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Disc3 className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle>Upcoming Releases</CardTitle>
            <CardDescription>Pre-orders with street dates in the next 30 days</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading pre-orders...
          </div>
        ) : upcoming.length === 0 && overdue.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No upcoming pre-order releases.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {overdue.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-destructive mb-2 flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4" />
                  Overdue ({overdue.length})
                </h3>
                <PreorderTable
                  variants={overdue}
                  onRelease={handleRelease}
                  isPending={releaseMutation.isPending}
                />
              </div>
            )}
            {upcoming.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  Upcoming ({upcoming.length})
                </h3>
                <PreorderTable
                  variants={upcoming}
                  onRelease={handleRelease}
                  isPending={releaseMutation.isPending}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PreorderTable({
  variants,
  onRelease,
  isPending,
}: {
  variants: PreorderVariant[];
  onRelease: (variantId: string) => void;
  isPending: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product / SKU</TableHead>
          <TableHead>Street Date</TableHead>
          <TableHead className="text-right">Pre-Orders</TableHead>
          <TableHead className="text-right">Available</TableHead>
          <TableHead className="text-right">Status</TableHead>
          <TableHead className="w-28" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {variants.map((v) => (
          <TableRow key={v.id}>
            <TableCell>
              <div className="font-medium">{v.productTitle}</div>
              <div className="text-muted-foreground text-xs font-mono">{v.sku}</div>
            </TableCell>
            <TableCell>
              {v.streetDate ? (
                <span className="text-sm">
                  {new Date(v.streetDate).toLocaleDateString()}
                  <span className="text-muted-foreground text-xs ml-1">
                    ({formatDistanceToNow(new Date(v.streetDate), { addSuffix: true })})
                  </span>
                </span>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-right font-mono">{v.orderCount}</TableCell>
            <TableCell className="text-right font-mono">{v.availableStock}</TableCell>
            <TableCell className="text-right">
              {v.isShortRisk ? (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Short
                </Badge>
              ) : (
                <Badge variant="secondary">OK</Badge>
              )}
            </TableCell>
            <TableCell>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRelease(v.id)}
                disabled={isPending}
              >
                <Rocket className="h-3 w-3 mr-1" />
                Release
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
